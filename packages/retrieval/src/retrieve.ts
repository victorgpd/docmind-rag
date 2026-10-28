import { withOrg, type Db } from '@docmind/db';
import type { LLMProvider, Reranker } from '@docmind/llm';
import { DEFAULT_RANK, rankPassages, type RankConfig, type Ranked } from './rank';
import { hybridSearch } from './search';

export type RetrieveDeps = { db: Db; llm: LLMProvider; reranker: Reranker; rank?: RankConfig };

/**
 * Busca híbrida + ranking por interpolação. Único caminho de recuperação: chat, agente e evals usam este.
 * `embedding` evita embedar de novo quando o chamador já tem o vetor da pergunta (cache semântico).
 */
export async function retrieve(
  deps: RetrieveDeps,
  q: { orgId: string; query: string; collectionId?: string | null; documentIds?: string[]; embedding?: number[]; topK?: number; timings?: Record<string, number> },
): Promise<Ranked> {
  const cfg = deps.rank ?? DEFAULT_RANK;
  const t0 = performance.now();
  const embedding = q.embedding ?? (await deps.llm.embed([q.query]))[0]!;
  if (q.timings) q.timings.embed = performance.now() - t0;
  const found = await withOrg(deps.db, q.orgId, (tx) =>
    hybridSearch(tx, {
      embedding,
      text: q.query,
      collectionId: q.collectionId,
      documentIds: q.documentIds,
      embeddingModel: deps.llm.embeddingModel, // só vetores do mesmo modelo da consulta entram na parte vetorial
      timings: q.timings,
    }),
  );
  const t1 = performance.now();
  const ranked = await rankPassages(deps.reranker, q.query, found, q.topK ? { ...cfg, topK: q.topK } : cfg);
  if (q.timings) q.timings.rank = performance.now() - t1;
  return ranked;
}
