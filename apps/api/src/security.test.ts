import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import express from 'express';
import { buildApp } from './app';
import { createRateLimiter, rateLimit } from './http/middleware';
import { openSse } from './http/sse';

let db: DbHandle;
const build = (env: Record<string, string> = {}) =>
  buildApp({ config: loadConfig({ NODE_ENV: 'test', ...env }), db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
}, 60000);
afterAll(() => db.close());

const login = (app: ReturnType<typeof build>, email: string, password = 'senha-forte-1', ip?: string) =>
  request(app).post('/api/v1/auth/login').set(ip ? { 'X-Forwarded-For': ip } : {}).send({ email, password });

it('helmet: CSP restritiva e sem x-powered-by', async () => {
  const r = await request(build()).get('/api/v1/health');
  expect(r.headers['content-security-policy']).toContain("default-src 'none'");
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  expect(r.headers['x-powered-by']).toBeUndefined();
});

it('TRUST_PROXY: desligado ignora X-Forwarded-For; ligado limita por IP do cliente', async () => {
  const off = build({ AUTH_RATE_LIMIT: '2' });
  const offCodes = [];
  for (let i = 0; i < 3; i++) offCodes.push((await login(off, `o${i}@x.com`, 'errada-123', `203.0.113.${i}`)).status);
  expect(offCodes).toEqual([401, 401, 429]); // cabecalho forjado nao escapa do limite

  const on = build({ AUTH_RATE_LIMIT: '2', TRUST_PROXY: 'true' });
  const onCodes = [];
  for (let i = 0; i < 3; i++) onCodes.push((await login(on, `p${i}@x.com`, 'errada-123', `203.0.113.${i}`)).status);
  expect(onCodes).toEqual([401, 401, 401]); // clientes distintos atras do proxy
});

it('/metrics: loopback sem token; com METRICS_TOKEN exige bearer; cliente externo sem token e barrado', async () => {
  expect((await request(build()).get('/metrics')).status).toBe(200);

  const external = build({ TRUST_PROXY: 'true' });
  expect((await request(external).get('/metrics').set('X-Forwarded-For', '203.0.113.9')).status).toBe(403);

  const guarded = build({ METRICS_TOKEN: 'um-token-com-16-chars!' });
  expect((await request(guarded).get('/metrics')).status).toBe(401);
  expect((await request(guarded).get('/metrics').set('Authorization', 'Bearer errado-errado-errado-')).status).toBe(401);
  expect((await request(guarded).get('/metrics').set('Authorization', 'Bearer um-token-com-16-chars!')).status).toBe(200);
});

it('limite por e-mail e por IP+e-mail: atacante de outro IP nao trava o login da vitima', async () => {
  const app = build({ AUTH_RATE_LIMIT: '4', TRUST_PROXY: 'true' }); // por e-mail+IP: 2
  const reg = await request(app).post('/api/v1/auth/register').set('X-Forwarded-For', '198.51.100.1').send({ email: 'vitima@x.com', password: 'senha-forte-1', name: 'V', organizationName: 'V' });
  expect(reg.status).toBe(201);
  for (let i = 0; i < 2; i++) await login(app, 'vitima@x.com', 'errada-123', '203.0.113.50');
  expect((await login(app, 'vitima@x.com', 'errada-123', '203.0.113.50')).status).toBe(429); // atacante barrado
  expect((await login(app, 'vitima@x.com', 'senha-forte-1', '198.51.100.7')).status).toBe(200); // vitima segue entrando
});

it('JWT: so HS256 com issuer/audience do DocMind', async () => {
  const app = build();
  const secret = 'dev-only-change-me';
  const claims = { userId: crypto.randomUUID(), orgId: crypto.randomUUID(), role: 'admin' };
  const get = (t: string) => request(app).get('/api/v1/collections').set('Authorization', `Bearer ${t}`);
  // valido na assinatura, mas sem issuer/audience, ou com algoritmo diferente, ou "none"
  expect((await get(jwt.sign(claims, secret))).status).toBe(401);
  expect((await get(jwt.sign(claims, secret, { issuer: 'docmind', audience: 'outro' }))).status).toBe(401);
  expect((await get(jwt.sign(claims, secret, { issuer: 'docmind', audience: 'docmind-api', algorithm: 'HS512' }))).status).toBe(401);
  expect((await get(jwt.sign(claims, '', { issuer: 'docmind', audience: 'docmind-api', algorithm: 'none' }))).status).toBe(401);
});

it('limite global em grupos: leituras, escritas/chat e SSE contado so na abertura; /auth e saude a parte', async () => {
  const app = build({ RATE_LIMIT_READ: '6', RATE_LIMIT_WRITE: '2', AUTH_RATE_LIMIT: '1000' });
  const reg = async (email: string) =>
    (await request(app).post('/api/v1/auth/register').send({ email, password: 'senha-forte-1', name: 'U', organizationName: email })).body.token as string;
  const [a, b] = [await reg('g1@x.com'), await reg('g2@x.com')];
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const codes = async (n: number, fn: () => Promise<{ status: number }>) => Promise.all(Array.from({ length: n }, () => fn())).then((r) => r.map((x) => x.status));

  // leituras: teto proprio (6), bem acima das escritas (2)
  const reads = await codes(7, () => request(app).get('/api/v1/collections').set(auth(a)));
  expect(reads.filter((s) => s === 200)).toHaveLength(6);
  expect(reads.filter((s) => s === 429)).toHaveLength(1);

  // escritas tem contador separado: o usuario ja esgotou as leituras e ainda pode escrever 2 vezes
  const writes = await codes(3, () => request(app).post('/api/v1/collections').set(auth(a)).send({ name: 'x' }));
  expect(writes.sort()).toEqual([201, 201, 429]);
  const blocked = await request(app).post('/api/v1/collections').set(auth(a)).send({ name: 'x' });
  expect(blocked.headers['retry-after']).toBeDefined();
  expect(blocked.body.error.code).toBe('rate_limited');

  // outro usuario (outra org) nao e afetado; health/ready/metrics nao contam
  expect((await request(app).get('/api/v1/collections').set(auth(b))).status).toBe(200);
  for (let i = 0; i < 10; i++) expect((await request(app).get('/api/v1/health')).status).toBe(200);

  // SSE: abrir conta 1 na janela de leitura; os eventos do stream nao contam
  const sse = express();
  sse.use(rateLimit(createRateLimiter(), { user: { limit: 2, windowMs: 60_000 } }, 'sse'));
  sse.get('/events', (_req, res) => {
    const s = openSse(res);
    for (let i = 0; i < 20; i++) s.send('tick', { i });
    s.end();
  });
  const opens = [] as number[];
  for (let i = 0; i < 3; i++) {
    const r = await request(sse).get('/events').buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => cb(null, d)); });
    opens.push(r.status);
    if (r.status === 200) expect((r.body as string).match(/event: tick/g)).toHaveLength(20);
  }
  expect(opens).toEqual([200, 200, 429]);
});

it('x-request-id: ecoa o recebido ou gera um novo', async () => {
  const app = build();
  expect((await request(app).get('/api/v1/health').set('X-Request-Id', 'abc-123')).headers['x-request-id']).toBe('abc-123');
  expect((await request(app).get('/api/v1/health')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});
