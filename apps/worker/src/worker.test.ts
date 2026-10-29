import { chunks, createDb, documents, eq, organizations, collections, sql, usageEvents, type Db, type DbHandle } from '@docmind/db';
import { LocalProvider, type LLMProvider } from '@docmind/llm';
import { FsStorage } from '@docmind/storage';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_MESSAGES } from '@docmind/ingest';
import { MemoryQueue } from '@docmind/queue';
import { INGEST_QUEUE, processDocument, reindexDocuments, SERVICE_LIMIT_ERROR, startWorker, type StatusEvent } from './index';

let h: DbHandle;
let storage: FsStorage;
let orgId: string;
let colId: string;

beforeAll(async () => {
  h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  storage = new FsStorage(await mkdtemp(join(tmpdir(), 'docmind-worker-')));
  orgId = (await h.db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning())[0]!.id;
  colId = (await h.db.insert(collections).values({ organizationId: orgId, name: 'c' }).returning())[0]!.id;
}, 60_000);
afterAll(() => h.close());

async function addDoc(filename: string, mimeType: string, body: string) {
  const key = `${orgId}/${filename}`;
  await storage.put(key, new TextEncoder().encode(body));
  const [d] = await h.db
    .insert(documents)
    .values({ organizationId: orgId, collectionId: colId, filename, mimeType, sizeBytes: body.length, storageKey: key })
    .returning();
  return d!.id;
}

describe('processDocument', () => {
  it('ingere, grava chunks, marca ready e emite eventos; reprocessar nao duplica', async () => {
    const id = await addDoc('a.md', 'text/markdown', '# Prazos\n\nA entrega ocorre em 30 dias.\n\n# Multas\n\nAtraso gera multa de 2%.');
    const events: StatusEvent[] = [];
    const deps = { db: h.db, storage, llm: new LocalProvider(), onStatus: (e: StatusEvent) => events.push(e), baseMs: 1 };

    await processDocument({ organizationId: orgId, documentId: id }, deps);
    const [doc] = await h.db.select().from(documents).where(eq(documents.id, id));
    const rows = await h.db.select().from(chunks).where(eq(chunks.documentId, id));
    expect(doc!.status).toBe('ready');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.embedding).toHaveLength(384);
    expect(rows[0]!.context).toContain('a.md');
    expect(rows[0]!.section).toBe('Prazos');
    expect(rows[0]!.tokenCount).toBeGreaterThan(0);
    expect(events.map((e) => e.status)).toEqual(['processing', 'ready']);

    await processDocument({ organizationId: orgId, documentId: id }, deps);
    expect(await h.db.select().from(chunks).where(eq(chunks.documentId, id))).toHaveLength(rows.length);
  });

  it('teto global de tokens atingido -> failed com mensagem controlada, sem chamar o provedor; abaixo do teto processa', async () => {
    await h.db.insert(usageEvents).values({ organizationId: orgId, kind: 'query', tokensIn: 100, tokensOut: 0 });
    let embedCalls = 0;
    class Counting extends LocalProvider {
      override async embed(texts: string[]) {
        embedCalls++;
        return super.embed(texts);
      }
    }
    const events: StatusEvent[] = [];
    const id = await addDoc('cap.txt', 'text/plain', 'texto que custaria embeddings');
    const deps = { db: h.db, storage, llm: new Counting(), baseMs: 1, onStatus: (e: StatusEvent) => events.push(e) };
    await processDocument({ organizationId: orgId, documentId: id }, { ...deps, globalTokenLimit: 100 });
    const [doc] = await h.db.select().from(documents).where(eq(documents.id, id));
    expect(doc).toMatchObject({ status: 'failed', error: SERVICE_LIMIT_ERROR });
    expect(events.map((e) => e.status)).toEqual(['failed']);
    expect(embedCalls).toBe(0);

    await processDocument({ organizationId: orgId, documentId: id }, { ...deps, globalTokenLimit: 1e12 });
    expect((await h.db.select().from(documents).where(eq(documents.id, id)))[0]!.status).toBe('ready');
    expect(embedCalls).toBeGreaterThan(0);
  });

  it('tipo nao suportado -> failed com mensagem, sem lancar', async () => {
    const id = await addDoc('x.png', 'image/png', 'xx');
    await processDocument({ organizationId: orgId, documentId: id }, { db: h.db, storage, llm: new LocalProvider(), baseMs: 1 });
    const [doc] = await h.db.select().from(documents).where(eq(documents.id, id));
    expect(doc!.status).toBe('failed');
    expect(doc!.error).toBe(USER_MESSAGES.unsupported_type);
    expect(doc!.error).not.toMatch(/png/);
  });

  it('arquivo ausente no storage esgota retries e marca failed', async () => {
    const id = await addDoc('y.txt', 'text/plain', 'ok');
    await storage.delete(`${orgId}/y.txt`);
    await processDocument({ organizationId: orgId, documentId: id }, { db: h.db, storage, llm: new LocalProvider(), baseMs: 1, retries: 1 });
    const [doc] = await h.db.select().from(documents).where(eq(documents.id, id));
    expect(doc!.status).toBe('failed');
    expect(doc!.error).toBe(USER_MESSAGES.internal); // ENOENT com o caminho do storage fica so no log
    expect(doc!.error).not.toMatch(/ENOENT|docmind-worker|y\.txt/);
  });

  it('documento de outra organizacao e ignorado', async () => {
    const id = await addDoc('z.txt', 'text/plain', 'conteudo');
    await processDocument({ organizationId: '00000000-0000-0000-0000-000000000000', documentId: id }, { db: h.db, storage, llm: new LocalProvider() });
    const [doc] = await h.db.select().from(documents).where(eq(documents.id, id));
    expect(doc!.status).toBe('pending');
  });
});

