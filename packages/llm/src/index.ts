import { LocalProvider } from './local';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';
import { LocalReranker, type RerankerOptions } from './rerank';
import type { LLMProvider, Reranker } from './types';

export * from './types';
export { LocalProvider, extractiveAnswer, NO_ANSWER } from './local';
export { OllamaProvider } from './ollama';
export { OpenAIProvider, OpenAIError, maskSecrets, type OpenAIOptions } from './openai';
export { LocalReranker, type RerankerOptions } from './rerank';
export { DEFAULT_SYNONYMS, type SynonymGroups } from './synonyms';
export { hashEmbed, cosine, DIMS } from './embed';
export { tokenize, countTokens, extractJson } from './text';
export { estimateCost, pricingFor, modelPricing, PRICES_VERIFIED_AT, FREE, type Pricing, type Usage } from './cost';

export type LLMOptions = {
  provider?: 'local' | 'ollama' | 'openai';
  ollamaUrl?: string;
  ollamaModel?: string;
  ollamaEmbedModel?: string;
  /** Só via packages/config (OPENAI_API_KEY); createLLM nunca lê a chave do ambiente. */
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiEmbedModel?: string;
  openaiChatModel?: string;
};

/** Sem opts, lê LLM_PROVIDER / OLLAMA_URL / OLLAMA_MODEL / OLLAMA_EMBED_MODEL do ambiente. */
export function createLLM(opts: LLMOptions = {}, env: Record<string, string | undefined> = process.env): LLMProvider {
  const provider = opts.provider ?? (env.LLM_PROVIDER === 'ollama' || env.LLM_PROVIDER === 'openai' ? env.LLM_PROVIDER : 'local');
  if (provider === 'openai') {
    if (!opts.openaiApiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY (via loadConfig)');
    return new OpenAIProvider({ apiKey: opts.openaiApiKey, baseUrl: opts.openaiBaseUrl, embedModel: opts.openaiEmbedModel, chatModel: opts.openaiChatModel });
  }
  if (provider === 'ollama') {
    const url = opts.ollamaUrl ?? env.OLLAMA_URL;
    if (!url) throw new Error('LLM_PROVIDER=ollama requires OLLAMA_URL');
    return new OllamaProvider(
      url,
      opts.ollamaModel ?? env.OLLAMA_MODEL ?? 'llama3.2',
      opts.ollamaEmbedModel ?? env.OLLAMA_EMBED_MODEL ?? 'all-minilm',
    );
  }
  return new LocalProvider();
}

/** Atalho para o objeto de packages/config (estrutural: llm não depende de config). */
export function createLLMFromConfig(c: {
  LLM_PROVIDER: 'local' | 'ollama' | 'openai';
  OLLAMA_URL?: string | undefined;
  OLLAMA_MODEL?: string;
  OLLAMA_EMBED_MODEL?: string;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_BASE_URL?: string;
  OPENAI_EMBED_MODEL?: string;
  OPENAI_CHAT_MODEL?: string;
}): LLMProvider {
  return createLLM({
    provider: c.LLM_PROVIDER,
    ollamaUrl: c.OLLAMA_URL,
    ollamaModel: c.OLLAMA_MODEL,
    ollamaEmbedModel: c.OLLAMA_EMBED_MODEL,
    openaiApiKey: c.OPENAI_API_KEY,
    openaiBaseUrl: c.OPENAI_BASE_URL,
    openaiEmbedModel: c.OPENAI_EMBED_MODEL,
    openaiChatModel: c.OPENAI_CHAT_MODEL,
  });
}

export function createReranker(opts?: RerankerOptions): Reranker {
  return new LocalReranker(opts);
}
