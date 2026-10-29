import type { AgentDeps } from '@docmind/agent';
import { chunks, collections, createDb, documents, evalRuns, organizations, orgScope, sql, users, type DbHandle } from '@docmind/db';
import { chunkPages, cleanPages, embedChunks, extract, fallbackContext } from '@docmind/ingest';
import { createLLM, createReranker, type CallOptions, type LLMProvider, type Reranker } from '@docmind/llm';
import { createChunkReader, createRag, createRetriever, retrieve, rewriteQuestion, SemanticCache, type RankConfig } from '@docmind/retrieval';
import type { CorpusDoc, Hit, RagAdapter } from './types';

// shortcut: ingest() usa chunks de ~500 tokens, o que faria cada doc de exemplo (~1 KB) virar 1 chunk e o recall
// virar acerto de documento. Aqui usamos as mesmas etapas (extract -> clean -> chunk -> contexto -> embed) com chunks menores.
const CHUNK_TOKENS = 80;

// sem rerank = so a fusao RRF da busca hibrida; com rerank = ranking padrao do pipeline (undefined => DEFAULT_RANK) ou `rank`
const PURE_RRF: RankConfig = { weights: { rerank: 0, sim: 0, rrf: 1 }, minRelevance: 0, topK: 6 };

const noRerank: Reranker = { rerank: async (_q, c, k = c.length) => c.slice(0, k) };
class NoCache<V> extends SemanticCache<V> {
  override get(): V | undefined {
    return undefined; // sem cache semantico: perguntas parecidas nao podem herdar resposta
  }
}

export type LlmUsage = { embedTokens: number; chatIn: number; chatOut: number; embedCalls: number; chatCalls: number };

/**
 * Conta os tokens reais (onUsage) e memoriza o embedding de cada texto: search() e generate() embutem a mesma pergunta,
 * e um provedor remoto pode devolver floats levemente diferentes a cada chamada (mudaria a lista entre as duas).
 */
export function metered(inner: LLMProvider, usage: LlmUsage): LLMProvider {
  const memo = new Map<string, number[]>();
  const chat = (o?: CallOptions): CallOptions => {
    usage.chatCalls++;
    return { ...o, onUsage: (u) => ((usage.chatIn += u.inputTokens), (usage.chatOut += u.outputTokens), o?.onUsage?.(u)) };
  };
  return {
    name: inner.name,
    dims: inner.dims,
    ...(inner.embeddingModel !== undefined && { embeddingModel: inner.embeddingModel }),
    async embed(texts, o) {
      const miss = [...new Set(texts.filter((t) => !memo.has(t)))];
      if (miss.length) {
        usage.embedCalls++;
        const vs = await inner.embed(miss, { ...o, onUsage: (u) => ((usage.embedTokens += u.inputTokens), o?.onUsage?.(u)) });
        miss.forEach((t, i) => memo.set(t, vs[i]!));
      }
      return texts.map((t) => memo.get(t)!);
    },
    generateStream: (m, o) => inner.generateStream(m, chat(o)),
    generateObject: (s, m, o) => inner.generateObject(s, m, chat(o)),
  };
}

/** Pipeline real do DocMind (ingest + hybridSearch + reranker + createRag) sobre PGlite em memoria (ou DATABASE_URL). */
export type AgentEnv = { deps: AgentDeps; docId(name: string): string };

/**
 * `inner`: provider de embeddings e geracao (padrao: createLLM(), o local sem rede). O rerank e sempre o LocalReranker.
 * `rank`: pesos/limiar da config com rerank (padrao: DEFAULT_RANK, os defaults de producao); so a calibracao muda.
 */
