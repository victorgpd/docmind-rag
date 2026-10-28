import { loadConfig, type Config } from '@docmind/config';
import { tokenize, type Reranker } from '@docmind/llm';
import type { Passage } from './citations';

export type RankConfig = {
  /** Pesos da interpolação (min-max por consulta) entre rerank lexical, similaridade vetorial e RRF. */
  weights: { rerank: number; sim: number; rrf: number };
  /** Abaixo deste `relevance` do melhor trecho a resposta é NO_ANSWER. 0 desliga a abstenção. */
  minRelevance: number;
  topK: number;
};

type RagFields = Pick<Config, 'RAG_MIN_RELEVANCE' | 'RAG_W_RERANK' | 'RAG_W_SIM' | 'RAG_W_RRF' | 'RAG_TOP_K'>;

/**
 * Converte os campos RAG_* da config (valores, validação e calibração em packages/config). Sem argumento lê o
 * ambiente via loadConfig. shortcut: a escala de minRelevance é a do LocalReranker; recalibre ao trocar de reranker.
 */
export function rankConfigFromEnv(config: RagFields = loadConfig()): RankConfig {
  return {
    weights: { rerank: config.RAG_W_RERANK, sim: config.RAG_W_SIM, rrf: config.RAG_W_RRF },
    minRelevance: config.RAG_MIN_RELEVANCE,
    topK: config.RAG_TOP_K,
  };
}

/** Defaults de @docmind/config (loadConfig({}) não lê o ambiente): fonte única, sem constantes duplicadas aqui. */
export const DEFAULT_RANK: RankConfig = rankConfigFromEnv(loadConfig({}));

const norm = (xs: number[]) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0.5));
};

/**
 * Cobertura dos termos da pergunta no trecho, ponderada pela raridade do termo entre os candidatos
 * (termo presente em todos, como "qual" ou "de", pesa quase 0; termo que nenhum candidato tem pesa muito).
 */
export function coverage(query: string, top: Passage, candidates: Passage[]): number {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return 0;
  const sets = candidates.map((c) => new Set(tokenize(c.content)));
  const topSet = new Set(tokenize(top.content));
  let hit = 0;
  let total = 0;
  for (const t of terms) {
    const df = sets.reduce((n, s) => n + (s.has(t) ? 1 : 0), 0);
    const w = Math.log((candidates.length + 1) / (df + 0.5));
    total += w;
    if (topSet.has(t)) hit += w;
  }
  return total > 0 ? hit / total : 0;
}

export type Ranked = {
  passages: Passage[];
  /** Relevância absoluta [0..1] do melhor trecho; compare com `minRelevance`. */
  relevance: number;
  /** `rerank` é null quando o reranker não devolve score (sem sinal absoluto: não há abstenção). */
  signals: { sim: number; coverage: number; rerank: number | null };
};

/** Relevância absoluta do melhor trecho: o score do reranker; sem score, 1 (não abstém). */
export const relevanceOf = (s: Ranked['signals']) => s.rerank ?? 1;

/**
 * Reordena os candidatos por interpolação ponderada (rerank + similaridade + RRF) em vez de deixar o rerank
 * lexical substituir a ordem da fusão híbrida, e mede a relevância absoluta do melhor trecho.
 */
export async function rankPassages(reranker: Reranker, query: string, found: Passage[], cfg: RankConfig = DEFAULT_RANK): Promise<Ranked> {
  if (!found.length) return { passages: [], relevance: 0, signals: { sim: 0, coverage: 0, rerank: 0 } };
  const reranked = await reranker.rerank(query, found.map((p) => ({ id: p.id, text: p.content })), found.length);
  const scored = reranked.some((r) => r.score !== undefined);
  const scores = new Map(reranked.map((r) => [r.id, r.score ?? 0]));
  const R = norm(found.map((p) => scores.get(p.id) ?? 0));
  const S = norm(found.map((p) => p.sim ?? 0));
  const F = norm(found.map((p) => p.rrf ?? 0));
  const w = cfg.weights;
  const ordered = found
    .map((p, i) => ({ p, s: w.rerank * R[i]! + w.sim * S[i]! + w.rrf * F[i]! }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
  const best = ordered[0]!;
  const signals = { sim: Math.max(0, best.sim ?? 0), coverage: coverage(query, best, found), rerank: scored ? (scores.get(best.id) ?? 0) : null };
  return { passages: ordered.slice(0, cfg.topK), relevance: relevanceOf(signals), signals };
}
