import { estimateCost, modelPricing, OpenAIProvider } from '@docmind/llm';
import type { LlmUsage } from './adapter';

export const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/**
 * --provider local (padrao, sem rede: o do gate de CI) | openai (embeddings + geracao da producao, temperatura 0).
 * A chave vem so do ambiente do processo (ex.: node --env-file=../.env) e nunca e gravada.
 */
export function providerFromArgs(env = process.env) {
  const provider = flag('provider') ?? 'local';
  if (provider !== 'local' && provider !== 'openai') throw new Error(`--provider ${provider}: use local ou openai`);
  const openai =
    provider === 'openai'
      ? new OpenAIProvider({
          apiKey: env.OPENAI_API_KEY ?? '', // vazio => o construtor recusa
          baseUrl: env.OPENAI_BASE_URL || undefined,
          embedModel: env.OPENAI_EMBED_MODEL || undefined,
          chatModel: env.OPENAI_CHAT_MODEL || undefined,
          temperature: 0,
        })
      : undefined;
  return { provider, openai };
}

export const emptyUsage = (): LlmUsage => ({ embedTokens: 0, chatIn: 0, chatOut: 0, embedCalls: 0, chatCalls: 0 });
export const addUsage = (to: LlmUsage, from: LlmUsage) => {
  for (const k of Object.keys(to) as (keyof LlmUsage)[]) to[k] += from[k];
};

/** Precos da tabela do pacote llm (sem override por env): embeddings so entrada, chat entrada/saida. */
export const costUsd = (o: OpenAIProvider, u: LlmUsage) =>
  estimateCost({ inputTokens: u.embedTokens, outputTokens: 0 }, modelPricing(o.embedModel, {})) +
  estimateCost({ inputTokens: u.chatIn, outputTokens: u.chatOut }, modelPricing(o.chatModel, {}));
