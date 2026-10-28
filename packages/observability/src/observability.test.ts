import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Metrics, Tracer, observability, requestLogging, type SpanData } from './index.js';

describe('Tracer', () => {
  it('liga spans filhos ao pai e marca erro', async () => {
    const spans: SpanData[] = [];
    const tracer = new Tracer({ export: (s) => void spans.push(s) });
    await expect(
      tracer.span('query', async () => {
        await tracer.span('retrieve', () => 1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const [child, parent] = spans;
    expect(child!.parentSpanId).toBe(parent!.spanId);
    expect(child!.traceId).toBe(parent!.traceId);
    expect(parent!.status).toBe('error');
  });
});

describe('Metrics', () => {
  it('agrega latencia, tokens e taxa de feedback positivo', () => {
    const m = new Metrics();
    m.observeLatency('rerank', 10);
    m.observeLatency('rerank', 30);
    m.observeTokens(100);
    m.recordFeedback(true);
    m.recordFeedback(true);
    m.recordFeedback(false);
    const s = m.snapshot();
    expect(s.latencyMs.rerank).toEqual({ count: 2, avg: 20, max: 30 });
    expect(s.tokensPerResponse.avg).toBe(100);
    expect(s.positiveFeedbackRate).toBeCloseTo(2 / 3);
    expect(new Metrics().snapshot().positiveFeedbackRate).toBeNull();
  });
});

describe('middlewares Express', () => {
  const build = () => {
    const app = express();
    app.use(requestLogging({ level: 'silent' }));
    app.use(observability());
    app.get('/ping', (req, res) => {
      req.metrics.recordFeedback(true);
      res.send(req.id as string);
    });
    return app;
  };

  it('devolve x-request-id: respeita o recebido e gera UUID quando falta', async () => {
    const app = build();
    const given = await request(app).get('/ping').set('x-request-id', 'abc-123');
    expect(given.headers['x-request-id']).toBe('abc-123');
    expect(given.text).toBe('abc-123');
    expect((await request(app).get('/ping')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mede latencia http e serve GET /metrics', async () => {
    const app = build();
    await request(app).get('/ping');
    await request(app).get('/ping');
    const m = (await request(app).get('/metrics')).body;
    expect(m.latencyMs.http.count).toBeGreaterThanOrEqual(2);
    expect(m.feedback.positive).toBe(2);
  });
});
