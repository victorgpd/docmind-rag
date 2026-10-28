import { Router, type RequestHandler } from 'express';
import { Metrics } from './metrics.js';
import { Tracer, noopExporter, type SpanExporter } from './tracing.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tracer: Tracer;
      metrics: Metrics;
    }
  }
}

export type ObservabilityOptions = {
  exporter?: SpanExporter;
  /** Rota das metricas (JSON). String vazia desliga. Padrao: /metrics */
  metricsRoute?: string;
  /** Instancia propria, para usar `metrics` fora de uma requisicao (ex.: worker). */
  metrics?: Metrics;
};

/** `app.use(observability())`: expoe req.tracer/req.metrics, mede a latencia `http` e serve GET /metrics. */
export function observability(opts: ObservabilityOptions = {}): Router {
  const metrics = opts.metrics ?? new Metrics();
  const tracer = new Tracer(opts.exporter ?? noopExporter);
  const router = Router();

  const attach: RequestHandler = (req, res, next) => {
    const t0 = performance.now();
    req.tracer = tracer;
    req.metrics = metrics;
    res.on('finish', () => metrics.observeLatency('http', performance.now() - t0));
    next();
  };
  router.use(attach);

  const route = opts.metricsRoute ?? '/metrics';
  if (route) router.get(route, (_req, res) => void res.json(metrics.snapshot()));
  return router;
}
