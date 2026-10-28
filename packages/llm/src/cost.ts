export type Pricing = { inputPer1M: number; outputPer1M: number };
export type Usage = { inputTokens: number; outputTokens: number };

export const FREE: Pricing = { inputPer1M: 0, outputPer1M: 0 };

/** Preço em USD por 1M de tokens; `local` é sempre 0. Configurável via LLM_PRICE_IN_PER_1M / LLM_PRICE_OUT_PER_1M. */
export function pricingFor(provider: string, env: Record<string, string | undefined> = process.env): Pricing {
  if (provider === 'local') return FREE;
  return {
    inputPer1M: Number(env.LLM_PRICE_IN_PER_1M) || 0,
    outputPer1M: Number(env.LLM_PRICE_OUT_PER_1M) || 0,
  };
}

// USD por 1M de tokens. Verificado em 2026-10-28 por consulta de developers.openai.com/api/docs/pricing.
// Preços mudam: reconfira e atualize a data. gpt-4o-mini segue como padrão (conhecido, aceita temperature/stream);
// os modelos mais novos abaixo são opção via OPENAI_CHAT_MODEL, sem teste real neste repo.
export const PRICES_VERIFIED_AT = '2026-10-28';
const MODEL_PRICES: Record<string, Pricing> = {
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-5-nano': { inputPer1M: 0.05, outputPer1M: 0.4 },
  'gpt-5-mini': { inputPer1M: 0.25, outputPer1M: 2 },
  'gpt-6-luna': { inputPer1M: 0.1, outputPer1M: 0.5 },
  'text-embedding-3-small': { inputPer1M: 0.02, outputPer1M: 0 },
  'text-embedding-3-large': { inputPer1M: 0.13, outputPer1M: 0 }, // não reverificado em 2026-10-28
};

/** Preço de um modelo: LLM_PRICE_IN_PER_1M/OUT (se definidos) vencem a tabela; modelo desconhecido = 0. */
export function modelPricing(model: string, env: Record<string, string | undefined> = process.env): Pricing {
  const base = MODEL_PRICES[model] ?? FREE;
  const inp = env.LLM_PRICE_IN_PER_1M;
  const out = env.LLM_PRICE_OUT_PER_1M;
  return { inputPer1M: inp ? Number(inp) || 0 : base.inputPer1M, outputPer1M: out ? Number(out) || 0 : base.outputPer1M };
}

export function estimateCost(usage: Usage, pricing: Pricing = FREE): number {
  return (usage.inputTokens * pricing.inputPer1M + usage.outputTokens * pricing.outputPer1M) / 1_000_000;
}
