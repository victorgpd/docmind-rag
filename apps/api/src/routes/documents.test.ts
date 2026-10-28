import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb, documents, eq, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { MemoryQueue } from '@docmind/queue';
import { FsStorage } from '@docmind/storage';
import { buildApp } from '../app';
import { MAX_UPLOAD_BYTES, notifyDocumentChange, URL_MIME } from './documents';

let h: DbHandle;
// RATE_LIMIT_* altos: o limite global (60/min por usuario) estouraria com tantas chamadas e viraria 429 intermitente
let app: ReturnType<typeof buildApp>;
let storage: FsStorage;
const enqueued: unknown[] = [];
let A: { token: string; orgId: string; coll: string };
let B: { token: string; orgId: string; coll: string };
const PUBLIC = 'http://93.184.216.34/artigo'; // IP literal: sem DNS nos testes

const queue = new MemoryQueue();
queue.enqueue = async (_n: string, p: unknown) => void enqueued.push(p);

const api = (method: 'get' | 'post' | 'delete', url: string, token?: string) => {
  const r = request(app)[method](`/api/v1${url}`);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

async function tenant(email: string) {
  const reg = await api('post', '/auth/register').send({ email, password: 'senha-forte-1', name: 'Fulano', organizationName: `Org ${email}` });
  const token = reg.body.token as string;
  const coll = await api('post', '/collections', token).send({ name: 'colecao' });
  return { token, orgId: reg.body.user.organizationId as string, coll: coll.body.id as string };
}

const upload = (t: { token: string }, coll: string, name: string, content: Buffer | string) =>
  api('post', `/collections/${coll}/documents`, t.token).attach('file', Buffer.from(content), name);

// DOCX minimo para o validateUpload: zip com entrada "word/"
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(' word/document.xml ')]);

beforeAll(async () => {
  h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  storage = new FsStorage(await mkdtemp(join(tmpdir(), 'docmind-')));
  app = buildApp({ config: loadConfig({ NODE_ENV: 'test', RATE_LIMIT_USER: '100000', RATE_LIMIT_ORG: '100000' }), db: h, llm: createLLM(), queue, storage });
  A = await tenant('a@docs.test');
  B = await tenant('b@docs.test');
}, 60000);
afterAll(() => h.close());

describe('upload', () => {
  it('aceita txt, md, pdf e docx e grava no storage', async () => {
    for (const [name, content, mime] of [
      ['a.txt', 'ola', 'text/plain'],
      ['b.md', '# ola', 'text/markdown'],
      ['c.pdf', '%PDF-1.4 x', 'application/pdf'],
      ['d.docx', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ] as const) {
      const r = await upload(A, A.coll, name, content);
      expect(r.status, name).toBe(201);
      expect(r.body).toMatchObject({ filename: name, mimeType: mime, status: 'pending', organizationId: A.orgId });
      expect((await storage.get(r.body.storageKey)).length).toBe(Buffer.byteLength(content));
    }
  });

  it('rejeita tipo nao suportado, conteudo falso, extensao divergente e arquivo vazio', async () => {
    expect((await upload(A, A.coll, 'x.exe', 'MZ')).status).toBe(415);
    expect((await upload(A, A.coll, 'x.pdf', 'isto nao e pdf')).status).toBe(415);
    expect((await upload(A, A.coll, 'x.txt', '%PDF-1.4 x')).status).toBe(415);
    expect((await upload(A, A.coll, 'x.txt', '')).status).toBe(415);
    expect((await api('post', `/collections/${A.coll}/documents`, A.token)).status).toBe(400); // sem arquivo
  });

  it('rejeita arquivo acima do limite com 413', async () => {
    const r = await upload(A, A.coll, 'big.txt', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 97));
    expect(r.status).toBe(413);
  });

  it('sanitiza nome com path traversal', async () => {
    const r = await upload(A, A.coll, '../../evil.txt', 'x');
    expect(r.status).toBe(201);
    expect(r.body.storageKey).toBe(`${A.orgId}/${r.body.id}/evil.txt`);
  });

  it('404 para colecao de outra org e 401 sem token', async () => {
    expect((await upload(A, B.coll, 'a.txt', 'x')).status).toBe(404);
    expect((await api('get', '/documents')).status).toBe(401);
    expect((await api('post', `/collections/${A.coll}/documents`)).status).toBe(401);
  });
});