const until = async (cond: () => Promise<boolean>, ms = 5000) => {
  for (const t = Date.now(); Date.now() - t < ms; ) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout aguardando condicao');
};
const statusOf = async (id: string) => (await h.db.select().from(documents).where(eq(documents.id, id)))[0]!.status;

describe('invalidateCache', () => {
  it('chama com organizacao e colecao em ready e em failed; falha do callback nao derruba', async () => {
    const calls: unknown[] = [];
    const deps = { db: h.db, storage, llm: new LocalProvider(), baseMs: 1, invalidateCache: (a: unknown) => void calls.push(a) };
    await processDocument({ organizationId: orgId, documentId: await addDoc('i1.txt', 'text/plain', 'algum texto') }, deps);
    await processDocument({ organizationId: orgId, documentId: await addDoc('i2.png', 'image/png', 'x') }, deps);
    expect(calls).toEqual([{ organizationId: orgId, collectionId: colId }, { organizationId: orgId, collectionId: colId }]);

    const id = await addDoc('i3.txt', 'text/plain', 'outro texto');
    await processDocument({ organizationId: orgId, documentId: id }, { ...deps, invalidateCache: () => { throw new Error('boom'); } });
    expect(await statusOf(id)).toBe('ready');
  });
});

describe('startWorker', () => {
  /** Storage que mede quantos get() rodam ao mesmo tempo. */
  const spy = (delayMs: number) => {
    const state = { cur: 0, max: 0 };
    const wrapped = {
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      get: async (k: string) => {
        state.max = Math.max(state.max, ++state.cur);
        await new Promise((r) => setTimeout(r, delayMs));
        state.cur--;
        return storage.get(k);
      },
    };
    return { state, wrapped };
  };

  it('recupera documentos presos em processing no boot', async () => {
    const id = await addDoc('stuck.txt', 'text/plain', 'texto que ficou preso');
    await h.db.update(documents).set({ status: 'processing' }).where(eq(documents.id, id));
    const w = startWorker(new MemoryQueue(), { db: h.db, storage, llm: new LocalProvider(), baseMs: 1 });
    expect(await w.recovered).toBeGreaterThanOrEqual(1);
    await until(async () => (await statusOf(id)) === 'ready');
    await w.stop();
  });

  it.each([[1], [2]])('respeita a concorrencia (%i)', async (n) => {
    const { state, wrapped } = spy(40);
    const q = new MemoryQueue();
    const w = startWorker(q, { db: h.db, storage: wrapped, llm: new LocalProvider(), baseMs: 1, concurrency: n });
    await w.recovered;
    const ids = [await addDoc(`c${n}a.txt`, 'text/plain', 'aaa'), await addDoc(`c${n}b.txt`, 'text/plain', 'bbb'), await addDoc(`c${n}c.txt`, 'text/plain', 'ccc')];
    for (const documentId of ids) await q.enqueue(INGEST_QUEUE, { organizationId: orgId, documentId });
    await until(async () => (await Promise.all(ids.map(statusOf))).every((s) => s === 'ready'));
    expect(state.max).toBe(n);
    await w.stop();
  });

  it('stop espera o job corrente e descarta os que nao comecaram', async () => {
    const { wrapped } = spy(150);
    const q = new MemoryQueue();
    const w = startWorker(q, { db: h.db, storage: wrapped, llm: new LocalProvider(), baseMs: 1, concurrency: 1 });
    await w.recovered;
    const first = await addDoc('s1.txt', 'text/plain', 'primeiro');
    const second = await addDoc('s2.txt', 'text/plain', 'segundo');
    await q.enqueue(INGEST_QUEUE, { organizationId: orgId, documentId: first });
    await q.enqueue(INGEST_QUEUE, { organizationId: orgId, documentId: second });
    await until(async () => (await statusOf(first)) === 'processing');
    await w.stop();
    expect(await statusOf(first)).toBe('ready');
    expect(await statusOf(second)).toBe('pending');
  });

  it('analyzeWhenIdle: roda ANALYZE chunks quando a fila esvazia (estatisticas do planner)', async () => {
    const reltuples = async () => Number(((await h.db.execute(sql`select reltuples from pg_class where relname = 'chunks'`)) as any).rows[0].reltuples);
    const q = new MemoryQueue();
    const w = startWorker(q, { db: h.db, storage, llm: new LocalProvider(), baseMs: 1, concurrency: 2, analyzeWhenIdle: true });
    await w.recovered;
    const ids = [await addDoc('an1.txt', 'text/plain', 'um dois tres'), await addDoc('an2.txt', 'text/plain', 'quatro cinco seis')];
    for (const documentId of ids) await q.enqueue(INGEST_QUEUE, { organizationId: orgId, documentId });
    await until(async () => (await reltuples()) > 0);
    await w.stop();
  });

  it('retry: banco fora sem gravar o desfecho => a fila repete com backoff; erro permanente gravado nao repete', async () => {
    // db cuja chamada `nth` de `method` falha uma vez (a conexao caiu e voltou); o startWorker ja faz 1 select (recoverStuck)
    const blip = (method: 'select' | 'update', nth: number): Db => {
      let n = 0;
      return new Proxy(h.db, {
        get: (t, k) =>
          k !== method
            ? Reflect.get(t, k)
            : (...a: unknown[]) => {
                if (++n === nth) throw new Error('connection terminated unexpectedly');
                return (t as any)[k](...a);
              },
      });
    };
    const once = async (db: Db, filename: string, mimeType: string) => {
      let gets = 0;
      const counted = { put: storage.put.bind(storage), delete: storage.delete.bind(storage), get: (k: string) => (gets++, storage.get(k)) };
      const q = new MemoryQueue({ attempts: 3, backoffMs: 1 });
      const w = startWorker(q, { db, storage: counted, llm: new LocalProvider(), baseMs: 1 });
      await w.recovered;
      const id = await addDoc(filename, mimeType, 'o banco caiu e voltou');
      await q.enqueue(INGEST_QUEUE, { organizationId: orgId, documentId: id });
      await until(async () => ['ready', 'failed'].includes(await statusOf(id)));
      await w.stop();
      return { status: await statusOf(id), gets };
    };
    expect(await once(blip('select', 2), 'r1.txt', 'text/plain')).toEqual({ status: 'ready', gets: 1 }); // falhou ao carregar: 2a tentativa da fila
    expect(await once(blip('update', 2), 'r2.png', 'image/png')).toEqual({ status: 'failed', gets: 2 }); // nao gravou o failed: a fila repete
    expect(await once(h.db, 'r3.png', 'image/png')).toEqual({ status: 'failed', gets: 1 }); // permanente gravado: uma vez so
  });

  it('o mesmo documento nao roda em paralelo', async () => {
    const { state, wrapped } = spy(60);
    const q = new MemoryQueue();
    const w = startWorker(q, { db: h.db, storage: wrapped, llm: new LocalProvider(), baseMs: 1, concurrency: 4 });
    await w.recovered;
    const id = await addDoc('dup.txt', 'text/plain', 'duplicado');
    await q.enqueue(INGEST_QUEUE, { organizationId: orgId, documentId: id });
    await q.enqueue(INGEST_QUEUE, { organizationId: orgId, documentId: id });
    await until(async () => (await statusOf(id)) === 'ready');
    await w.stop();
    expect(state.max).toBe(1);
    expect(await h.db.select().from(chunks).where(eq(chunks.documentId, id))).toHaveLength(1);
  });
});

