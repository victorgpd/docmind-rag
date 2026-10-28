import type { LLMProvider } from '@docmind/llm';
import { describe, expect, it } from 'vitest';
import { embedChunks, ingest, MAX_EMBED_BATCH } from './index';
import { errorCode, PermanentError, userMessage, USER_MESSAGES } from './types';

const enc = (s: string) => new TextEncoder().encode(s);

/** Provedor externo falso (name 'openai'): registra lotes, informa tokens como a API real e nunca faz rede. */
function fakeExternal(opts: { embedError?: Error } = {}) {
  const calls: number[] = [];
  const chat = { calls: 0 };
  const llm: LLMProvider = {
    name: 'openai',
    dims: 384,
    embeddingModel: 'openai:fake-embed:384',
    async embed(texts, o) {
      calls.push(texts.length);
      if (opts.embedError) throw opts.embedError;
      o?.onUsage?.({ inputTokens: texts.length * 10, outputTokens: 0 });
      return texts.map(() => new Array<number>(384).fill(0));
    },
    async *generateStream(_m, o) {
      chat.calls++;
      o?.onUsage?.({ inputTokens: 50, outputTokens: 5 });
      yield 'Trecho que situa o documento.';
    },
    async generateObject() {
      throw new Error('nao usado');
    },
  };
  return { llm, calls, chat };
}

// 150 paragrafos de ~2000 caracteres (~500 tokens): um chunk cada
const bigText = Array.from({ length: 150 }, (_, i) => `P${i} ${'palavra '.repeat(250)}`).join('\n\n');

describe('provedor externo (falso)', () => {
  it('respeita o limite de 100 textos por chamada mesmo pedindo lotes maiores', async () => {
    const { llm, calls } = fakeExternal();
    const r = await ingest({ data: enc(bigText), mimeType: 'text/plain', filename: 'g.txt' }, llm, { batchSize: 1000 });
    expect(r.chunks.length).toBeGreaterThan(100);
    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls)).toBeLessThanOrEqual(MAX_EMBED_BATCH);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(r.chunks.length);
  });

  it('devolve os tokens reais (embedding e contexto) e o modelo de embedding', async () => {
    const { llm, chat } = fakeExternal();
    const r = await ingest({ data: enc('Primeiro paragrafo.\n\nSegundo paragrafo.'), mimeType: 'text/plain', filename: 'a.txt' }, llm, { llmContext: true });
    const n = r.chunks.length;
    expect(r.usage).toEqual({ embedIn: n * 10, contextIn: n * 50, contextOut: n * 5 });
    expect(r.embeddingModel).toBe('openai:fake-embed:384');
    expect(chat.calls).toBe(n);
  });

  it('contexto por LLM e opt-in: por padrao 0 chamadas de chat (deterministico), com a flag 1 por chunk, embeddings sempre em lote', async () => {
    const input = { data: enc(bigText), mimeType: 'text/plain', filename: 'g.txt' };

    const off = fakeExternal();
    const r0 = await ingest(input, off.llm);
    expect(off.chat.calls).toBe(0);
    expect(r0.usage).toMatchObject({ contextIn: 0, contextOut: 0 });
    expect(r0.chunks[0]!.context).toBe('Documento "g.txt".');
    expect(Math.max(...off.calls)).toBeLessThanOrEqual(MAX_EMBED_BATCH);

    const on = fakeExternal();
    const r1 = await ingest(input, on.llm, { llmContext: true });
    expect(on.chat.calls).toBe(r1.chunks.length);
    expect(r1.chunks[0]!.context).toBe('Trecho que situa o documento.');
    expect(on.calls.length).toBe(off.calls.length); // mesma quantidade de lotes de embedding
  });

  it('falha do provedor nao e repetida aqui (ele ja faz backoff) e nao vaza o detalhe', async () => {
    const { llm, calls } = fakeExternal({ embedError: new Error('openai /embeddings 429: quota (key sk-segredo-123)') });
    const err = await ingest({ data: enc('algum texto'), mimeType: 'text/plain', filename: 'a.txt' }, llm, { baseMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(errorCode(err)).toBe('provider_error');
    expect(calls).toHaveLength(1); // sem 4 tentativas empilhadas sobre o retry do provedor
    expect(userMessage(err)).toBe(USER_MESSAGES.provider_error);
    expect(userMessage(err)).not.toMatch(/sk-|429|quota/);
  });

  it('job cancelado por tempo vira timeout, nao provider_error', async () => {
    const ac = new AbortController();
    const { llm } = fakeExternal({ embedError: new Error('aborted') });
    const chunks = [{ ordinal: 0, page: null, section: null, content: 'x', tokenCount: 1, context: 'c' }];
    ac.abort();
    await expect(embedChunks(llm, chunks, { signal: ac.signal })).rejects.toMatchObject({ code: 'timeout' });
  });
});
