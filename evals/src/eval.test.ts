import { describe, expect, it } from 'vitest';
import { createAdapter, metered, type LlmUsage } from './adapter';
import { LocalProvider, type LLMProvider } from '@docmind/llm';
import { coverage, faithfulness, isAbstention } from './judge';
import { loadAgentData } from './agent-eval';
import { loadData, pick, runEval, sweep, type CalibRow } from './runner';

describe.each(['dev', 'heldout', 'calib'] as const)('dataset %s', (set) => {
  it('tem tamanho razoavel, ids unicos e todo snippet existe literalmente no documento', async () => {
    const { docs, questions } = await loadData(set);
    expect(questions.length).toBeGreaterThanOrEqual(set === 'dev' ? 30 : 15);
    expect(questions.length).toBeLessThanOrEqual(80);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    for (const q of questions.filter((q) => q.snippet)) {
      const text = docs.find((d) => d.name === q.doc)?.text.replace(/\s+/g, ' ');
      expect(text, `${q.id}: doc ${q.doc}`).toBeDefined();
      expect(text, `${q.id}: snippet`).toContain(q.snippet);
    }
  });

  it('parafrases e siglas quase nao repetem as palavras do trecho; sem_resposta nao tem fonte', async () => {
    const { questions } = await loadData(set);
    for (const q of questions.filter((q) => q.category === 'parafrase' || q.category === 'sinonimo_sigla'))
      expect(coverage(q.snippet!, q.question), q.id).toBeLessThanOrEqual(0.35);
    for (const q of questions.filter((q) => q.category === 'sem_resposta')) expect(q.snippet).toBeNull();
  });
});

it('held-out nao repete ids nem perguntas do dev', async () => {
  const dev = (await loadData('dev')).questions;
  const held = (await loadData('heldout')).questions;
  const seen = new Set(dev.flatMap((q) => [q.id, q.question]));
  for (const q of held) expect(seen.has(q.id) || seen.has(q.question), q.id).toBe(false);
});

it('calib nao repete ids nem perguntas do dev ou do held-out e cobre todas as categorias', async () => {
  const calib = (await loadData('calib')).questions;
  const seen = new Set([...(await loadData('dev')).questions, ...(await loadData('heldout')).questions].flatMap((q) => [q.id, q.question]));
  for (const q of calib) expect(seen.has(q.id) || seen.has(q.question), q.id).toBe(false);
  expect(new Set(calib.map((q) => q.category)).size).toBe(5);
});

describe('calibracao', () => {
  const row = (weights: string, category: CalibRow['category'], relevance: number, llmAbstained = false, rank = 1): CalibRow => ({
    id: `${weights}-${category}-${relevance}`,
    weights,
    category,
    rank,
    relevance,
    llmAbstained,
    answer: '',
  });
  const rows = [
    row('a', 'literal', 0.5),
    row('a', 'parafrase', 0.1),
    row('a', 'sem_resposta', 0.05),
    row('a', 'sem_resposta', 0.3, true),
    row('b', 'literal', 0.5, false, 0), // pesos b pioram o recall@5
    row('b', 'parafrase', 0.2),
    row('b', 'sem_resposta', 0.05),
    row('b', 'sem_resposta', 0.3, true),
  ];
  it('abstem se relevance < limiar ou se o gerador recusou', () => {
    const [t0, t1] = sweep(rows, [0, 0.12]);
    expect(t0).toMatchObject({ weights: 'a', threshold: 0, recall5: 1, abstention: 0.5, falseAbstention: 0, falseAbstentionGate: 0 });
    expect(t1).toMatchObject({ threshold: 0.12, abstention: 1, falseAbstention: 0.5, falseAbstentionGate: 0.5 });
  });
  it('escolhe a maior abstencao com falsa abstencao no teto e sem piorar o recall@5', () => {
    const cells = sweep(rows, [0, 0.06, 0.08, 0.12]);
    expect(pick(cells, { weights: 'a', threshold: 0.17 })).toMatchObject({ weights: 'a', threshold: 0.08 }); // 0.06 e 0.08 empatam: mais perto de 0.17
    expect(pick(cells, { weights: 'a', threshold: 0.17 }, 0)).toMatchObject({ weights: 'a', threshold: 0.08 });
    expect(pick(sweep(rows.filter((r) => r.weights === 'a' && r.category !== 'sem_resposta'), [0.2]), { weights: 'a', threshold: 0.17 })).toBeUndefined();
  });
});

