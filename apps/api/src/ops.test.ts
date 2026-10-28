import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue, type Queue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { buildApp } from './app';
import { configureServer, gracefulShutdown } from './http/server';

let db: DbHandle;
const build = (env: Record<string, string> = {}, over: { db?: DbHandle; queue?: Queue } = {}) =>
  buildApp({ config: loadConfig({ NODE_ENV: 'test', ...env }), db: over.db ?? db, llm: createLLM(), queue: over.queue ?? createQueue(), storage: createStorage({ dir: './data/test' }) });

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
}, 60000);
afterAll(() => db.close());

it('/ready: 200 com db ok e redis ignorado sem Redis', async () => {
  const r = await request(build()).get('/api/v1/ready');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ status: 'ready', checks: { db: 'ok', redis: 'skipped' } });
});

it('/ready: 503 se o banco falha, se o Redis falha ou durante o shutdown (sem vazar o erro)', async () => {
  const badDb = { ...db, db: { execute: () => Promise.reject(new Error('senha=segredo')) } } as unknown as DbHandle;
  const d = await request(build({}, { db: badDb })).get('/api/v1/ready');
  expect(d.status).toBe(503);
  expect(d.body.checks.db).toBe('fail');
  expect(JSON.stringify(d.body)).not.toContain('segredo');

  const badQueue = { ...createQueue(), ping: () => Promise.reject(new Error('redis down')) } as unknown as Queue;
  const q = await request(build({}, { queue: badQueue })).get('/api/v1/ready');
  expect([q.status, q.body.checks]).toEqual([503, { db: 'ok', redis: 'fail' }]);

  const okQueue = { ...createQueue(), ping: async () => {} } as unknown as Queue;
  expect((await request(build({}, { queue: okQueue })).get('/api/v1/ready')).body.checks.redis).toBe('ok');

  const closing = build();
  closing.locals.closing = true;
  expect((await request(closing).get('/api/v1/ready')).status).toBe(503);
});

it('CORS por allowlist com credentials; origin fora da lista nao recebe headers', async () => {
  const app = build({ CORS_ORIGINS: 'https://app.docmind.dev, http://localhost:3000/' });
  const ok = await request(app).get('/api/v1/health').set('Origin', 'https://app.docmind.dev');
  expect(ok.headers['access-control-allow-origin']).toBe('https://app.docmind.dev');
  expect(ok.headers['access-control-allow-credentials']).toBe('true');
  expect((await request(app).get('/api/v1/health').set('Origin', 'http://localhost:3000')).headers['access-control-allow-origin']).toBe('http://localhost:3000');

  const bad = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
  expect(bad.status).toBe(200); // a resposta existe, mas o navegador nao a entrega ao site
  expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  expect(bad.headers['access-control-allow-credentials']).toBeUndefined();

  const pre = await request(app).options('/api/v1/auth/refresh').set('Origin', 'https://app.docmind.dev').set('Access-Control-Request-Method', 'POST');
  expect(pre.status).toBe(204);
  expect(pre.headers['access-control-allow-methods']).toContain('POST');
  expect((await request(app).options('/api/v1/auth/refresh').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST')).headers['access-control-allow-origin']).toBeUndefined();

  // padrao: so o web local
  expect((await request(build()).get('/api/v1/health').set('Origin', 'http://localhost:3000')).headers['access-control-allow-origin']).toBe('http://localhost:3000');
  expect(() => build({ CORS_ORIGINS: '*' })).toThrow(/explicit origins/);
});

it('configureServer: keepAlive < headersTimeout e sem timeout de socket (SSE segue aberto)', () => {
  const s = http.createServer();
  configureServer(s);
  expect(s.headersTimeout).toBeGreaterThan(s.keepAliveTimeout);
  expect(s.timeout).toBe(0);
  expect(s.requestTimeout).toBeGreaterThan(0);
});

it('gracefulShutdown: marca closing, derruba conexao pendurada apos a graca, para o worker antes de fechar o db, e e idempotente', async () => {
  const app = express();
  app.get('/hang', () => {}); // nunca responde (como um SSE aberto)
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const hung = new Promise<string>((resolve) => http.get({ port, path: '/hang' }, () => {}).on('error', (e) => resolve((e as NodeJS.ErrnoException).code ?? 'error')));
  await new Promise((r) => setTimeout(r, 50));

  const order: string[] = [];
  const shutdown = gracefulShutdown({
    app,
    server,
    graceMs: 100,
    stop: async () => void order.push(`stop(closing=${app.locals.closing})`),
    close: async () => void order.push('close'),
  });
  const [a, b] = [shutdown(), shutdown()];
  expect(a).toBe(b);
  await a;
  expect(order).toEqual(['stop(closing=true)', 'close']);
  expect(await hung).toBe('ECONNRESET');
  expect(server.listening).toBe(false);
});
