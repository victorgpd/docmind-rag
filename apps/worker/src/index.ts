import { chunks, documents, and, eq, globalLimitReached, sql, usageEvents, type Db } from '@docmind/db';
import { errorCode, ingest, userMessage, withRetry, type IngestLimits } from '@docmind/ingest';
import type { LLMProvider } from '@docmind/llm';
import type { Config } from '@docmind/config';
import type { Queue } from '@docmind/queue';
import type { DocumentStatus } from '@docmind/shared';
import type { Storage } from '@docmind/storage';

export const INGEST_QUEUE = 'ingest-document';
export type IngestJob = { organizationId: string; documentId: string };

export type StatusEvent = { organizationId: string; documentId: string; status: DocumentStatus; error?: string };

export type WorkerDeps = {
  /** Conexao crua (privilegiada): o worker filtra por organization_id explicitamente. */
  db: Db;
  storage: Storage;
  llm: LLMProvider;
  /** Chamado a cada mudanca de status (a API liga isso ao SSE de GET /documents/events). */
  onStatus?: (e: StatusEvent) => void;
  /** Chamado quando um documento fica ready/failed, para invalidar o cache semantico (injete retrieval.invalidate; o worker nao depende dele). */
  invalidateCache?: (a: { organizationId: string; collectionId?: string }) => unknown;
  /** Jobs simultaneos neste processo (padrao 1; WORKER_CONCURRENCY). */
  concurrency?: number;
  /** Roda `ANALYZE chunks` quando a fila esvazia. Use no PGlite (sem autovacuum): sem estatisticas o planner abandona o HNSW sob RLS. */
  analyzeWhenIdle?: boolean;
  /** Contexto de cada chunk por LLM (INGEST_LLM_CONTEXT, opt-in): 1 chamada de chat por chunk. Padrao: frase deterministica. */
  llmContext?: boolean;
  /** Tetos contra expansao (paginas, chunks, DOCX); omitido = defaults de @docmind/ingest. */
  limits?: Partial<IngestLimits>;
  /** Tempo maximo por job, retries incluidos (padrao 300 s). */
  jobTimeoutMs?: number;
  /** Teto global de tokens do mes (GLOBAL_MONTHLY_TOKEN_LIMIT, todas as organizacoes): atingido, o documento falha sem chamar o provedor. 0/omitido desliga. */
  globalTokenLimit?: number;
  /** Tentativas totais por documento e base do backoff; testes zeram o backoff. */
  retries?: number;
  baseMs?: number;
};

const INSERT_BATCH = 100;
export const SERVICE_LIMIT_ERROR = 'Limite de uso do serviço atingido este mês. Tente novamente mais tarde.';

/** Concorrencia, limites e timeout vindos de packages/config (WORKER_CONCURRENCY, INGEST_*). */
export function ingestOptionsFromConfig(c: Config) {
  return {
    concurrency: c.WORKER_CONCURRENCY,
    jobTimeoutMs: c.INGEST_JOB_TIMEOUT_S * 1000,
    llmContext: c.INGEST_LLM_CONTEXT,
    limits: { maxPages: c.INGEST_MAX_PAGES, maxChunks: c.INGEST_MAX_CHUNKS, maxDocxBytes: c.INGEST_MAX_DOCX_MB * 1024 * 1024, maxDocxRatio: c.INGEST_MAX_DOCX_RATIO },
    globalTokenLimit: c.GLOBAL_MONTHLY_TOKEN_LIMIT,
  } satisfies Pick<WorkerDeps, 'concurrency' | 'jobTimeoutMs' | 'limits' | 'llmContext' | 'globalTokenLimit'>;
}

