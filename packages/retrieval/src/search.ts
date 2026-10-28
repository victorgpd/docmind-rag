import { sql, type Db } from '@docmind/db';
import type { Passage } from './citations';
import { rrf } from './rrf';

const rowsOf = (r: unknown): any[] => (r as any).rows ?? r;
const toPassage = (r: any): Passage => ({ id: r.id, documentId: r.document_id, page: r.page, content: r.content, sim: Number(r.sim) || 0 });

/** Termos alfanuméricos únicos (seguros para to_tsquery); a busca de texto os une com OR. */
export function tsTerms(text: string): string[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  return [...new Set(words)].slice(0, 20);
}

// ef_search maior quando há filtro: o filtro é aplicado depois da varredura do índice, e com o padrão (40)
// um filtro pouco seletivo devolve menos de N linhas e perde recall (medido: 2,5 linhas e 7% de recall em coleção de 30% da org).
const EF_FILTERED = 100;
let iterativeScan: Promise<boolean> | undefined;
/** pgvector >= 0.8 tem hnsw.iterative_scan; em versões antigas o SET falharia e abortaria a transação. */
const hasIterativeScan = (tx: Db) =>
  (iterativeScan ??= tx
    .execute(sql`select 1 as ok from pg_settings where name = 'hnsw.iterative_scan'`)
    .then((r) => rowsOf(r).length > 0)
    .catch(() => false));

/**
 * Top-N vetorial (pgvector, cosseno) + top-N texto (tsvector), fundidos por RRF. Chamar dentro de withOrg.
 * Com filtro de coleção/documento liga o scan iterativo do HNSW (continua varrendo o índice até achar N linhas que
 * passam no filtro) com ef_search maior; `iterative: false` desliga (para comparar). As configurações valem só na
 * transação de withOrg, que termina logo após a busca. Cada passagem sai com `sim` (cosseno com a pergunta, também para as achadas só pelo texto) e `rrf`.
 * `timings` (opcional) recebe ms por etapa: vector, text, fuse.
 */
export async function hybridSearch(
  tx: Db,
  q: {
    embedding: number[];
    text: string;
    collectionId?: string | null;
    documentIds?: string[];
    /**
     * Modelo de embedding da consulta (LLMProvider.embeddingModel). A parte vetorial só considera chunks desse modelo:
     * vetores de modelos diferentes não são comparáveis. NULL no chunk = modelo desconhecido = fora. A parte de texto
     * (tsvector) não depende de embedding e continua valendo para todos os chunks.
     */
    embeddingModel?: string;
    limit?: number;
    /** Padrão true: scan iterativo + ef_search maior quando há filtro. */
    iterative?: boolean;
    timings?: Record<string, number>;
  },
): Promise<Passage[]> {
  const limit = q.limit ?? 30;
  const colFilter = q.collectionId ? sql`and collection_id = ${q.collectionId}` : sql``;
  const docFilter = q.documentIds?.length
    ? sql`and document_id in (${sql.join(q.documentIds.map((d) => sql`${d}::uuid`), sql`, `)})`
    : sql``;
  const col = sql`${colFilter} ${docFilter}`;
  const vec = `[${q.embedding.join(',')}]`;
  const modelFilter = q.embeddingModel ? sql`and embedding_model = ${q.embeddingModel}` : sql``;
  // chunk de outro modelo achado só pelo texto: cosseno entre modelos diferentes não tem significado, sim = 0
  const simExpr = q.embeddingModel
    ? sql`case when embedding is null or embedding_model is distinct from ${q.embeddingModel} then 0 else 1 - (embedding <=> ${vec}::vector) end`
    : sql`case when embedding is null then 0 else 1 - (embedding <=> ${vec}::vector) end`;
  const lap = (stage: string, t0: number) => {
    if (q.timings) q.timings[stage] = performance.now() - t0;
  };

  let t = performance.now();
  // o filtro de modelo também é aplicado depois da varredura do índice: precisa do scan iterativo como os de coleção/documento
  const filtered = !!q.collectionId || !!q.documentIds?.length || !!q.embeddingModel;
  if (filtered && (q.iterative ?? true) && (await hasIterativeScan(tx))) {
    await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('hnsw.ef_search', ${String(EF_FILTERED)}, true)`);
  }
  // relaxed_order pode devolver fora de ordem: a CTE materializada limita e a consulta externa reordena por distância
  const vecRows = rowsOf(
    await tx.execute(sql`with r as materialized (
        select id, document_id, page, content, embedding <=> ${vec}::vector as dist from chunks
        where embedding is not null ${modelFilter} ${col} order by embedding <=> ${vec}::vector limit ${limit}
      ) select id, document_id, page, content, 1 - dist as sim from r order by dist`),
  );
  lap('vector', t);

  t = performance.now();
  const terms = tsTerms(q.text).join(' | ');
  const txtRows = terms
    ? rowsOf(
        await tx.execute(sql`select id, document_id, page, content,
            ${simExpr} as sim
          from chunks where tsv @@ to_tsquery('simple', ${terms}) ${col}
          order by ts_rank(tsv, to_tsquery('simple', ${terms})) desc limit ${limit}`),
      )
    : [];
  lap('text', t);

  t = performance.now();
  const byId = new Map<string, Passage>();
  for (const r of [...vecRows, ...txtRows]) byId.set(r.id, toPassage(r));
  const fused = rrf([vecRows.map((r) => r.id), txtRows.map((r) => r.id)]).map((f) => ({ ...byId.get(f.id)!, rrf: f.score }));
  lap('fuse', t);
  return fused;
}
