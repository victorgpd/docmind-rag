import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DIMS,
  NO_ANSWER,
  cosine,
  countTokens,
  createLLM,
  createReranker,
  estimateCost,
  hashEmbed,
  pricingFor,
  tokenize,
} from './index';

const collect = async (it: AsyncIterable<string>) => {
  let s = '';
  for await (const c of it) s += c;
  return s;
};

describe('embeddings', () => {
  it('are deterministic, 384 dims and L2-normalized', async () => {
    const llm = createLLM({}, {});
    const [a, b] = await llm.embed(['gato preto', 'gato preto']);
    expect(a).toHaveLength(384);
    expect(a).toEqual(b);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 6);
    expect(DIMS).toBe(384);
  });

  it('ranks lexically/morphologically close text above unrelated text', () => {
    const q = hashEmbed('prazo de entrega');
    const near = cosine(q, hashEmbed('os prazos de entregas são de 5 dias'));
    const far = cosine(q, hashEmbed('política de privacidade e cookies'));
    expect(near).toBeGreaterThan(far + 0.2);
  });

  it('returns the zero vector for text without tokens', () => {
    expect(hashEmbed('!!!').every((x) => x === 0)).toBe(true);
  });
});

describe('local generator', () => {
  const messages = [
    { role: 'system' as const, content: 'Responda com base nos trechos.' },
    {
      role: 'user' as const,
      content: '[1] A empresa foi fundada em 2010. Tem sede em Lisboa.\n[2] O prazo de entrega é de 5 dias úteis. Frete grátis acima de 100.\n\nPergunta: qual o prazo de entrega?',
    },
  ];

  it('streams an extractive answer citing [n]', async () => {
    const chunks: string[] = [];
    for await (const c of createLLM({}, {}).generateStream(messages)) chunks.push(c);
    const out = chunks.join('');
    expect(chunks.length).toBeGreaterThan(1);
    expect(out).toContain('O prazo de entrega é de 5 dias úteis. [2]');
    expect(out).toMatch(/\[\d+\]/);
  });

  it('declines without passages', async () => {
    expect(await collect(createLLM({}, {}).generateStream([{ role: 'user', content: 'oi' }]))).toBe(NO_ANSWER);
  });

  it('generateObject validates with zod', async () => {
    const llm = createLLM({}, {});
    const ok = await llm.generateObject(z.object({ answer: z.string() }), messages);
    expect(ok.answer).toContain('[2]');
    await expect(llm.generateObject(z.object({ n: z.number() }), messages)).rejects.toThrow();
    const fromPrompt = await llm.generateObject(z.object({ n: z.number() }), [
      { role: 'user', content: 'Devolva {"n": 3}' },
    ]);
    expect(fromPrompt.n).toBe(3);
  });
});

describe('reranker', () => {
  it('reranks by lexical match and honors topK', async () => {
    const r = await createReranker().rerank(
      'prazo de entrega',
      [
        { id: 'a', text: 'política de privacidade' },
        { id: 'b', text: 'o prazo de entrega é de 5 dias' },
        { id: 'c', text: 'formas de pagamento' },
      ],
      2,
    );
    expect(r.map((x) => x.id)[0]).toBe('b');
    expect(r).toHaveLength(2);
    expect(await createReranker().rerank('x', [])).toEqual([]);
  });
});

describe('tokens and cost', () => {
  it('approximates tokens', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('abcdefgh')).toBe(2);
  });

  it('is free for local and configurable otherwise', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000 };
    expect(estimateCost(usage, pricingFor('local', { LLM_PRICE_IN_PER_1M: '9' }))).toBe(0);
    expect(estimateCost(usage)).toBe(0);
    expect(estimateCost(usage, pricingFor('ollama', { LLM_PRICE_IN_PER_1M: '2', LLM_PRICE_OUT_PER_1M: '4' }))).toBe(4);
  });
});

describe('provider switch', () => {
  it('uses LLM_PROVIDER from env', () => {
    expect(createLLM({}, { LLM_PROVIDER: 'ollama', OLLAMA_URL: 'http://localhost:11434' }).name).toBe('ollama');
    expect(createLLM({}, {}).name).toBe('local');
    expect(() => createLLM({ provider: 'ollama' }, {})).toThrow(/OLLAMA_URL/);
  });
});

describe('PT-BR retrieval', () => {
  it('stems plural/derivational variants together', () => {
    expect(tokenize('Contratos CONTRATO cancelamento cancelar cancelação')).toEqual(
      ['contrat', 'contrat', 'cancel', 'cancel', 'cancel'],
    );
  });

  it('keeps variants close in embedding space and unrelated text far', () => {
    const sim = (a: string, b: string) => cosine(hashEmbed(a), hashEmbed(b));
    expect(sim('contratos', 'contrato')).toBeGreaterThan(0.99);
    expect(sim('cancelamento', 'cancelar')).toBeGreaterThan(0.99);
    expect(sim('cancelamento do contrato', 'cancelar contratos')).toBeGreaterThan(sim('cancelamento do contrato', 'política de privacidade') + 0.4);
  });

  it('BM25 and extractive generation use the same stemming', async () => {
    const ranked = await createReranker().rerank('como cancelar contratos?', [
      { id: 'a', text: 'Política de privacidade e cookies.' },
      { id: 'b', text: 'O cancelamento do contrato exige aviso prévio de 30 dias.' },
    ]);
    expect(ranked[0]!.id).toBe('b');
    const out = await collect(
      createLLM({}, {}).generateStream([
        { role: 'user', content: '[1] A empresa fica em Lisboa. Tem 20 funcionários.\n[2] O cancelamento do contrato exige aviso prévio.\n\nPergunta: como cancelar contratos?' },
      ]),
    );
    expect(out).toContain('O cancelamento do contrato exige aviso prévio. [2]');
  });
});

describe('reranker: paraphrases, acronyms, absolute scores', () => {
  const docs = [
    { id: 'vr', text: 'O vale-refeição é creditado todo dia 25, no valor de R$ 38,00 por dia útil.' },
    { id: 'vis', text: 'Visitantes devem usar crachá laranja e ser acompanhados o tempo todo.' },
    { id: 'seg', text: 'Dispositivos pessoais não têm permissão para conectar à rede interna.' },
  ];
  const top = async (q: string, opts?: Parameters<typeof createReranker>[0]) => (await createReranker(opts).rerank(q, docs))[0]!.id;

  it('expands acronyms and synonyms (VR ~ vale-refeição, visitas ~ visitantes)', async () => {
    expect(await top('Qual o valor do VR por dia trabalhado?')).toBe('vr');
    expect(await top('Visitas podem circular sozinhas?')).toBe('vis');
  });

  it('synonym table is configurable', async () => {
    const q = 'quem recebe o VR';
    const withTable = (await createReranker().rerank(q, docs))[0]!;
    const without = (await createReranker({ synonyms: [] }).rerank(q, docs)).find((r) => r.id === 'vr')!;
    expect(withTable.id).toBe('vr');
    expect(withTable.score!).toBeGreaterThan(without.score!);
  });

  it('scores are absolute: a full lexical match beats a weak one by a wide margin', async () => {
    const r = await createReranker({ synonyms: [] }).rerank('crachá laranja visitantes acompanhados', docs);
    const byId = Object.fromEntries(r.map((x) => [x.id, x.score]));
    expect(byId.vis).toBeGreaterThan(0.5);
    expect(byId.seg!).toBeLessThan(byId.vis! / 2);
  });
});
