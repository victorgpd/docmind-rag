import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb, organizations, users, usageEvents, withOrg } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import type { Deps } from '../app';
import { identify, signAccess } from '../http/auth';
import { errorHandler } from '../http/errors';
import { agentRouter } from './agent';

const DOC = '00000000-0000-4000-8000-0000000000a1';
const hit = { chunkId: crypto.randomUUID(), documentId: DOC, page: 1, content: 'A multa contratual e de dez por cento.', score: 1 };

const parseSse = (body: string) =>
  body
    .trim()
    .split('\n\n')
    .map((b) => ({ event: /^event: (.+)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.+)$/m.exec(b)![1]!) }));

it('POST /agent/run: SSE de passos, resultado validado e uso registrado', async () => {
  const db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
  const deps: Deps = { config: loadConfig({ NODE_ENV: 'test' }), db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) };
  const [org] = await db.db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning();
  const [user] = await db.db.insert(users).values({ organizationId: org!.id, email: 'a@acme.com', name: 'A', passwordHash: 'x' }).returning();

  // app minimo com os mesmos middlewares do buildApp, mas com busca/chunks falsos
  const app = express();
  Object.assign(app.locals, { deps, jwtSecret: deps.config.JWT_SECRET });
  app.use((req, _res, next) => ((req.log = { error() {} } as never), next()));
  app.use(express.json(), identify);
  app.use('/api/v1', agentRouter(deps, { retriever: { search: async () => [hit] }, chunks: { get: async () => [hit] } }));
  app.use(errorHandler);

  const token = signAccess(deps.config.JWT_SECRET, { userId: user!.id, orgId: org!.id, role: 'member' });
  const post = (payload: object, auth = true) => {
    const r = request(app).post('/api/v1/agent/run');
    return (auth ? r.set('Authorization', `Bearer ${token}`) : r).send(payload);
  };

  expect((await post({ query: 'x' }, false)).status).toBe(401);
  expect((await post({ query: '' })).status).toBe(400);

  const res = await post({ query: 'qual a multa?' });
  expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  const events = parseSse(res.text);
  expect(events.map((e) => e.event)).toEqual(['plan', 'step', 'step_result', 'result']);
  expect(events.at(-1)!.data.result).toMatchObject({ intent: 'search', citations: [{ documentId: DOC, n: 1 }] });

  const rows = await withOrg(db.db, org!.id, (tx) => tx.select().from(usageEvents));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'query', userId: user!.id });
  expect(rows[0]!.tokensIn).toBeGreaterThan(0);

  await db.close();
}, 60000);

it('POST /agent/run: 402 usage_limit_exceeded antes de abrir o stream', async () => {
  const db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
  const deps: Deps = { config: loadConfig({ NODE_ENV: 'test', MONTHLY_TOKEN_LIMIT: '10' }), db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) };
  const [org] = await db.db.insert(organizations).values({ name: 'Acme', slug: 'acme2' }).returning();
  const [user] = await db.db.insert(users).values({ organizationId: org!.id, email: 'b@acme.com', name: 'B', passwordHash: 'x' }).returning();
  await db.db.insert(usageEvents).values({ organizationId: org!.id, userId: user!.id, kind: 'query', tokensIn: 8, tokensOut: 8 });

  const app = express();
  Object.assign(app.locals, { deps, jwtSecret: deps.config.JWT_SECRET });
  app.use((req, _res, next) => ((req.log = { error() {} } as never), next()));
  app.use(express.json(), identify);
  app.use('/api/v1', agentRouter(deps, { retriever: { search: async () => [hit] }, chunks: { get: async () => [hit] } }));
  app.use(errorHandler);

  const token = signAccess(deps.config.JWT_SECRET, { userId: user!.id, orgId: org!.id, role: 'member' });
  const res = await request(app).post('/api/v1/agent/run').set('Authorization', `Bearer ${token}`).send({ query: 'qual a multa?' });
  expect(res.status).toBe(402);
  expect(res.body.error.code).toBe('usage_limit_exceeded');
  await db.close();
}, 60000);
