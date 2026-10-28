import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { startWorker, type WorkerHandle } from '@docmind/worker';
import { buildApp } from '../app';
import { notifyDocumentChange } from './documents';

// Reproduz o E2E com varios clientes: API real (HTTP), worker in-process (fila em memoria, PGlite com uma conexao),
// cada cliente com seu stream SSE aberto como a interface faz. Nenhum documento pode ficar preso.
const CLIENTS = Number(process.env.PARALLEL_CLIENTS ?? 16);
const EXTRA_STREAMS = Number(process.env.PARALLEL_STREAMS ?? 0); // streams ociosos por cliente (abas abertas)
let h: DbHandle;
let worker: WorkerHandle;
let server: ReturnType<ReturnType<typeof buildApp>['listen']>;
let base: string;
const aborts: AbortController[] = [];

beforeAll(async () => {
  h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  const queue = createQueue();
  const storage = createStorage({ dir: await mkdtemp(join(tmpdir(), 'docmind-par-')) });
  const llm = createLLM();
  worker = startWorker(queue, { db: h.db, storage, llm, baseMs: 0, analyzeWhenIdle: true, onStatus: (e) => notifyDocumentChange(e.organizationId) });
  const app = buildApp({ config: loadConfig({ NODE_ENV: 'test', RATE_LIMIT_USER: '100000', RATE_LIMIT_ORG: '100000', AUTH_RATE_LIMIT: '100000' }), db: h, llm, queue, storage });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}, 60_000);
afterAll(async () => {
  for (const a of aborts) a.abort();
  await worker.stop();
  server.closeAllConnections?.();
  server.close();
  await h.close();
});

const json = (token: string | undefined, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});

/** Um cliente completo: registra, cria colecao, abre SSE, envia 1 TXT, pede processamento e mede ate `ready`. */
async function client(i: number) {
  const reg = await (await fetch(`${base}/auth/register`, json(undefined, { email: `u${i}@par.test`, password: 'senha-forte-1', name: `U${i}`, organizationName: `Org ${i}` }))).json() as { token: string };
  const token = reg.token;
  const auth = { authorization: `Bearer ${token}` };
  const col = await (await fetch(`${base}/collections`, json(token, { name: 'c' }))).json() as { id: string };

  const ac = new AbortController();
  aborts.push(ac);
  const streamed = fetch(`${base}/documents/events?collectionId=${col.id}`, { headers: auth, signal: ac.signal })
    .then(async (r) => {
      for await (const _ of r.body as unknown as AsyncIterable<Uint8Array>) void _; // consome como a UI
    })
    .catch(() => undefined);

  for (let k = 0; k < EXTRA_STREAMS; k++) {
    const extra = new AbortController();
    aborts.push(extra);
    void fetch(`${base}/documents/events?collectionId=${col.id}`, { headers: auth, signal: extra.signal })
      .then(async (r) => {
        for await (const _ of r.body as unknown as AsyncIterable<Uint8Array>) void _;
      })
      .catch(() => undefined);
  }

  const form = new FormData();
  form.append('file', new Blob([`Documento ${i}: o prazo de entrega e de ${i + 5} dias uteis.`], { type: 'text/plain' }), `d${i}.txt`);
  const doc = await (await fetch(`${base}/collections/${col.id}/documents`, { method: 'POST', headers: auth, body: form })).json() as { id: string };

  const t0 = performance.now();
  const proc = await fetch(`${base}/documents/${doc.id}/process`, { method: 'POST', headers: auth });
  expect(proc.status).toBe(202);
  let status = 'pending';
  while (performance.now() - t0 < 30_000) {
    status = ((await (await fetch(`${base}/documents/${doc.id}`, { headers: auth })).json()) as { status: string }).status;
    if (status === 'ready' || status === 'failed') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  ac.abort();
  await streamed;
  return { i, status, ms: performance.now() - t0 };
}

describe('ingestao com varios clientes em paralelo', () => {
  it(`${CLIENTS} clientes enviando 1 documento ao mesmo tempo: todos chegam a ready`, async () => {
    const res = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i)));
    const ms = res.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`[parallel] ${CLIENTS} clientes: ready em ms min=${ms[0]!.toFixed(0)} p50=${ms[Math.floor(ms.length / 2)]!.toFixed(0)} max=${ms.at(-1)!.toFixed(0)}`);
    expect(res.filter((r) => r.status !== 'ready').map((r) => `${r.i}:${r.status}`)).toEqual([]);
    expect(ms.at(-1)!).toBeLessThan(15_000);
  }, 120_000);
});