/** Processa um documento; o resultado fica em documents.status/error. So lanca sem banco (nao leu o documento ou nao gravou o desfecho): a fila repete (RETRY). */
export async function processDocument(job: IngestJob, deps: WorkerDeps): Promise<void> {
  const { db, storage, llm } = deps;
  const { organizationId, documentId } = job;
  const mine = and(eq(documents.id, documentId), eq(documents.organizationId, organizationId));
  const setStatus = async (status: DocumentStatus, extra: { error?: string | null; pageCount?: number | null } = {}) => {
    await db.update(documents).set({ status, ...extra }).where(mine);
    deps.onStatus?.({ organizationId, documentId, status, ...(extra.error ? { error: extra.error } : {}) });
  };

  const [doc] = await db.select().from(documents).where(mine).limit(1);
  if (!doc) return console.warn('[worker] documento inexistente', documentId);

  const settled = async () => {
    try {
      await deps.invalidateCache?.({ organizationId, collectionId: doc.collectionId });
    } catch (e) {
      console.error('[worker] falha ao invalidar cache', e); // cache velho nao pode derrubar a ingestao
    }
  };

  const started = Date.now();
  try {
    // embeddings tambem custam: com o teto global atingido nao chama o provedor (mensagem controlada, sem detalhe)
    if (await globalLimitReached(db, deps.globalTokenLimit ?? 0)) {
      console.warn('[worker] teto global de tokens atingido; documento nao processado', documentId);
      return await setStatus('failed', { error: SERVICE_LIMIT_ERROR });
    }
    await setStatus('processing', { error: null });
    const signal = AbortSignal.timeout(deps.jobTimeoutMs ?? 300_000);
    const result = await withRetry(
      async () =>
        ingest({ data: await storage.get(doc.storageKey), mimeType: doc.mimeType, filename: doc.filename }, llm, {
          baseMs: deps.baseMs,
          limits: deps.limits,
          llmContext: deps.llmContext,
          signal,
        }),
      { retries: deps.retries ?? 2, baseMs: deps.baseMs },
    );

    // reprocessar e idempotente: troca todos os chunks do documento numa transacao
    await db.transaction(async (tx) => {
      await tx.delete(chunks).where(and(eq(chunks.documentId, documentId), eq(chunks.organizationId, organizationId)));
      for (let i = 0; i < result.chunks.length; i += INSERT_BATCH) {
        await tx.insert(chunks).values(
          result.chunks.slice(i, i + INSERT_BATCH).map((c) => ({
            organizationId,
            documentId,
            collectionId: doc.collectionId,
            ordinal: c.ordinal,
            page: c.page,
            content: c.content, // texto original (citacoes); o contexto foi embutido junto no embedding
            context: c.context,
            section: c.section,
            tokenCount: c.tokenCount,
            embedding: c.embedding,
            embeddingModel: result.embeddingModel, // vetores de modelos diferentes nao sao comparaveis: a busca/reindex usa isto
          })),
        );
      }
    });

    const latencyMs = Date.now() - started;
    // tokens reais do provedor quando ele informa (openai); senao a estimativa por caracteres (local/ollama)
    const { usage } = result;
    await db.insert(usageEvents).values([
      { organizationId, kind: 'ingest', tokensIn: usage.contextIn || result.tokens, tokensOut: usage.contextOut, latencyMs },
      { organizationId, kind: 'embed', tokensIn: usage.embedIn || result.tokens, latencyMs },
    ]);
    await setStatus('ready', { error: null, pageCount: result.pageCount });
    await settled();
  } catch (e) {
    // usuario ve so a categoria (documents.error); o detalhe tecnico fica no log
    const code = errorCode(e);
    console.error('[worker] falha', documentId, code, e instanceof Error ? e.message : String(e));
    await setStatus('failed', { error: userMessage(e) }); // sem gravar (banco fora) o erro sobe e a fila repete o job; senao ficaria em processing
    await settled();
  }
}

/**
 * Documentos presos em 'processing' (processo morreu no meio) voltam para a fila; processDocument e idempotente.
 * shortcut: assume um unico worker; com varios workers num Redis compartilhado isso pode reprocessar um job vivo (updated_at existe, mas nao e usado para medir idade).
 */
export async function recoverStuck(queue: Queue, db: Db): Promise<number> {
  const stuck = await db.select({ id: documents.id, organizationId: documents.organizationId }).from(documents).where(eq(documents.status, 'processing'));
  for (const d of stuck) await queue.enqueue<IngestJob>(INGEST_QUEUE, { organizationId: d.organizationId, documentId: d.id });
  return stuck.length;
}

export type WorkerHandle = {
  /** Para de aceitar jobs, descarta os que ainda nao comecaram e espera os em andamento. */
  stop(): Promise<void>;
  /** Resolve quando a recuperacao inicial terminou (devolve quantos documentos reenfileirou). */
  recovered: Promise<number>;
};

/** Reprocessa todos os documentos `ready` (ex.: trocou o modelo de embedding). Passa por processDocument: regrava `embedding` e `embedding_model` juntos. */
export async function reindexDocuments(deps: WorkerDeps, onProgress?: (done: number, total: number, documentId: string) => void): Promise<number> {
  const docs = await deps.db.select({ id: documents.id, organizationId: documents.organizationId }).from(documents).where(eq(documents.status, 'ready'));
  for (const [i, d] of docs.entries()) {
    await processDocument({ organizationId: d.organizationId, documentId: d.id }, deps);
    onProgress?.(i + 1, docs.length, d.id);
  }
  return docs.length;
}

/** Registra os handlers da fila. Importavel pela API (modo single-process com fila em memoria). */
export function startWorker(queue: Queue, deps: WorkerDeps): WorkerHandle {
  const max = Math.max(1, deps.concurrency ?? 1);
  let active = 0;
  let stopping = false;
  const waiting: (() => void)[] = [];
  const inflight = new Set<Promise<void>>();
  const queued = new Set<string>(); // evita o mesmo documento em duas execucoes paralelas (duplicaria chunks)

  const run = async (job: IngestJob) => {
    while (active >= max && !stopping) await new Promise<void>((r) => waiting.push(r));
    if (stopping) return; // descartado: o documento segue como estava e a recuperacao o pega no proximo boot se ja estava 'processing'
    active++;
    try {
      await processDocument(job, deps);
    } finally {
      active--;
      waiting.shift()?.();
    }
    // queued ainda inclui este job; 1 = ultimo da fila
    if (deps.analyzeWhenIdle && !stopping && active === 0 && queued.size <= 1) {
      await deps.db.execute(sql`analyze chunks`).catch((e) => console.error('[worker] analyze chunks falhou', e));
    }
  };

  queue.process<IngestJob>(INGEST_QUEUE, (job) => {
    if (stopping || queued.has(job.documentId)) return Promise.resolve();
    queued.add(job.documentId);
    const p: Promise<void> = run(job).finally(() => {
      inflight.delete(p);
      queued.delete(job.documentId);
    });
    inflight.add(p);
    return p;
  });

  const recovered = recoverStuck(queue, deps.db).catch((e) => {
    console.error('[worker] falha na recuperacao de documentos presos', e);
    return 0;
  });

  return {
    recovered,
    async stop() {
      stopping = true;
      for (const r of waiting.splice(0)) r();
      await Promise.allSettled([...inflight]);
    },
  };
}
