import { collections, createDb, documents, organizations } from '@docmind/db';
import { LocalProvider } from '@docmind/llm';
import { MemoryQueue } from '@docmind/queue';
import { FsStorage } from '@docmind/storage';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INGEST_QUEUE, startWorker } from './index';

// Carga leve: N documentos pequenos na fila, por nivel de concorrencia. Sai com codigo 1 se algum nao chegar a ready.
// Uso: pnpm --filter @docmind/worker load [N]
const N = Number(process.argv[2] ?? 50);
let failed = false;

for (const concurrency of [1, 4]) {
  const h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  const storage = new FsStorage(await mkdtemp(join(tmpdir(), 'docmind-load-')));
  const [org] = await h.db.insert(organizations).values({ name: 'Load', slug: `load-${concurrency}` }).returning();
  const [col] = await h.db.insert(collections).values({ organizationId: org!.id, name: 'c' }).returning();

  const ids: string[] = [];
  for (let i = 0; i < N; i++) {
    const body = Array.from({ length: 6 }, (_, p) => `Documento ${i}, paragrafo ${p}: ${'texto de teste sobre prazos e multas '.repeat(12)}`).join('\n\n');
    const key = `${org!.id}/d${i}.txt`;
    await storage.put(key, new TextEncoder().encode(body));
    const [d] = await h.db
      .insert(documents)
      .values({ organizationId: org!.id, collectionId: col!.id, filename: `d${i}.txt`, mimeType: 'text/plain', sizeBytes: body.length, storageKey: key })
      .returning();
    ids.push(d!.id);
  }

  const queue = new MemoryQueue();
  const worker = startWorker(queue, { db: h.db, storage, llm: new LocalProvider(), concurrency });
  await worker.recovered;
  const t0 = performance.now();
  for (const documentId of ids) await queue.enqueue(INGEST_QUEUE, { organizationId: org!.id, documentId });

  const count = async () => {
    const rows = await h.db.select({ status: documents.status }).from(documents);
    const by: Record<string, number> = {};
    for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1;
    return by;
  };
  let by = await count();
  const deadline = Date.now() + 120_000;
  while ((by.ready ?? 0) + (by.failed ?? 0) < N && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    by = await count();
  }
  const ms = performance.now() - t0;
  await worker.stop();
  const stuck = N - (by.ready ?? 0);
  if (stuck > 0) failed = true;
  console.log(`concorrencia ${concurrency}: ${N} docs em ${(ms / 1000).toFixed(2)} s (${((N / ms) * 1000).toFixed(1)} docs/s) | ready=${by.ready ?? 0} failed=${by.failed ?? 0} presos=${(by.pending ?? 0) + (by.processing ?? 0)}`);
  await h.close();
}
process.exit(failed ? 1 : 0);
