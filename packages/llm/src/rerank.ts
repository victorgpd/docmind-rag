import { cosine, hashEmbed } from './embed';
import { DEFAULT_SYNONYMS, compileSynonyms, expandQuery, type SynonymGroups } from './synonyms';
import { contentTokens } from './text';
import type { RerankCandidate, Reranker } from './types';

export type RerankerOptions = {
  /** Grupos de siglas/sinônimos; [] desliga a expansão. */
  synonyms?: SynonymGroups;
  weights?: { lexical: number; cosine: number; prior: number };
};

const DEFAULT_WEIGHTS = { lexical: 0.5, cosine: 0.4, prior: 0.1 };
const K1 = 1.2;
const SYNONYM_WEIGHT = 0.5;

/**
 * Score absoluto em [0,1] (não normaliza pelo melhor candidato, para que um acerto lexical fraco não vire 1.0):
 * cobertura lexical dos termos da consulta (saturação BM25, pesos idf, sinônimos/siglas com peso menor)
 * + cosseno do embedding da consulta expandida + score prévio (se houver).
 */
export class LocalReranker implements Reranker {
  private groups;
  private w;
  constructor(opts: RerankerOptions = {}) {
    this.groups = compileSynonyms(opts.synonyms ?? DEFAULT_SYNONYMS);
    this.w = opts.weights ?? DEFAULT_WEIGHTS;
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = candidates.length) {
    if (!candidates.length) return [];
    const q = [...new Set(contentTokens(query))];
    const exp = expandQuery(query, this.groups);
    const terms = [...q.map((t) => ({ t, w: 1 })), ...exp.tokens.map((t) => ({ t, w: SYNONYM_WEIGHT }))];
    const docs = candidates.map((c) => contentTokens(c.text));
    const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    // idf com piso: poucos candidatos tornam o idf instável
    const idf = (t: string) => Math.max(0.3, Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5)));
    const total = terms.reduce((a, x) => a + x.w * idf(x.t), 0) || 1;
    const qv = hashEmbed(`${query} ${exp.text}`);
    const maxPrior = Math.max(0, ...candidates.map((c) => c.score ?? 0)) || 1;
    return candidates
      .map((c, i) => {
        const d = docs[i]!;
        const norm = 0.25 + (0.75 * d.length) / avg;
        let lex = 0;
        for (const { t, w } of terms) {
          const tf = d.filter((x) => x === t).length;
          lex += (w * idf(t) * tf) / (tf + K1 * norm);
        }
        // tf/(tf+k1*norm) < 1: reescala pelo valor de um termo presente uma vez em doc de tamanho médio
        const lexical = Math.min(1, (lex / total) * (1 + K1));
        const score =
          this.w.lexical * lexical +
          this.w.cosine * Math.max(0, cosine(qv, hashEmbed(c.text))) +
          this.w.prior * Math.max(0, (c.score ?? 0) / maxPrior);
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
