import { asc, chunks, eq, type OrgScope } from '@docmind/db';
import type { Usage } from "@docmind/llm";
import { retrieve, type RetrieveDeps } from './retrieve';

// Tipos estruturais compatíveis com Retriever/ChunkReader de @docmind/agent (sem depender do pacote).
export type AgentHit = { chunkId: string; documentId: string; page: number | null; content: string; score: number; relevance?: number };

/** Retriever do modo agente: mesma busca híbrida + ranking do chat. */
export function createRetriever(deps: RetrieveDeps) {
  return {
    async search(
      orgId: string,
      q: { query: string; collectionId?: string | undefined; documentIds?: string[] | undefined; topK?: number | undefined; onUsage?: ((u: Usage) => void) | undefined },
    ): Promise<AgentHit[]> {
      const { passages, relevance } = await retrieve(deps, { orgId, query: q.query, collectionId: q.collectionId, documentIds: q.documentIds, topK: q.topK, onUsage: q.onUsage });
      // score decrescente pela posição (o agente só usa a ordem); `relevance` é a do melhor trecho da busca, igual em todos os hits:
      // o agente a compara com o mesmo minRelevance do chat para abster-se (o adapter não corta)
      return passages.map((p, i) => ({ chunkId: p.id, documentId: p.documentId, page: p.page, content: p.content, score: passages.length - i, relevance }));
    },
  };
}

/** Chunks de um documento em ordem de leitura. */
export function createChunkReader({ scope }: { scope: OrgScope }) {
  return {
    async get(orgId: string, documentId: string, limit = 40): Promise<AgentHit[]> {
      const rows = await scope(orgId, (tx) =>
        tx.select().from(chunks).where(eq(chunks.documentId, documentId)).orderBy(asc(chunks.ordinal)).limit(limit),
      );
      return rows.map((c) => ({ chunkId: c.id, documentId: c.documentId, page: c.page, content: c.content, score: 0 }));
    },
  };
}
