import type { LLMProvider, Usage } from '@docmind/llm';
import { chunkPages } from './chunk';
import { cleanPages } from './clean';
import { chunkContext, fallbackContext } from './context';
import { extract } from './extract';
import { DEFAULT_LIMITS, PermanentError, type Chunk, type IngestLimits } from './types';

export * from './types';
export { chunkPages, countTokens } from './chunk';
export { cleanPages, normalizeText } from './clean';
export { chunkContext, fallbackContext } from './context';
export * from './extract';

/** Tempo por job: o chamador passa AbortSignal.timeout(); checado entre etapas e lotes (extracao em si nao e interrompivel, mas e limitada por paginas/bytes). */
function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new PermanentError('job excedeu o tempo maximo', 'timeout');
}

export type EmbeddedChunk = Chunk & { context: string; embedding: number[] };

/** Retry com backoff exponencial (ex.: embeddings limitados por taxa). Erros permanentes nao repetem. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { retries?: number; baseMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PermanentError || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, (opts.baseMs ?? 500) * 2 ** attempt));
    }
  }
}

/** Maximo de textos por chamada de embedding (limite dos provedores externos). */
export const MAX_EMBED_BATCH = 100;

/** Provedor externo ja repete 429/5xx/rede com backoff: repetir aqui multiplicaria tentativas e custo, e refazer o job reembedaria lotes ja pagos. */
const hasOwnRetry = (llm: LLMProvider) => llm.name === 'openai';

/** Embeddings em lotes (<= 100); o texto embutido = contexto + conteudo (contextual retrieval). */
export async function embedChunks(
  llm: LLMProvider,
  chunks: (Chunk & { context: string })[],
  opts: { batchSize?: number; baseMs?: number; signal?: AbortSignal; onUsage?: (u: Usage) => void } = {},
): Promise<EmbeddedChunk[]> {
  const size = Math.min(Math.max(1, opts.batchSize ?? 32), MAX_EMBED_BATCH);
  const out: EmbeddedChunk[] = [];
  for (let i = 0; i < chunks.length; i += size) {
    assertNotAborted(opts.signal);
    const batch = chunks.slice(i, i + size);
    const call = () => llm.embed(batch.map((c) => `${c.context}\n${c.content}`), { signal: opts.signal, onUsage: opts.onUsage });
    const vecs = hasOwnRetry(llm)
      ? await call().catch((e: unknown) => {
          if (opts.signal?.aborted) throw new PermanentError('job excedeu o tempo maximo', 'timeout');
          throw e instanceof PermanentError ? e : new PermanentError(`embed falhou: ${e instanceof Error ? e.message : e}`, 'provider_error'); // detalhe so no log
        })
      : await withRetry(call, { baseMs: opts.baseMs });
    if (vecs.length !== batch.length) throw new Error(`embed retornou ${vecs.length} vetores para ${batch.length} textos`);
    batch.forEach((c, j) => out.push({ ...c, embedding: vecs[j]! }));
  }
  return out;
}

/** Tokens reais informados pelo provedor (0 quando ele nao informa, como o local); `tokens` abaixo e a estimativa por caracteres. */
export type IngestUsage = { embedIn: number; contextIn: number; contextOut: number };
export type IngestResult = { chunks: EmbeddedChunk[]; pageCount: number | null; tokens: number; usage: IngestUsage; embeddingModel: string | null };

/** extrair -> limpar -> chunk -> contexto -> embeddings. Nao toca em banco nem storage. */
export async function ingest(
  input: { data: Uint8Array; mimeType: string; filename: string },
  llm: LLMProvider,
  opts: { batchSize?: number; baseMs?: number; limits?: Partial<IngestLimits>; signal?: AbortSignal; llmContext?: boolean } = {},
): Promise<IngestResult> {
  const usage: IngestUsage = { embedIn: 0, contextIn: 0, contextOut: 0 };
  const limits ={ ...DEFAULT_LIMITS, ...opts.limits };
  assertNotAborted(opts.signal);
  const extracted = await extract(input.data, input.mimeType, input.filename, limits);
  assertNotAborted(opts.signal);
  const pages = cleanPages(extracted.pages);
  const chunks = chunkPages(pages);
  if (!chunks.length) throw new PermanentError('Documento sem texto extraivel (talvez PDF escaneado)', 'no_text');
  if (chunks.length > limits.maxChunks) throw new PermanentError(`${chunks.length} chunks (limite ${limits.maxChunks})`, 'too_large');
  const docStart = pages.map((p) => p.text).join('\n').slice(0, 2000);
  const withCtx: (Chunk & { context: string })[] = [];
  for (const c of chunks) {
    assertNotAborted(opts.signal);
    withCtx.push({
      ...c,
      // padrao: frase deterministica em qualquer provider; LLM so com opt-in (1 chamada de chat por chunk)
      context: opts.llmContext
        ? await chunkContext(llm, c, input.filename, docStart, (u) => {
            usage.contextIn += u.inputTokens;
            usage.contextOut += u.outputTokens;
          })
        : fallbackContext(c, input.filename),
    });
  }
  return {
    chunks: await embedChunks(llm, withCtx, { ...opts, onUsage: (u) => void (usage.embedIn += u.inputTokens) }),
    pageCount: extracted.pageCount,
    tokens: chunks.reduce((a, c) => a + c.tokenCount, 0),
    usage,
    embeddingModel: llm.embeddingModel ?? null,
  };
}
