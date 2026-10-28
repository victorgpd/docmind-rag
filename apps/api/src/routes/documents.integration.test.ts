import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@docmind/config';
import { chunks, createDb, documents, eq, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { startWorker, type WorkerHandle } from '@docmind/worker';
import { buildApp } from '../app';
import { notifyDocumentChange } from './documents';

// Worker REAL in-process (fila em memoria, PGlite, LLM local): o mesmo wiring de main.ts sem Redis.
let h: DbHandle;
let app: ReturnType<typeof buildApp>;
let worker: WorkerHandle;
let token: string;
let orgId: string;
let coll: string;
const invalidateCache = vi.fn();

const api = (method: 'get' | 'post' | 'delete', url: string) => request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);

const MD = `# Politica de ferias

Todo colaborador tem direito a trinta dias de ferias por ano, apos doze meses de trabalho.

## Solicitacao

O pedido deve ser feito com sessenta dias de antecedencia pelo portal do RH.
`;

async function waitStatus(id: string, want: string[], timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const d = (await api('get', `/documents/${id}`)).body;
    if (want.includes(d.status)) return d;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout esperando ${want}; status atual ${d.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  const queue = createQueue();
  const storage = createStorage({ dir: await mkdtemp(join(tmpdir(), 'docmind-int-')) });
  const llm = createLLM();
  worker = startWorker(queue, { db: h.db, storage, llm, baseMs: 0, onStatus: (e) => notifyDocumentChange(e.organizationId), invalidateCache });
  app = buildApp({ config: loadConfig({ NODE_ENV: 'test', RATE_LIMIT_USER: '100000', RATE_LIMIT_ORG: '100000' }), db: h, llm, queue, storage });

  const reg = await request(app).post('/api/v1/auth/register').send({ email: 'int@docs.test', password: 'senha-forte-1', name: 'Int', organizationName: 'Int Org' });
  token = reg.body.token;
  orgId = reg.body.user.organizationId;
  coll = (await api('post', '/collections').send({ name: 'rh' })).body.id;
}, 60_000);
afterAll(async () => {
  await worker.stop();
  await h.close();
});

it('upload .md -> process -> ready, com chunks gravados e cache invalidado', async () => {
  const up = await api('post', `/collections/${coll}/documents`).attach('file', Buffer.from(MD), 'ferias.md');
  expect(up.status).toBe(201);
  const id = up.body.id as string;

  expect((await api('post', `/documents/${id}/process`)).status).toBe(202);
  const done = await waitStatus(id, ['ready', 'failed']);
  expect(done).toMatchObject({ status: 'ready', error: null });

  const rows = await h.db.select().from(chunks).where(eq(chunks.documentId, id));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((c) => c.organizationId === orgId && c.collectionId === coll)).toBe(true);
  expect(rows.map((c) => c.content).join(' ')).toContain('trinta dias de ferias');
  expect(rows[0]!.embedding).toHaveLength(384);

  expect(invalidateCache).toHaveBeenCalledWith(expect.objectContaining({ organizationId: orgId }));
}, 60_000);

it('o SSE por documento recebe ready vindo do worker real e fecha', async () => {
  const up = await api('post', `/collections/${coll}/documents`).attach('file', Buffer.from(MD), 'ferias2.md');
  const id = up.body.id as string;
  expect((await api('post', `/documents/${id}/process`)).status).toBe(202);
  const sse = await api('get', `/documents/${id}/events`);
  const statuses = [...sse.text.matchAll(/event: document\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1]!).status);
  expect(statuses.at(-1)).toBe('ready');
}, 60_000);

it('reprocessar um documento ready e recusado (409) e nao duplica chunks', async () => {
  const up = await api('post', `/collections/${coll}/documents`).attach('file', Buffer.from(MD), 'ferias3.md');
  const id = up.body.id as string;
  await api('post', `/documents/${id}/process`);
  await waitStatus(id, ['ready']);
  const before = (await h.db.select().from(chunks).where(eq(chunks.documentId, id))).length;
  expect((await api('post', `/documents/${id}/process`)).status).toBe(409);
  expect((await h.db.select().from(chunks).where(eq(chunks.documentId, id))).length).toBe(before);
}, 60_000);

it('delete remove os chunks em cascata', async () => {
  const up = await api('post', `/collections/${coll}/documents`).attach('file', Buffer.from(MD), 'apagar.md');
  const id = up.body.id as string;
  await api('post', `/documents/${id}/process`);
  await waitStatus(id, ['ready']);
  expect((await h.db.select().from(chunks).where(eq(chunks.documentId, id))).length).toBeGreaterThan(0);
  expect((await api('delete', `/documents/${id}`)).status).toBe(204);
  expect(await h.db.select().from(chunks).where(eq(chunks.documentId, id))).toEqual([]);
}, 60_000);

it('rejeita URL invalida/privada e tipo divergente da extensao', async () => {
  for (const url of ['nao-e-url', 'http://127.0.0.1/x', 'http://192.168.0.10/x', 'http://[::1]/x', 'file:///etc/passwd']) {
    const r = await api('post', `/collections/${coll}/documents/import`).send({ url });
    expect(r.status, url).toBe(400);
  }
  const fake = await api('post', `/collections/${coll}/documents`).attach('file', Buffer.from(MD), 'falso.pdf'); // texto com extensao .pdf
  expect(fake.status).toBe(415);
  const exe = await api('post', `/collections/${coll}/documents`).attach('file', Buffer.from('MZ\0\0'), 'x.exe');
  expect(exe.status).toBe(415);
});

describe('caminho de falha com o worker real', () => {
  const count = async (id: string) => (await h.db.select().from(chunks).where(eq(chunks.documentId, id))).length;
  const sseStatuses = (text: string) => [...text.matchAll(/event: document\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1]!).status);
  const send = async (name: string, content: string) =>
    (await api('post', `/collections/${coll}/documents`).attach('file', Buffer.from(content), name)).body.id as string;

  it.each([
    ['arquivo sem texto', 'vazio.txt', '   \n\n  \t '],
    ['PDF corrompido', 'quebrado.pdf', '%PDF-1.4\nisto nao e um pdf de verdade'],
  ])('%s -> failed com documents.error, SSE fecha em failed e retry nao grava chunks', async (_n, name, content) => {
    const id = await send(name, content);
    expect((await api('post', `/documents/${id}/process`)).status).toBe(202);

    const sse = await api('get', `/documents/${id}/events`);
    const st = sseStatuses(sse.text);
    expect(st.at(-1)).toBe('failed');
    expect(st).not.toContain('ready');

    const failed = (await api('get', `/documents/${id}`)).body;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBeTruthy();
    expect(await count(id)).toBe(0);

    // failed aceita retry (202), falha de novo e continua sem chunks
    expect((await api('post', `/documents/${id}/process`)).status).toBe(202);
    expect((await waitStatus(id, ['failed'])).error).toBeTruthy();
    expect(await count(id)).toBe(0);
  }, 60_000);

  it('retry de failed apos conteudo valido nao duplica chunks', async () => {
    const id = await send('retry.md', MD);
    await api('post', `/documents/${id}/process`);
    await waitStatus(id, ['ready']);
    const n = await count(id);
    expect(n).toBeGreaterThan(0);

    await h.db.update(documents).set({ status: 'failed', error: 'falha simulada' }).where(eq(documents.id, id));
    const retry = await api('post', `/documents/${id}/process`);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ status: 'pending', error: null });
    expect(await waitStatus(id, ['ready'])).toMatchObject({ error: null });
    expect(await count(id)).toBe(n);
  }, 60_000);
});