describe('importacao por URL', () => {
  it('grava a URL como text/x-url e deixa o documento pending', async () => {
    const r = await api('post', `/collections/${A.coll}/documents/import`, A.token).send({ url: PUBLIC });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mimeType: URL_MIME, status: 'pending' });
    expect(Buffer.from(await storage.get(r.body.storageKey)).toString()).toBe(PUBLIC);
  });

  it('alias POST /documents/url', async () => {
    const r = await api('post', '/documents/url', A.token).send({ url: PUBLIC, collectionId: A.coll });
    expect(r.status).toBe(201);
    expect(r.body.mimeType).toBe(URL_MIME);
  });

  it.each([
    'http://127.0.0.1/x',
    'http://10.0.0.5/x',
    'http://[::1]/x',
    'http://2130706433/x', // decimal = 127.0.0.1
    'http://0x7f000001/x', // hex
    'http://0177.0.0.1/x', // octal
    'http://[::ffff:127.0.0.1]/x', // IPv6 mapeado
    'http://[::ffff:7f00:1]/x', // IPv6 mapeado em hex
    'http://169.254.169.254/latest/meta-data/', // metadata de nuvem
    'http://100.64.0.1/x', // CGNAT
    'http://localhost/x',
    'http://user:senha@93.184.216.34/x', // credenciais
    'ftp://93.184.216.34/x',
    'file:///etc/passwd',
  ])(
    'bloqueia %s (SSRF/protocolo)',
    async (url) => {
      const r = await api('post', `/collections/${A.coll}/documents/import`, A.token).send({ url });
      expect(r.status).toBe(400);
    },
  );

  it('valida body e colecao', async () => {
    expect((await api('post', `/collections/${A.coll}/documents/import`, A.token).send({ url: 'nao-e-url' })).status).toBe(400);
    expect((await api('post', `/collections/${B.coll}/documents/import`, A.token).send({ url: PUBLIC })).status).toBe(404);
  });
});

