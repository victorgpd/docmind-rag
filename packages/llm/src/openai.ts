import type { z } from 'zod';
import { DIMS } from './embed';
import { extractJson } from './text';
import type { CallOptions, ChatMessage, LLMProvider } from './types';

export type OpenAIOptions = {
  /** Vem de packages/config (OPENAI_API_KEY); nunca lida do ambiente aqui. */
  apiKey: string;
  baseUrl?: string;
  embedModel?: string;
  chatModel?: string;
  /** Omitido = padrão da API (produção). Os evals fixam 0 para reduzir a variância. */
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Atraso base do backoff (ms); os testes usam 0. */
  retryBaseMs?: number;
  /** Injetável para testes. */
  fetch?: typeof fetch;
};

const EMBED_BATCH = 100;
const RETRYABLE = (s: number) => s === 429 || s >= 500;

/** Erro da API sem a chave: mensagem sempre mascarada. */
export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

/** Remove a chave configurada e qualquer token com formato de chave (a OpenAI devolve a chave parcial em 401). */
export function maskSecrets(text: string, apiKey: string): string {
  const masked = apiKey ? text.split(apiKey).join('sk-***') : text;
  return masked.replace(/\bsk-[A-Za-z0-9_*-]{6,}/g, 'sk-***');
}

const normalize = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/**
 * Provider opcional (LLM_PROVIDER=openai) sobre fetch nativo. Embeddings pedem `dimensions: 384` para manter vector(384).
 * Gera texto em streaming (SSE); o contrato de citações [n] vem do prompt montado pelo retrieval e passa sem alteração.
 * Preço/uso: o consumo real de tokens sai por `opts.onUsage` (alimenta estimateCost).
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly dims = DIMS;
  readonly embedModel: string;
  readonly chatModel: string;
  readonly temperature: number | undefined;
  get embeddingModel() {
    return `openai:${this.embedModel}:${this.dims}`;
  }
  #apiKey: string; // privado: fora de JSON.stringify/console.log do objeto
  #base: string;
  #timeoutMs: number;
  #maxRetries: number;
  #retryBaseMs: number;
  #fetch: typeof fetch;

  constructor(o: OpenAIOptions) {
    if (!o.apiKey) throw new Error('OpenAI provider requires OPENAI_API_KEY');
    this.#apiKey = o.apiKey;
    this.#base = (o.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.embedModel = o.embedModel ?? 'text-embedding-3-small';
    this.chatModel = o.chatModel ?? 'gpt-4o-mini';
    this.temperature = o.temperature;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#maxRetries = o.maxRetries ?? 3;
    this.#retryBaseMs = o.retryBaseMs ?? 500;
    this.#fetch = o.fetch ?? fetch;
  }

  #temp = () => (this.temperature === undefined ? {} : { temperature: this.temperature });

  toJSON() {
    return { name: this.name, embedModel: this.embedModel, chatModel: this.chatModel };
  }

  /** POST com timeout até os headers, retry com backoff em 429/5xx/erro de rede, e erros sem a chave. */
  async #post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new OpenAIError(`openai ${path} timed out after ${this.#timeoutMs} ms`)), this.#timeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      let res: Response | undefined;
      let failure: unknown;
      try {
        res = await this.#fetch(`${this.#base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
          body: JSON.stringify(body),
          signal: sig,
        });
      } catch (e) {
        if (signal?.aborted) throw e; // cancelado pelo chamador: sem retry
        failure = e;
      } finally {
        clearTimeout(timer);
      }
      if (res?.ok) return res;
      const status = res?.status;
      // 429 por falta de crédito/quota não é transitório: repetir só atrasa o erro
      const noQuota = res?.status === 429 && /insufficient_quota|no credits|exceeded your current quota/i.test(await this.#errorDetail(res.clone(), true));
      const retryable = res ? RETRYABLE(res.status) && !noQuota : !(failure instanceof OpenAIError);
      if (!retryable || attempt >= this.#maxRetries) {
        const detail = res ? await this.#errorDetail(res) : failure instanceof Error ? failure.message : 'network error';
        throw new OpenAIError(maskSecrets(`openai ${path} ${status ?? 'failed'}: ${detail}`, this.#apiKey), status);
      }
      const retryAfter = Number(res?.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : this.#retryBaseMs * 2 ** attempt, signal);
    }
  }

  async #errorDetail(res: Response, withCode = false): Promise<string> {
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } };
      return withCode ? `${j.error?.code ?? ''} ${j.error?.message ?? ''}` : (j.error?.message ?? j.error?.code ?? res.statusText);
    } catch {
      return res.statusText;
    }
  }

  /**
   * Pede `dimensions: 384`. Se a API recusar o parâmetro (400 citando "dimension"), faz um fallback para a família text-embedding-3
   * (vetores Matryoshka): pede o tamanho nativo, trunca nos primeiros 384 valores e renormaliza (L2) no cliente. O modo fica lembrado.
   */
  #truncate = false;

  async embed(texts: string[], opts: CallOptions = {}): Promise<number[][]> {
    const out: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const request = () =>
        this.#post('/embeddings', { model: this.embedModel, input: batch, ...(this.#truncate ? {} : { dimensions: this.dims }), encoding_format: 'float' }, opts.signal);
      let res: Response;
      try {
        res = await request();
      } catch (e) {
        const canTruncate = e instanceof OpenAIError && e.status === 400 && /dimension/i.test(e.message) && this.embedModel.startsWith('text-embedding-3') && !this.#truncate;
        if (!canTruncate) throw e;
        this.#truncate = true;
        res = await request();
      }
      const j = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
      if (j.data.length !== batch.length) throw new OpenAIError(`openai /embeddings: expected ${batch.length} vectors, got ${j.data.length}`);
      out.push(...[...j.data].sort((a, b) => a.index - b.index).map((d) => this.#fit(d.embedding)));
      tokens += j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? 0;
    }
    opts.onUsage?.({ inputTokens: tokens, outputTokens: 0 });
    return out;
  }

  #fit(v: number[]): number[] {
    if (v.length === this.dims) return v;
    if (this.#truncate && v.length > this.dims) return normalize(v.slice(0, this.dims));
    throw new OpenAIError(`openai /embeddings: expected vectors of ${this.dims} dims, got ${v.length}`);
  }

  async *generateStream(messages: ChatMessage[], opts: CallOptions = {}): AsyncIterable<string> {
    const res = await this.#post('/chat/completions', { model: this.chatModel, ...this.#temp(), messages, stream: true, stream_options: { include_usage: true } }, opts.signal);
    if (!res.body) throw new OpenAIError('openai /chat/completions: empty body');
    const dec = new TextDecoder();
    let buf = '';
    const handle = (line: string): string | undefined => {
      if (!line.startsWith('data:')) return undefined;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return undefined;
      const j = JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } | null };
      if (j.usage) opts.onUsage?.({ inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0 });
      return j.choices?.[0]?.delta?.content ?? undefined;
    };
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop()!;
        for (const l of lines) {
          const piece = handle(l.trim());
          if (piece) yield piece;
        }
      }
      const piece = handle(buf.trim());
      if (piece) yield piece;
    } finally {
      await res.body.cancel().catch(() => undefined); // libera a conexão se o consumidor parar cedo
    }
  }

  async generateObject<T>(schema: z.ZodType<T>, messages: ChatMessage[], opts: CallOptions = {}): Promise<T> {
    // JSON mode exige a palavra "JSON" nas mensagens
    const withHint: ChatMessage[] = [...messages, { role: 'system', content: 'Responda somente com um objeto JSON válido.' }];
    const res = await this.#post('/chat/completions', { model: this.chatModel, ...this.#temp(), messages: withHint, response_format: { type: 'json_object' } }, opts.signal);
    const j = (await res.json()) as { choices: { message: { content: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (j.usage) opts.onUsage?.({ inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0 });
    return schema.parse(extractJson(j.choices[0]?.message.content ?? ''));
  }
}
