import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenAIError, OpenAIProvider, createLLM, maskSecrets, modelPricing, estimateCost } from './index';

const KEY = 'sk-test-ABCDEFGHIJKLMNOP1234';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sse = (lines: string[], chunkSize = 7) => {
  const bytes = new TextEncoder().encode(lines.join('\n'));
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize)); // corta no meio das linhas
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

const drain = async (it: AsyncIterable<string>) => {
  let s = '';
  for await (const d of it) s += d;
  return s;
};

type Call = { url: string; init: RequestInit; body: any };
function mock(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call = { url, init, body: JSON.parse(String(init.body)) };
    calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason;
    return handler(call, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const make = (fetchFn: typeof fetch, o: object = {}) => new OpenAIProvider({ apiKey: KEY, fetch: fetchFn, retryBaseMs: 0, ...o });
const embedding = (i: number) => ({ index: i, embedding: new Array(384).fill(i + 1) });

describe('openai embeddings', () => {
  it('batches ≤100 texts, sends dimensions=384 and keeps order and usage', async () => {
    const { calls, fetchFn } = mock((c) => json({ data: c.body.input.map((_: string, i: number) => embedding(i)).reverse(), usage: { prompt_tokens: c.body.input.length } }));
    const used: number[] = [];
    const out = await make(fetchFn).embed(Array.from({ length: 250 }, (_, i) => `t${i}`), { onUsage: (u) => used.push(u.inputTokens) });
    expect(calls.map((c) => c.body.input.length)).toEqual([100, 100, 50]);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]!.body).toMatchObject({ model: 'text-embedding-3-small', dimensions: 384 });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(out).toHaveLength(250);
    expect(out[0]![0]).toBe(1); // reordenado por index apesar da resposta invertida
    expect(out[99]![0]).toBe(100);
    expect(used).toEqual([250]);
  });

  it('rejects vectors with the wrong dimension', async () => {
    const { fetchFn } = mock(() => json({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    await expect(make(fetchFn).embed(['a'])).rejects.toThrow(/384/);
  });

  it('falls back to native size + truncate + L2-normalize when the API rejects dimensions, and remembers it', async () => {
    const native = (n: number) => ({ index: 0, embedding: Array.from({ length: 1536 }, (_, k) => (k < 384 ? 3 : 100) * (n + 1)) });
    const { calls, fetchFn } = mock((c) =>
      'dimensions' in c.body ? json({ error: { message: "This model does not support specifying dimensions." } }, 400) : json({ data: [native(0)] }),
    );
    const p = make(fetchFn);
    const [v] = await p.embed(['a']);
    expect(v).toHaveLength(384);
    expect(Math.hypot(...v!)).toBeCloseTo(1, 6);
    expect(v![0]).toBeCloseTo(1 / Math.sqrt(384), 6); // só os 384 primeiros valores contam
    expect(calls.map((c) => 'dimensions' in c.body)).toEqual([true, false]);
    await p.embed(['b']);
    expect(calls.map((c) => 'dimensions' in c.body)).toEqual([true, false, false]); // lembrou: sem nova tentativa com dimensions
  });

  it('does not truncate for models outside the text-embedding-3 family, nor on unrelated 400s', async () => {
    const dimErr = mock(() => json({ error: { message: 'dimensions not supported' } }, 400));
    await expect(make(dimErr.fetchFn, { embedModel: 'text-embedding-ada-002' }).embed(['a'])).rejects.toThrow(/400/);
    expect(dimErr.calls).toHaveLength(1);
    const other = mock(() => json({ error: { message: 'bad input' } }, 400));
    await expect(make(other.fetchFn).embed(['a'])).rejects.toThrow(/400/);
    expect(other.calls).toHaveLength(1);
  });

  it('honors a custom base URL and models', async () => {
    const { calls, fetchFn } = mock((c) => json({ data: c.body.input.map((_: string, i: number) => embedding(i)) }));
    await make(fetchFn, { baseUrl: 'http://proxy.local/v1/', embedModel: 'text-embedding-3-large' }).embed(['a']);
    expect(calls[0]!.url).toBe('http://proxy.local/v1/embeddings');
    expect(calls[0]!.body.model).toBe('text-embedding-3-large');
  });
});

describe('openai chat stream', () => {
  const lines = [
    'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"O prazo é 5 dias "}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"[1]."}}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":9}}',
    '',
    'data: [DONE]',
    '',
  ];

  it('streams deltas across split chunks, requests usage, passes the cited prompt unchanged', async () => {
    const { calls, fetchFn } = mock(() => sse(lines));
    const messages = [{ role: 'user' as const, content: '<trechos>\n[1] O prazo é 5 dias.\n</trechos>\n\nPergunta: prazo?' }];
    let usage: unknown;
    let text = '';
    for await (const d of make(fetchFn).generateStream(messages, { onUsage: (u) => (usage = u) })) text += d;
    expect(text).toBe('O prazo é 5 dias [1].');
    expect(usage).toEqual({ inputTokens: 42, outputTokens: 9 });
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-4o-mini', stream: true, stream_options: { include_usage: true }, messages });
    expect(calls[0]!.body).not.toHaveProperty('temperature'); // padrão da API, como em produção
  });

  it('sends temperature only when configured (evals fix 0)', async () => {
    const { calls, fetchFn } = mock(() => sse(lines));
    await drain(make(fetchFn, { temperature: 0 }).generateStream([{ role: 'user', content: 'x' }]));
    expect(calls[0]!.body.temperature).toBe(0);
  });

  it('aborts: before the request and in the middle of the stream', async () => {
    const pre = new AbortController();
    pre.abort(new Error('cancelled'));
    const { fetchFn } = mock(() => sse(lines));
    await expect(drain(make(fetchFn).generateStream([], { signal: pre.signal }))).rejects.toThrow('cancelled');

    const mid = new AbortController();
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const d of make(fetchFn).generateStream([], { signal: mid.signal })) {
          got.push(d);
          mid.abort(new Error('stop'));
        }
      })(),
    ).rejects.toThrow('stop');
    expect(got).toHaveLength(1);
  });
});

