import type { z } from 'zod';
import type { Usage } from './cost';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Opções opcionais por chamada: cancelamento e consumo real de tokens (providers locais ignoram). */
export type CallOptions = { signal?: AbortSignal; onUsage?: (u: Usage) => void };

export interface LLMProvider {
  readonly name: string;
  /** Dimensao fixa dos embeddings (384 para o schema do banco). */
  readonly dims: number;
  /** Identifica quem gerou os vetores (ex.: `openai:text-embedding-3-small:384`). Vetores de ids diferentes não são comparáveis: reindexe ao mudar. */
  readonly embeddingModel?: string;
  embed(texts: string[], opts?: CallOptions): Promise<number[][]>;
  generateStream(messages: ChatMessage[], opts?: CallOptions): AsyncIterable<string>;
  generateObject<T>(schema: z.ZodType<T>, messages: ChatMessage[], opts?: CallOptions): Promise<T>;
}

export type RerankCandidate = { id: string; text: string; score?: number };
export interface Reranker {
  rerank(query: string, candidates: RerankCandidate[], topK?: number): Promise<RerankCandidate[]>;
}