describe('limites e timeout no worker', () => {
  it('chunks acima do teto => failed com mensagem de categoria', async () => {
    const id = await addDoc('grande.txt', 'text/plain', Array.from({ length: 100 }, (_, i) => `P${i} ${'palavra '.repeat(80)}`).join('\n\n'));
    await processDocument({ organizationId: orgId, documentId: id }, { db: h.db, storage, llm: new LocalProvider(), baseMs: 1, limits: { maxChunks: 2 } });
    const [doc] = await h.db.select().from(documents).where(eq(documents.id, id));
    expect(doc!.status).toBe('failed');
    expect(doc!.error).toBe(USER_MESSAGES.too_large);
    expect(await h.db.select().from(chunks).where(eq(chunks.documentId, id))).toHaveLength(0);
  });

  it('timeout do job => failed/timeout sem retry', async () => {
    const id = await addDoc('lento.txt', 'text/plain', 'texto qualquer');
    const slow = { ...storage, put: storage.put.bind(storage), delete: storage.delete.bind(storage), get: async (k: string) => { await new Promise((r) => setTimeout(r, 30)); return storage.get(k); } };
    await processDocument({ organizationId: orgId, documentId: id }, { db: h.db, storage: slow, llm: new LocalProvider(), baseMs: 1, jobTimeoutMs: 1 });
    const [doc] = await h.db.select().from(documents).where(eq(documents.id, id));
    expect(doc!.status).toBe('failed');
    expect(doc!.error).toBe(USER_MESSAGES.timeout);
  });
});