describe('openai retries and errors', () => {
  it('retries 429 then succeeds', async () => {
    const { calls, fetchFn } = mock((_c, n) => (n === 1 ? json({ error: { message: 'slow down' } }, 429, { 'retry-after': '0' }) : json({ data: [embedding(0)] })));
    expect(await make(fetchFn).embed(['a'])).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 429 caused by missing credits (insufficient_quota)', async () => {
    const { calls, fetchFn } = mock(() => json({ error: { message: 'You have no credits remaining.', code: 'insufficient_quota' } }, 429));
    const err = await make(fetchFn).embed(['a']).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message).toContain('no credits');
    expect(calls).toHaveLength(1);
  });

  it('retries 5xx up to maxRetries, then fails with the status', async () => {
    const { calls, fetchFn } = mock(() => json({ error: { message: 'boom' } }, 503));
    const err = await make(fetchFn, { maxRetries: 2 }).embed(['a']).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAIError);
    expect(err.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it('does not retry 401 and never leaks the key (not even the partial one OpenAI echoes)', async () => {
    const { calls, fetchFn } = mock(() => json({ error: { message: `Incorrect API key provided: ${KEY.slice(0, 12)}****1234. You can find your API key at ...` } }, 401));
    const err = await make(fetchFn).embed(['a']).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err.status).toBe(401);
    const shown = `${err.message}\n${err.stack}\n${inspect(err)}`;
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain(KEY.slice(0, 12));
    expect(shown).toContain('401');
  });

  it('times out slow requests', async () => {
    const slow = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(make(slow, { timeoutMs: 10, maxRetries: 0 }).embed(['a'])).rejects.toThrow(/timed out/);
  });

  it('maskSecrets removes the configured key and key-shaped tokens', () => {
    expect(maskSecrets(`bad ${KEY} and sk-proj-abcdef123456`, KEY)).toBe('bad sk-*** and sk-***');
  });
});

describe('openai generateObject, secrecy and cost', () => {
  it('uses JSON mode, validates with zod and reports usage', async () => {
    const { calls, fetchFn } = mock(() => json({ choices: [{ message: { content: '```json\n{"n": 3}\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
    let usage: unknown;
    const r = await make(fetchFn).generateObject(z.object({ n: z.number() }), [{ role: 'user', content: 'x' }], { onUsage: (u) => (usage = u) });
    expect(r).toEqual({ n: 3 });
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    const bad = mock(() => json({ choices: [{ message: { content: '{"n":"x"}' } }] }));
    await expect(make(bad.fetchFn).generateObject(z.object({ n: z.number() }), [])).rejects.toThrow();
  });

  it('keeps the key out of JSON.stringify/inspect of the provider and requires it in createLLM', () => {
    const p = make(mock(() => json({})).fetchFn);
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(inspect(p, { depth: 5 })).not.toContain(KEY);
    expect(() => createLLM({ provider: 'openai' }, { OPENAI_API_KEY: KEY })).toThrow(/OPENAI_API_KEY/); // nunca lê a chave do ambiente
    expect(createLLM({ provider: 'openai', openaiApiKey: KEY }).name).toBe('openai');
    expect(() => new OpenAIProvider({ apiKey: '' })).toThrow();
  });

  it('prices real usage with the model table and env override', () => {
    const chat = modelPricing('gpt-4o-mini', {});
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, chat)).toBeCloseTo(0.75, 6);
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, modelPricing('gpt-4o-mini', { LLM_PRICE_IN_PER_1M: '1', LLM_PRICE_OUT_PER_1M: '2' }))).toBe(1);
    expect(modelPricing('desconhecido', {})).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });
});
