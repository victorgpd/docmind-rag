import { LocalProvider, type LLMProvider } from '@docmind/llm';
import { describe, expect, it, vi } from 'vitest';
import { embedChunks, ingest, withRetry } from './index';
import { PermanentError } from './types';

const enc = (s: string) => new TextEncoder().encode(s);

describe('ingest', () => {
  it('txt -> chunks com contexto e embedding de 384 dims', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragrafo ${i} sobre prazos de entrega e multas contratuais aplicaveis.`).join('\n\n');
    const r = await ingest({ data: enc(text), mimeType: 'text/plain', filename: 'a.txt' }, new LocalProvider());
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks[0]!.embedding).toHaveLength(384);
    expect(r.chunks[0]!.context).toContain('a.txt');
  });

  it('documento sem texto e erro permanente', async () => {
    await expect(ingest({ data: enc('  \n '), mimeType: 'text/plain', filename: 'v.txt' }, new LocalProvider())).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('embedChunks / withRetry', () => {
  const chunk = (i: number) => ({ ordinal: i, page: 1, section: null, content: `c${i}`, tokenCount: 1, context: 'ctx' });

  it('envia em lotes e embute contexto + conteudo', async () => {
    const embed = vi.fn(async (t: string[]) => t.map(() => [0]));
    const llm = { embed } as unknown as LLMProvider;
    const out = await embedChunks(llm, [0, 1, 2, 3, 4].map(chunk), { batchSize: 2 });
    expect(out).toHaveLength(5);
    expect(embed.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 1]);
    expect(embed.mock.calls[0]![0][0]).toBe('ctx\nc0');
  });

  it('repete com backoff em falha transitoria, mas nao em erro permanente', async () => {
    let n = 0;
    const flaky = vi.fn(async () => {
      if (++n < 3) throw new Error('429');
      return 'ok';
    });
    await expect(withRetry(flaky, { baseMs: 1 })).resolves.toBe('ok');
    expect(flaky).toHaveBeenCalledTimes(3);

    const perm = vi.fn(async () => {
      throw new PermanentError('nao');
    });
    await expect(withRetry(perm, { baseMs: 1 })).rejects.toBeInstanceOf(PermanentError);
    expect(perm).toHaveBeenCalledTimes(1);
  });
});