export async function createAdapter(
  inner: LLMProvider = createLLM(),
  databaseUrl = process.env.DATABASE_URL,
  rank?: RankConfig,
): Promise<RagAdapter & { agent: AgentEnv; usage: LlmUsage }> {
  const rankFor = (rerank: boolean) => (rerank ? rank : PURE_RRF);
  const handle: DbHandle = await createDb(databaseUrl ? { databaseUrl } : { pgliteDir: ':memory:' });
  await handle.migrate();
  const { db } = handle; // privilegiada: so para semear o corpus; busca e agente usam `scope` (RLS)
  const scope = orgScope(db);
  const usage: LlmUsage = { embedTokens: 0, chatIn: 0, chatOut: 0, embedCalls: 0, chatCalls: 0 };
  const llm = metered(inner, usage);
  const localReranker = createReranker();
  const names = new Map<string, string>(); // documentId -> filename

  const [org] = await db.insert(organizations).values({ name: 'evals', slug: `evals-${Date.now()}` }).returning();
  const orgId = org!.id;
  const [col] = await db.insert(collections).values({ organizationId: orgId, name: 'eval-corpus' }).returning();
  const [user] = await db
    .insert(users)
    .values({ organizationId: orgId, email: `evals-${Date.now()}@docmind.local`, name: 'evals', passwordHash: 'x' })
    .returning();

  const toHit = (p: { id: string; documentId: string; content: string }): Hit => ({
    id: p.id,
    doc: names.get(p.documentId) ?? '?',
    text: p.content,
  });

  const rag = (rerank: boolean) =>
    createRag({ scope, llm, reranker: rerank ? localReranker : noRerank, cache: new NoCache<any>(), ...(rankFor(rerank) && { rank: rankFor(rerank)! }) });

  const adapter: RagAdapter = {
    async ingest(docs: CorpusDoc[]) {
      for (const d of docs) {
        const data = new TextEncoder().encode(d.text);
        const extracted = await extract(data, 'text/markdown', d.name);
        const pages = cleanPages(extracted.pages);
        const parts = chunkPages(pages, { targetTokens: CHUNK_TOKENS });
        // como a producao (INGEST_LLM_CONTEXT=false): frase deterministica em qualquer provider, sem chat na ingestao
        const withCtx = parts.map((c) => ({ ...c, context: fallbackContext(c, d.name) }));
        const embedded = await embedChunks(llm, withCtx);
        const [doc] = await db
          .insert(documents)
          .values({
            organizationId: orgId,
            collectionId: col!.id,
            filename: d.name,
            mimeType: 'text/markdown',
            sizeBytes: data.length,
            storageKey: `${orgId}/${d.name}`,
            status: 'ready',
            pageCount: extracted.pageCount,
          })
          .returning();
        names.set(doc!.id, d.name);
        await db.insert(chunks).values(
          embedded.map((c) => ({
            organizationId: orgId,
            documentId: doc!.id,
            collectionId: col!.id,
            ordinal: c.ordinal,
            page: c.page,
            content: c.content,
            embedding: c.embedding,
            embeddingModel: llm.embeddingModel ?? null, // a busca vetorial filtra pelo modelo do provider ativo
          })),
        );
      }
      // Sem estatisticas o planner usa o HNSW aproximado (grafo aleatorio por build) e o recall "sem rerank" oscila.
      await db.execute(sql`analyze chunks`);
    },
    // Mesma funcao de recuperacao que o createRag usa (retrieve), com a mesma config de ranking.
    async search(question, { rerank }) {
      const query = rewriteQuestion(question, []);
      const r = await retrieve(
        { scope, llm, reranker: rerank ? localReranker : noRerank, rank: rankFor(rerank) },
        { orgId, query, collectionId: col!.id },
      );
      return { hits: r.passages.map(toHit), relevance: r.relevance };
    },
    async generate(question, { rerank }) {
      let answer = '';
      let passages: Hit[] = [];
      for await (const ev of rag(rerank).answer({ orgId, userId: user!.id, collectionId: col!.id, question, history: [] }))
        if (ev.type === 'result') {
          answer = ev.content.trim();
          passages = (ev.passages ?? []).map(toHit); // lista numerada no prompt: passages[n-1] e a fonte de [n]
        }
      return { answer, passages };
    },
    async saveRun(name, metrics) {
      await db.insert(evalRuns).values({ organizationId: orgId, name, metrics });
    },
    close: () => handle.close(),
  };

  // Modo agente sobre o mesmo indice: retriever e leitor de chunks reais do pacote retrieval.
  const agent: AgentEnv = {
    deps: {
      orgId,
      llm,
      retriever: createRetriever({ scope, llm, reranker: localReranker }),
      chunks: createChunkReader({ scope }),
    },
    docId(name) {
      const id = [...names].find(([, n]) => n === name)?.[0];
      if (!id) throw new Error(`documento nao indexado: ${name}`);
      return id;
    },
  };
  return Object.assign(adapter, { agent, usage });
}