describe('provedor externo (falso) no worker', () => {
  const fake = (embedError?: Error) => {
    const calls: number[] = [];
    const llm: LLMProvider = {
      name: 'openai',
      dims: 384,
      embeddingModel: 'openai:fake-embed:384',
      async embed(texts, o) {
        calls.push(texts.length);
        if (embedError) throw embedError;
        o?.onUsage?.({ inputTokens: texts.length * 7, outputTokens: 0 });
        return texts.map(() => new Array<number>(384).fill(0.01));
      },
      async *generateStream(_m, o) {
        o?.onUsage?.({ inputTokens: 40, outputTokens: 4 });
        yield 'Contexto.';
      },
      async generateObject() {
        throw new Error('nao usado');
      },
    };
    return { llm, calls };
  };

  it('grava embedding_model em cada chunk e os tokens reais nos usage_events', async () => {
    const { llm } = fake();
    const id = await addDoc('ext.md', 'text/markdown', '# Um\n\nTexto um.\n\n# Dois\n\nTexto dois.');
    await processDocument({ organizationId: orgId, documentId: id }, { db: h.db, storage, llm, baseMs: 1, llmContext: true });
    expect(await statusOf(id)).toBe('ready');
    const rows = await h.db.select().from(chunks).where(eq(chunks.documentId, id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.embeddingModel === 'openai:fake-embed:384')).toBe(true);
    const events = await h.db.select().from(usageEvents).where(eq(usageEvents.organizationId, orgId));
    const embed = events.filter((e) => e.kind === 'embed').at(-1)!;
    const ingestEv = events.filter((e) => e.kind === 'ingest').at(-1)!;
    expect(embed.tokensIn).toBe(rows.length * 7);
    expect(ingestEv).toMatchObject({ tokensIn: rows.length * 40, tokensOut: rows.length * 4 });
  });

  it('provider local grava local:hash-v2:384 e usa a estimativa de tokens', async () => {
    const id = await addDoc('loc.txt', 'text/plain', 'um texto simples para o provedor local');
    await processDocument({ organizationId: orgId, documentId: id }, { db: h.db, storage, llm: new LocalProvider(), baseMs: 1 });
    const [row] = await h.db.select().from(chunks).where(eq(chunks.documentId, id));
    expect(row!.embeddingModel).toBe('local:hash-v2:384');
  });

  it('falha do provedor: failed com mensagem de categoria, uma unica chamada e sem vazar a chave', async () => {
    const { llm, calls } = fake(new Error('openai /embeddings 429: quota (key sk-segredo-123)'));
    const id = await addDoc('falha.txt', 'text/plain', 'texto qualquer');
    await processDocument({ organizationId: orgId, documentId: id }, { db: h.db, storage, llm, baseMs: 1, retries: 3 });
    const [doc] = await h.db.select().from(documents).where(eq(documents.id, id));
    expect(doc!.status).toBe('failed');
    expect(doc!.error).toBe(USER_MESSAGES.provider_error);
    expect(doc!.error).not.toMatch(/sk-|429|quota/);
    expect(calls).toHaveLength(1); // nem o retry do job reembeda (e recobra) lotes ja pagos
    expect(await h.db.select().from(chunks).where(eq(chunks.documentId, id))).toHaveLength(0);
  });
});