describe('juiz', () => {
  const ctx = [{ id: 'a', doc: 'd', text: 'A sessão da VPN expira após 8 horas de conexão contínua.' }];
  it('resposta sustentada pelo contexto => 1; inventada => 0', () => {
    expect(faithfulness('A sessão da VPN expira após 8 horas [1]', ctx)).toBe(1);
    expect(faithfulness('A sessão expira após 3 dias e custa R$ 90 [1]', ctx)).toBe(0);
    expect(faithfulness('Não encontrei informação suficiente nos documentos.', ctx)).toBe(1);
    expect(isAbstention('Nao encontrei informacao suficiente')).toBe(true);
    expect(isAbstention('A sessão expira [1]')).toBe(false);
  });
  it('coverage ignora acento, caixa e stopwords', () => {
    expect(coverage('Até 2 dias úteis', 'ate 2 DIAS uteis')).toBe(1);
    expect(coverage('45 dias', 'prazo de 30 dias')).toBe(0.5);
  });
});

describe('metered', () => {
  it('conta tokens reais e embute cada texto uma vez so', async () => {
    const local = new LocalProvider();
    const embed = (t: string[]) => local.embed(t);
    const calls: string[][] = [];
    const inner: LLMProvider = {
      name: 'fake',
      dims: local.dims,
      embeddingModel: 'fake:1',
      embed: async (t, o) => (calls.push(t), o?.onUsage?.({ inputTokens: t.length, outputTokens: 0 }), embed(t)),
      generateStream: (m) => local.generateStream(m),
      generateObject: (z, m) => local.generateObject(z, m),
    };
    const usage: LlmUsage = { embedTokens: 0, chatIn: 0, chatOut: 0, embedCalls: 0, chatCalls: 0 };
    const llm = metered(inner, usage);
    const [a] = await llm.embed(['prazo da vpn']);
    const [b, c] = await llm.embed(['prazo da vpn', 'outra']);
    expect(b).toEqual(a);
    expect(c).toEqual((await embed(['outra']))[0]);
    expect(calls).toEqual([['prazo da vpn'], ['outra']]);
    expect(usage).toMatchObject({ embedTokens: 2, embedCalls: 2 });
    expect(llm.embeddingModel).toBe('fake:1');
  });
});

describe('runner (end-to-end local)', () => {
  it('ingere o corpus e devolve metricas validas para sem/com rerank', async () => {
    const rag = await createAdapter();
    try {
      const r = await runEval(rag);
      for (const cfg of [r.without_rerank, r.with_rerank])
        for (const [k, v] of Object.entries(cfg.overall)) {
          if (k === 'n' || k === 'search_ms') continue;
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      expect(r.with_rerank.overall['recall@5']).toBeGreaterThan(0.5);
      expect(r.without_rerank.perQuestion.some((q) => q.gated)).toBe(false); // sem rerank o limiar e 0: so o gerador abstem
    } finally {
      await rag.close();
    }
  });
});

describe('tarefas do agente', () => {
  it('referenciam documentos que existem e ferramentas validas', async () => {
    const { docs, tasks } = await loadAgentData();
    const names = new Set(docs.map((d) => d.name));
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    for (const t of tasks) {
      for (const d of t.docs ?? []) expect(names.has(d), `${t.id}: ${d}`).toBe(true);
      expect(t.steps.length, t.id).toBeLessThanOrEqual(t.maxSteps);
      expect(t.steps, t.id).toContain(t.tool === 'search' ? 'search' : t.tool);
      expect(Boolean(t.facts?.length || t.table || t.abstain), `${t.id}: sem criterio de conteudo`).toBe(true);
    }
  });
});
