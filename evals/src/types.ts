export type Category = 'literal' | 'parafrase' | 'sinonimo_sigla' | 'nome_proprio' | 'sem_resposta';
/** doc/snippet nulos = pergunta sem resposta no corpus (o sistema deve dizer que nao encontrou). */
export type Question = {
  id: string;
  category: Category;
  question: string;
  answer: string;
  doc: string | null;
  snippet: string | null;
};
export type CorpusDoc = { name: string; text: string };
export type Hit = { id: string; doc: string; text: string };

/** Fronteira com o RAG. Implementacao atual: adapter.ts, sobre @docmind/ingest + @docmind/retrieval. */
export interface RagAdapter {
  ingest(docs: CorpusDoc[]): Promise<void>;
  /** Recuperacao do pipeline (mesma funcao do chat), sem corte de abstencao: base do recall. relevance = score do rerank no melhor trecho (o que o limiar compara). */
  search(query: string, opts: { rerank: boolean }): Promise<{ hits: Hit[]; relevance: number }>;
  /** passages = lista numerada enviada ao gerador (vazia se o pipeline se absteve); passages[n-1] e a fonte de [n]. */
  generate(question: string, opts: { rerank: boolean }): Promise<{ answer: string; passages: Hit[] }>;
  saveRun(name: string, metrics: unknown): Promise<void>;
  close(): Promise<void>;
}
