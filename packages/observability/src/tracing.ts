import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export type SpanData = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  error?: string;
};

/** Destino dos spans; trocar por um exportador OTLP real nao exige mexer em quem chama `tracer.span`. */
export interface SpanExporter {
  export(span: SpanData): void;
}

export const noopExporter: SpanExporter = { export() {} };

export function consoleExporter(write: (line: string) => void = console.log): SpanExporter {
  return { export: (s) => write(JSON.stringify(s)) };
}

export type SpanHandle = { setAttribute(key: string, value: string | number | boolean): void };

const current = new AsyncLocalStorage<{ traceId: string; spanId: string }>();

/** Tracer no estilo OpenTelemetry (trace/span ids, pai via AsyncLocalStorage), sem dependencia externa. */
export class Tracer {
  constructor(private readonly exporter: SpanExporter = noopExporter) {}

  async span<T>(
    name: string,
    fn: (span: SpanHandle) => Promise<T> | T,
    attributes: SpanData['attributes'] = {},
  ): Promise<T> {
    const parent = current.getStore();
    const ctx = { traceId: parent?.traceId ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex') };
    const attrs = { ...attributes };
    const startMs = Date.now();
    const t0 = performance.now();
    const done = (status: SpanData['status'], error?: string) =>
      this.exporter.export({
        name,
        ...ctx,
        parentSpanId: parent?.spanId,
        startMs,
        durationMs: performance.now() - t0,
        attributes: attrs,
        status,
        error,
      });
    try {
      const result = await current.run(ctx, () =>
        fn({
          setAttribute: (k, v) => {
            attrs[k] = v;
          },
        }),
      );
      done('ok');
      return result;
    } catch (err) {
      done('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
