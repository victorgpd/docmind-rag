import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { SseEvent } from '@docmind/shared';
import { buildApp } from '../../apps/api/src/app';
import { startWorker } from '../../apps/worker/src/index';
import { fixture } from '../fixtures';

let db: DbHandle;
let dir: string;
let app: ReturnType<typeof buildApp>;
const api = '/api/v1';

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
  dir = await mkdtemp(join(tmpdir(), 'docmind-http-'));
  const queue = createQueue();
  const storage = createStorage({ dir });
  const llm = createLLM();
  app = buildApp({ config: loadConfig({ NODE_ENV: 'test' }), db, llm, queue, storage });
  startWorker(queue, { db: db.db, storage, llm, retries: 0, baseMs: 0 });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const register = async (email: string, org: string) => {
  const r = await request(app).post(`${api}/auth/register`).send({ email, password: 'senha-forte-123', name: 'Ana', organizationName: org });
  expect(r.status).toBe(201);
  return r.body.token as string;
};
const authed = (t: string) => ({ Authorization: `Bearer ${t}` });

async function upload(token: string, filename: string) {
  const col = await request(app).post(`${api}/collections`).set(authed(token)).send({ name: `col-${filename}` });
  expect(col.status).toBe(201);
  const up = await request(app)
    .post(`${api}/collections/${col.body.id}/documents`)
    .set(authed(token))
    .attach('file', fixture(filename), { filename, contentType: 'text/plain' });
  expect(up.status).toBe(201);
  // upload so cria o documento (pending); /process enfileira a ingestao (fila em memoria, worker no mesmo processo)
  expect((await request(app).post(`${api}/documents/${up.body.id}/process`).set(authed(token))).status).toBeLessThan(300);
  for (let i = 0; i < 100; i++) {
    const d = await request(app).get(`${api}/documents/${up.body.id}`).set(authed(token));
    if (d.body.status === 'ready') return { collectionId: col.body.id as string, documentId: up.body.id as string };
    expect(d.body.status).not.toBe('failed');
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('documento nao ficou ready');
}

/** Envia a pergunta e devolve os eventos SSE ja validados pelo contrato SseEvent. */
async function ask(token: string, question: string, collectionId?: string) {
  const conv = await request(app).post(`${api}/conversations`).set(authed(token)).send({ collectionId });
  expect(conv.status).toBe(201);
  const r = await request(app)
    .post(`${api}/conversations/${conv.body.id}/messages`)
    .set(authed(token))
    .send({ content: question })
    .buffer(true)
    .parse((res, cb) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => cb(null, d));
    });
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toContain('text/event-stream');
  const events = (r.body as string)
    .split('\n\n')
    .filter(Boolean)
    .map((blk) => SseEvent.parse(JSON.parse(blk.split('\n').find((l) => l.startsWith('data: '))!.slice(6))));
  return { events, conversationId: conv.body.id as string };
}

it('register -> upload -> ready -> pergunta (SSE) -> resposta com citacao', async () => {
  const token = await register('ana@acme.com', 'Acme');
  const { documentId } = await upload(token, 'ferias.txt');
  const { events, conversationId } = await ask(token, 'Quantos dias de ferias o colaborador tem direito?');

  const answer = events.filter((e) => e.type === 'token').map((e) => e.delta).join('');
  expect(answer).toContain('30 dias');
  const cit = events.find((e) => e.type === 'citations');
  expect(cit && cit.type === 'citations' && cit.citations.some((c) => c.documentId === documentId)).toBe(true);
  expect(events.at(-1)?.type).toBe('done'); // citations antes de done, sem error

  // a resposta fica persistida com as citacoes na conversa
  const conv = await request(app).get(`${api}/conversations/${conversationId}`).set(authed(token));
  const msg = conv.body.messages.find((m: { role: string }) => m.role === 'assistant');
  expect(msg.content).toContain('30 dias');
  expect(msg.citations[0].documentId).toBe(documentId);
});

it('/usage conta a consulta e o documento da organizacao', async () => {
  const token = await register('duda@delta.com', 'Delta');
  await upload(token, 'reembolso.txt');
  await ask(token, 'Qual o limite diario para alimentacao?');
  const u = await request(app).get(`${api}/usage`).set(authed(token));
  expect(u.status).toBe(200);
  expect(u.body).toMatchObject({ queries: 1, documents: 1 });
  expect(u.body.tokensOut).toBeGreaterThan(0);
});

it('isolamento HTTP: outra organizacao nao ve nem cita o documento, e recebe 404', async () => {
  const tokenB = await register('bia@beta.com', 'Beta');
  const { documentId: secretId } = await upload(tokenB, 'org-b-secreto.txt');
  const tokenA = await register('carlos@gama.com', 'Gama');

  expect((await request(app).get(`${api}/documents/${secretId}`).set(authed(tokenA))).status).toBe(404);
  const { events } = await ask(tokenA, 'Qual o codigo do cofre da Org B?');
  expect(JSON.stringify(events)).not.toContain('BETA-7731');
});

it('sem token as rotas protegidas respondem 401 com o formato de erro padrao', async () => {
  const r = await request(app).get(`${api}/documents`);
  expect(r.status).toBe(401);
  expect(r.body.error.code).toBe('unauthorized');
});