describe('embedding_model em todos os caminhos de escrita', () => {
  const external = (model: string): LLMProvider => ({
    name: 'openai',
    dims: 384,
    embeddingModel: model,
    embed: async (texts) => texts.map(() => new Array<number>(384).fill(0.02)),
    async *generateStream() {
      yield 'x';
    },
    generateObject: async () => {
      throw new Error('nao usado');
    },
  });
  const models = async (id: string) => (await h.db.select().from(chunks).where(eq(chunks.documentId, id))).map((r) => r.embeddingModel);

  it('ingestao normal, reprocesso com outro provider e reindex regravam embedding e embedding_model juntos', async () => {
    const id = await addDoc('modelo.md', 'text/markdown', '# A\n\nTexto A.\n\n# B\n\nTexto B.');
    const job = { organizationId: orgId, documentId: id };

    await processDocument(job, { db: h.db, storage, llm: new LocalProvider(), baseMs: 1 });
    const first = await models(id);
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first)).toEqual(new Set(['local:hash-v2:384'])); // nenhum NULL

    // reprocesso com outro provider: nada fica com o modelo antigo
    await processDocument(job, { db: h.db, storage, llm: external('openai:fake-a:384'), baseMs: 1 });
    expect(new Set(await models(id))).toEqual(new Set(['openai:fake-a:384']));

    // reindex (o que o script `reindex` executa) com o provider ativo agora outro
    const total = await reindexDocuments({ db: h.db, storage, llm: external('openai:fake-b:384'), baseMs: 1 });
    expect(total).toBeGreaterThan(0);
    const after = await h.db.select().from(chunks).where(eq(chunks.documentId, id));
    expect(after).toHaveLength(first.length);
    expect(new Set(after.map((r) => r.embeddingModel))).toEqual(new Set(['openai:fake-b:384']));
    expect(after.every((r) => r.embedding && r.embedding[0] === 0.02)).toBe(true); // o vetor novo veio junto com o modelo novo
  });
});
