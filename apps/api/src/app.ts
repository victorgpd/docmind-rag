import cookieParser from 'cookie-parser';
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import express from 'express';
import helmet from 'helmet';
import pino from 'pino';
import { Metrics, consoleExporter, observability, requestLogging } from '@docmind/observability';
import { sql } from '@docmind/db';
import { API_PREFIX, HealthResponse } from '@docmind/shared';
import type { Config } from '@docmind/config';
import type { DbHandle } from '@docmind/db';
import type { LLMProvider } from '@docmind/llm';
import type { Queue } from '@docmind/queue';
import type { Storage } from '@docmind/storage';
import { identify } from './http/auth';
import { errorHandler, notFound } from './http/errors';
import { createRateLimiter, rateLimit } from './http/middleware';
import { mountRoutes } from './routes';

/** Dependencias injetadas; cada dominio e um Router `xxxRouter(deps)` registrado em routes/index.ts. */
export type Deps = { config: Config; db: DbHandle; llm: LLMProvider; queue: Queue; storage: Storage; /** Destino dos logs (padrao stdout); so os testes injetam. */ logStream?: { write(msg: string): void } };

export function buildApp(deps: Deps) {
  const app = express();
  app.disable('x-powered-by');
  const tp = deps.config.TRUST_PROXY?.trim();
  app.set('trust proxy', !tp || tp === 'false' ? false : tp === 'true' ? true : /^\d+$/.test(tp) ? Number(tp) : tp);
  // IP do cliente por header dedicado (ex.: cf-connecting-ip, que a Cloudflare sobrescreve): so vale se o salto direto e confiavel por TRUST_PROXY,
  // senao qualquer um forjaria o header. Com 'true' todo salto seria confiavel, por isso exigimos CIDRs ou numero de saltos.
  const ipHeader = deps.config.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (ipHeader) {
    if (!tp || tp === 'false' || tp === 'true') throw new Error("CLIENT_IP_HEADER requires TRUST_PROXY as CIDRs or a hop count (not empty/'true')");
    const trusted = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    app.use((req, _res, next) => {
      const v = req.headers[ipHeader];
      if (typeof v === 'string' && isIP(v.trim()) && trusted(req.socket.remoteAddress ?? '', 0)) Object.defineProperty(req, 'ip', { value: v.trim(), configurable: true });
      next();
    });
  }
  // acessiveis em middlewares via req.app.locals (nao importe o app dentro de rotas)
  Object.assign(app.locals, {
    deps,
    jwtSecret: deps.config.JWT_SECRET,
    log: pino({ level: deps.config.NODE_ENV === 'test' ? 'silent' : 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] }, deps.logStream),
    metrics: new Metrics(),
    limiter: createRateLimiter(deps.config.REDIS_URL),
    closing: false,
  });
  if (deps.config.NODE_ENV === 'production' && deps.config.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be set (32+ chars) in production');

  // um unico logger por requisicao (req.id/req.log, x-request-id) e as metricas/spans do pacote; /metrics e protegido abaixo, entao a rota do pacote fica desligada
  const logLevel = deps.config.NODE_ENV === 'test' ? 'silent' : 'info';
  app.use(requestLogging({ level: logLevel, stream: deps.logStream }));
  app.use(observability({ metrics: app.locals.metrics, metricsRoute: '', exporter: deps.config.NODE_ENV === 'development' ? consoleExporter() : undefined }));
  // API JSON: nada deve ser renderizado nem embutido em frames
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  const origins = new Set(deps.config.CORS_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean));
  if (origins.has('*')) throw new Error("CORS_ORIGINS must list explicit origins, not '*' (cookies need credentials)");
  // sem header Origin (mesma origem, curl, proxy do web) passa; origin fora da lista simplesmente nao recebe os headers CORS
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || origins.has(origin)), credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE'], maxAge: 600 }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(identify);
  // Limite global em dois grupos independentes (contadores separados): leituras e escritas/uploads/chat. /auth tem o seu proprio.
  // Streams SSE contam uma vez, na abertura (a middleware roda por requisicao, nao por evento). Sondas de saude nao contam.
  // Nos testes fica desligado, salvo se configurado explicitamente.
  const { RATE_LIMIT_READ: readMax, RATE_LIMIT_WRITE: writeMax } = deps.config;
  if (deps.config.NODE_ENV !== 'test' || readMax || writeMax) {
    const group = (limit: number) => ({ user: { limit, windowMs: 60_000 }, org: { limit: limit * 5, windowMs: 60_000 } });
    const reads = rateLimit(app.locals.limiter, group(readMax ?? 300), 'api-read');
    const writes = rateLimit(app.locals.limiter, group(writeMax ?? 60), 'api-write');
    const exempt = new Set([`${API_PREFIX}/health`, `${API_PREFIX}/ready`, '/metrics']);
    app.use((req, res, next) => (exempt.has(req.path) ? next() : (['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? reads : writes)(req, res, next)));
  }

  app.get(`${API_PREFIX}/health`, (_req, res) =>
    res.json(
      HealthResponse.parse({ status: 'ok', version: '0.0.0', db: deps.db.kind, queue: deps.config.REDIS_URL ? 'bullmq' : 'memory', llm: deps.llm.name }),
    ),
  );
  // readiness: dependencias que a API precisa para atender (healthcheck do compose). Em shutdown responde 503 para o balanceador drenar.
  // Requisicao com X-Forwarded-For passou pelo proxy do web (rewrite do Next): e publica, entao /ready some (404). Sondas internas nao tem o header.
  app.get(`${API_PREFIX}/ready`, async (req, res, next) => {
    if (req.headers['x-forwarded-for']) return next();
    const probe = (fn: () => Promise<unknown>) =>
      Promise.race([fn().then(() => 'ok' as const), new Promise<'fail'>((r) => setTimeout(r, 2000, 'fail'))]).catch(() => 'fail' as const);
    const checks = {
      db: await probe(() => deps.db.db.execute(sql`select 1`)),
      redis: deps.queue.ping ? await probe(() => deps.queue.ping!()) : ('skipped' as const),
    };
    const ready = !app.locals.closing && checks.db === 'ok' && checks.redis !== 'fail';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
  });
  app.get('/metrics', (req, res) => {
    const token = deps.config.METRICS_TOKEN;
    const given = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const ok = token
      ? given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token))
      : ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? ''); // sem token: so loopback (com TRUST_PROXY, o IP do cliente real)
    if (!ok) return void res.status(token ? 401 : 403).json({ error: { code: token ? 'unauthorized' : 'forbidden', message: 'Metrics are restricted' } });
    res.json(app.locals.metrics.snapshot());
  });

  mountRoutes(app, deps);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