describe('process, leitura e delete', () => {
  it('process enfileira uma vez; em processing da 409; failed permite retry', async () => {
    const { id } = (await upload(A, A.coll, 'p.txt', 'abc')).body;
    enqueued.length = 0;
    const r = await api('post', `/documents/${id}/process`, A.token);
    expect(r.status).toBe(202);
    expect(enqueued).toEqual([{ organizationId: A.orgId, documentId: id }]);

    await h.db.update(documents).set({ status: 'processing' }).where(eq(documents.id, id));
    expect((await api('post', `/documents/${id}/process`, A.token)).status).toBe(409);
    expect(enqueued).toHaveLength(1);

    await h.db.update(documents).set({ status: 'failed', error: 'boom' }).where(eq(documents.id, id));
    const retry = await api('post', `/documents/${id}/process`, A.token);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ status: 'pending', error: null });
  });

  it('isola por org: GET/process/DELETE/events/list de outra org nao enxergam o documento', async () => {
    const { id } = (await upload(A, A.coll, 'iso.txt', 'x')).body;
    expect((await api('get', `/documents/${id}`, B.token)).status).toBe(404);
    expect((await api('post', `/documents/${id}/process`, B.token)).status).toBe(404);
    expect((await api('delete', `/documents/${id}`, B.token)).status).toBe(404);
    expect((await api('get', `/documents/${id}/events`, B.token)).status).toBe(404);
    expect((await api('get', '/documents', B.token)).body.items).toEqual([]);
  });

  it('lista filtrando por colecao; id invalido da 400', async () => {
    const list = (await api('get', `/documents?collectionId=${A.coll}`, A.token)).body;
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((d: { collectionId: string }) => d.collectionId === A.coll)).toBe(true);
    expect((await api('get', '/documents/nao-uuid', A.token)).status).toBe(400);
  });

  it('pagina com limit/cursor sem repetir nem perder itens, e filtra por status', async () => {
    const coll = (await api('post', '/collections', A.token).send({ name: 'paginada' })).body.id as string;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await upload(A, coll, `pg${i}.txt`, `doc ${i}`)).body.id);
    await h.db.update(documents).set({ status: 'ready' }).where(eq(documents.id, ids[1]!));

    const all = (await api('get', `/documents?collectionId=${coll}`, A.token)).body;
    expect(all.items).toHaveLength(5);
    expect(all.nextCursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await api('get', `/documents?collectionId=${coll}&limit=2${cursor ? `&cursor=${cursor}` : ''}`, A.token);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((d: { id: string }) => d.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(all.items.map((d: { id: string }) => d.id)); // mesma ordem, sem duplicar

    const ready = (await api('get', `/documents?collectionId=${coll}&status=ready`, A.token)).body.items;
    expect(ready.map((d: { id: string }) => d.id)).toEqual([ids[1]]);
  });

  it('valida limit, cursor e status da listagem', async () => {
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'cursor=nao-uuid', 'status=zzz']) {
      expect((await api('get', `/documents?${q}`, A.token)).status, q).toBe(400);
    }
  });

  it('delete remove linha e arquivo', async () => {
    const doc = (await upload(A, A.coll, 'del.txt', 'x')).body;
    expect((await api('delete', `/documents/${doc.id}`, A.token)).status).toBe(204);
    expect((await api('get', `/documents/${doc.id}`, A.token)).status).toBe(404);
    await expect(storage.get(doc.storageKey)).rejects.toThrow();
  });
});

describe('SSE de status', () => {
  const dataOf = (text: string) => [...text.matchAll(/event: document\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1]!));

  it('/documents/:id/events emite cada mudanca uma vez e fecha ao ficar ready', async () => {
    const { id } = (await upload(A, A.coll, 'sse.txt', 'x')).body;
    const set = (status: string) => async () => {
      await h.db.update(documents).set({ status }).where(eq(documents.id, id));
      notifyDocumentChange(A.orgId);
    };
    setTimeout(set('processing'), 100);
    setTimeout(set('ready'), 250);

    const r = await api('get', `/documents/${id}/events`, A.token);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    const statuses = dataOf(r.text).map((d) => d.status);
    expect(statuses[0]).toBe('pending');
    expect(statuses.at(-1)).toBe('ready');
    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it('/documents/events?collectionId= envia o estado atual e depois as mudancas, com Document completo', async () => {
    const { id } = (await upload(A, A.coll, 'sse2.txt', 'x')).body;
    const server = app.listen(0);
    const ctrl = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/documents/events?collectionId=${A.coll}`, {
        headers: { authorization: `Bearer ${A.token}` },
        signal: ctrl.signal,
      });
      if (res.status !== 200) throw new Error(`SSE por colecao respondeu ${res.status}: ${await res.text()}`);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      setTimeout(async () => {
        await h.db.update(documents).set({ status: 'ready' }).where(eq(documents.id, id));
        notifyDocumentChange(A.orgId);
      }, 100);

      const reader = res.body!.getReader();
      let buf = '';
      while (!dataOf(buf).some((d) => d.id === id && d.status === 'ready')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
      }
      const mine = dataOf(buf).filter((d) => d.id === id);
      expect(mine.map((d) => d.status)).toEqual(['pending', 'ready']);
      expect(mine[0]).toMatchObject({ organizationId: A.orgId, collectionId: A.coll, filename: 'sse2.txt' });
      expect(dataOf(buf).every((d) => d.collectionId === A.coll)).toBe(true);
    } finally {
      ctrl.abort();
      server.close();
    }
  });

  it('sem token da 401', async () => {
    expect((await api('get', '/documents/events')).status).toBe(401);
  });
});
