import type { ChatMessage, LLMProvider } from '@docmind/llm';

export type Hit = { chunkId: string; documentId: string; page: number | null; content: string; score: number;
  /** Relevancia absoluta [0..1] do melhor trecho da busca (mesma escala de RAG_MIN_RELEVANCE). Ausente = sem corte. */
  relevance?: number;
};

/** Busca hibrida. Stub tipado: packages/retrieval ainda nao existe; trocar pela implementacao real ao chegar. */
export interface Retriever {
  search(
    orgId: string,
    q: { query: string; collectionId?: string | undefined; documentIds?: string[] | undefined; topK?: number | undefined },
  ): Promise<Hit[]>;
}

/** Chunks de um documento em ordem de leitura. */
export interface ChunkReader {
  get(orgId: string, documentId: string, limit?: number): Promise<Hit[]>;
}

export type Passage = { documentId: string; page: number | null; snippet: string };

export type ToolCtx = {
  orgId: string;
  llm: LLMProvider;
  retriever: Retriever;
  chunks: ChunkReader;
  minRelevance: number;
  /** Registra uma passagem e devolve o n global do marcador [n]. */
  cite(p: Passage): number;
  /** Gera texto pelo LLM contando tokens. */
  generate(messages: ChatMessage[]): Promise<string>;
};
