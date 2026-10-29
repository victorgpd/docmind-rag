import { sql, type OrgScope } from '@docmind/db';

/** Valor de `warnings` quando há chunks de outro modelo de embedding (ou desconhecido) no escopo da busca. */
export const REINDEX_NEEDED = 'reindex_needed';

const TTL_MS = 60_000;
const memo = new Map<string, { at: number; stale: boolean }>();
const key = (orgId: string, collectionId: string | null | undefined, model: string) => `${orgId}:${collectionId ?? '*'}:${model}`;

/**
 * Há chunks (da coleção, ou da org inteira sem coleção) cujo embedding_model difere do modelo ativo? Nesse caso a parte
 * vetorial da busca os ignora e o usuário precisa reindexar. NULL (desconhecido) conta como diferente.
 * Sem `embeddingModel` (provider que não declara) não há como comparar: false.
 * shortcut: `exists` sem índice em embedding_model varre o escopo; por isso o resultado fica 60 s em memória do processo
 * e é descartado por `invalidate` (documento ficou ready/foi excluído). Em escala, indexar chunks(organization_id, embedding_model).
 */
export async function hasStaleEmbeddings(
  scope: OrgScope,
  { orgId, collectionId, embeddingModel }: { orgId: string; collectionId?: string | null; embeddingModel?: string },
  now = Date.now(),
): Promise<boolean> {
  if (!embeddingModel) return false;
  const k = key(orgId, collectionId, embeddingModel);
  const hit = memo.get(k);
  if (hit && now - hit.at < TTL_MS) return hit.stale;
  const stale = await scope(orgId, async (tx) => {
    const col = collectionId ? sql`and collection_id = ${collectionId}` : sql``;
    const r: any = await tx.execute(sql`select 1 as x from chunks where embedding_model is distinct from ${embeddingModel} ${col} limit 1`);
    return (r.rows ?? r).length > 0;
  });
  memo.set(k, { at: now, stale });
  return stale;
}

/** Descarta o memo da organização (todas as coleções e modelos). */
export function clearStaleMemo(orgId: string): void {
  for (const k of memo.keys()) if (k.startsWith(`${orgId}:`)) memo.delete(k);
}
