import { readFile, readdir } from 'node:fs/promises';
import { coverage, faithfulness, isAbstention, isSourceHit } from './judge';
import type { Category, CorpusDoc, Question, RagAdapter } from './types';

const here = (p: string) => new URL(`../${p}`, import.meta.url);
export const KS = [1, 3, 5] as const;
export const CATEGORIES: Category[] = ['literal', 'parafrase', 'sinonimo_sigla', 'nome_proprio', 'sem_resposta'];
const CTX = 3; // trechos que o gerador local efetivamente usa (ele le ate 3 passagens)

const readDocs = async (dir: string) => {
  const files = (await readdir(here(dir))).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(files.map(async (name) => ({ name, text: await readFile(here(`${dir}/${name}`), 'utf8') })));
};
const readQuestions = async (file: string) => JSON.parse(await readFile(here(file), 'utf8')) as Question[];

export type DataSet = 'dev' | 'heldout' | 'calib';

/**
 * dev: corpus + dataset usados para ajustar o sistema. heldout: perguntas nunca usadas para ajuste, indexadas junto com o corpus dev (mais distratores).
 * calib: perguntas novas sobre o corpus dev, so para calibrar limiar/pesos (escritas sem olhar o held-out).
 */
export async function loadData(set: DataSet = 'dev'): Promise<{ docs: CorpusDoc[]; questions: Question[] }> {
  const docs = await readDocs('corpus');
  if (set === 'dev') return { docs, questions: await readQuestions('dataset/questions.json') };
  if (set === 'calib') return { docs, questions: await readQuestions('calib/questions.json') };
  return { docs: [...docs, ...(await readDocs('heldout/corpus'))], questions: await readQuestions('heldout/questions.json') };
}

export type Metrics = Record<string, number>;
// gated = abstencao decidida pelo limiar de relevancia (nenhum trecho enviado ao gerador); abstained sem gated = o gerador disse "nao encontrei"
type PerQuestion = { id: string; category: Category; rank: number; answer: string; faithfulness: number; abstained: boolean; gated: boolean; relevance: number; listMismatch: boolean; ctxRel: number; ansRel: number; ms: number };
export type ConfigResult = { overall: Metrics; categories: Record<string, Metrics>; perQuestion: PerQuestion[] };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

function aggregate(rows: PerQuestion[]): Metrics {
  const m: Metrics = { n: rows.length };
  if (!rows.length) return m;
  if (rows.every((r) => r.category === 'sem_resposta')) {
    m.abstention_rate = r4(mean(rows.map((r) => (r.abstained ? 1 : 0))));
    m.abstention_gate = r4(mean(rows.map((r) => (r.gated ? 1 : 0))));
    return m;
  }
  for (const k of KS) m[`recall@${k}`] = r4(mean(rows.map((r) => (r.rank > 0 && r.rank <= k ? 1 : 0))));
  m.mrr = r4(mean(rows.map((r) => (r.rank ? 1 / r.rank : 0))));
  m.faithfulness = r4(mean(rows.map((r) => r.faithfulness)));
  m.answer_relevance = r4(mean(rows.map((r) => r.ansRel)));
  m.context_relevance = r4(mean(rows.map((r) => r.ctxRel)));
  m.search_ms = r4(mean(rows.map((r) => r.ms)));
  m.false_abstention = r4(mean(rows.map((r) => (r.abstained ? 1 : 0)))); // tinha resposta e disse "nao encontrei"
  m.false_abstention_gate = r4(mean(rows.map((r) => (r.gated ? 1 : 0))));
  return m;
}

export async function evaluate(rag: RagAdapter, questions: Question[], rerank: boolean): Promise<ConfigResult> {
  const per: PerQuestion[] = [];
  for (const q of questions) {
    const t0 = performance.now();
    const { hits, relevance } = await rag.search(q.question, { rerank });
    const ms = performance.now() - t0;
    const { answer, passages } = await rag.generate(q.question, { rerank });
    const abstained = isAbstention(answer);
    const answerable = q.doc !== null && q.snippet !== null;
    per.push({
      id: q.id,
      category: q.category,
      rank: answerable ? hits.findIndex((h) => isSourceHit(h, q.doc!, q.snippet!)) + 1 : 0, // 0 = nao achou
      answer,
      abstained,
      gated: abstained && !passages.length,
      relevance: r4(relevance),
      faithfulness: faithfulness(answer, passages),
      listMismatch: passages.some((p, i) => p.id !== hits[i]?.id), // search() e generate() devem usar a mesma lista
      ansRel: answerable ? coverage(q.answer, answer) : 0,
      ctxRel: answerable ? coverage(q.answer, hits.slice(0, CTX).map((h) => h.text).join(' ')) : 0,
      ms,
    });
  }
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, aggregate(per.filter((p) => p.category === c))]));
  const answerable = per.filter((p) => p.category !== 'sem_resposta');
  const overall: Metrics = { ...aggregate(answerable), ...(categories.sem_resposta!.n ? { abstention_rate: categories.sem_resposta!.abstention_rate! } : {}) };
  overall.list_mismatches = per.filter((p) => p.listMismatch).length;
  return { overall, categories, perQuestion: per };
}

export async function runEval(rag: RagAdapter, set: DataSet = 'dev') {
  const { docs, questions } = await loadData(set);
  await rag.ingest(docs);
  const without = await evaluate(rag, questions, false);
  const withRerank = await evaluate(rag, questions, true);
  const diff = (a: Metrics, b: Metrics): Metrics =>
    Object.fromEntries(Object.keys(b).map((k) => [k, r4((b[k] ?? 0) - (a[k] ?? 0))]));
  const delta = {
    overall: diff(without.overall, withRerank.overall),
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, diff(without.categories[c]!, withRerank.categories[c]!)])),
  };
  return { without_rerank: without, with_rerank: withRerank, delta };
}

export type EvalResult = Awaited<ReturnType<typeof runEval>>;

/** Held-out so sai agregado: respostas/ranks por pergunta ajudariam a ajustar o sistema sobre ele. */
export const aggregateOnly = (r: EvalResult): EvalResult => ({
  ...r,
  without_rerank: { ...r.without_rerank, perQuestion: [] },
  with_rerank: { ...r.with_rerank, perQuestion: [] },
});

const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;
const pts = (x: number) => `${x > 0 ? '+' : ''}${Math.round(x * 100)} pts`;

function section(title: string, r: EvalResult): string {
  const w = r.with_rerank;
  const o = r.without_rerank;
  const answerable = CATEGORIES.filter((c) => c !== 'sem_resposta' && w.categories[c]!.n);
  const detail = ['n', 'recall@1', 'recall@3', 'recall@5', 'mrr', 'faithfulness', 'answer_relevance', 'context_relevance', 'false_abstention'];
  const rows = (res: ConfigResult) =>
    [...answerable.map((c) => [c, res.categories[c]!] as const), ['TOTAL (com resposta)', res.overall] as const].map(
      ([name, m]) => `| ${name} | ${detail.map((k) => m[k]).join(' | ')} |`,
    );
  const head = `| categoria | ${detail.join(' | ')} |\n|---|${detail.map(() => '---').join('|')}|`;
  const rerankRows = [...answerable, 'TOTAL'].map((c) => {
    const total = c === 'TOTAL';
    const a = total ? o.overall : o.categories[c]!;
    const b = total ? w.overall : w.categories[c]!;
    return `| ${total ? 'TOTAL (com resposta)' : c} | ${b.n} | ${pct(a['recall@1'])} | ${pct(b['recall@1'])} | ${pts(b['recall@1']! - a['recall@1']!)} | ${pct(b['recall@5'])} |`;
  });
  const sr = w.categories.sem_resposta!;
  return [
    `# ${title}`,
    '',
    `${w.overall.n} perguntas com resposta + ${sr.n} sem resposta no corpus.`,
    '',
    '| categoria | n | recall@1 sem rerank | recall@1 com rerank | delta | recall@5 com rerank |',
    '|---|---|---|---|---|---|',
    ...rerankRows,
    '',
    `Abstencao em perguntas sem resposta (responde "nao encontrei"): ${pct(o.categories.sem_resposta!.abstention_rate)} sem rerank, ${pct(sr.abstention_rate)} com rerank (n=${sr.n}).`,
    '',
    `Falsa abstencao (pergunta com resposta respondida com "nao encontrei"): ${pct(o.overall.false_abstention)} sem rerank, ${pct(w.overall.false_abstention)} com rerank (${pct(w.overall.false_abstention_gate)} pelo limiar de relevancia, sem chamar o gerador; ${pct(w.overall.false_abstention! - w.overall.false_abstention_gate!)} pelo gerador). Sem rerank o limiar e 0.`,
    '',
    '<details><summary>Detalhe com rerank / sem rerank</summary>',
    '',
    head,
    ...rows(w),
    '',
    '(sem rerank)',
    '',
    head,
    ...rows(o),
    '',
    '</details>',
  ].join('\n');
}

/** Rodada com provedor externo (openai): modelos, tokens reais e custo estimado. Ausente = modo local. */
export type RunInfo = {
  provider: string;
  date: string;
  embedModel: string;
  chatModel: string;
  temperature: number | null;
  rerank: string;
  /** Config da variante com rerank (ausente em resultados antigos = defaults). */
  rank?: { weights: { rerank: number; sim: number; rrf: number }; minRelevance: number; topK: number };
  usage: { embedTokens: number; chatIn: number; chatOut: number; embedCalls: number; chatCalls: number };
  usd: number;
  pricesVerifiedAt: string;
};

/** held-out e o numero honesto (nada foi ajustado sobre ele); dev e o conjunto usado para ajustar o sistema. */
export function toMarkdown(dev: EvalResult, held: EvalResult, run?: RunInfo): string {
  const hw = held.with_rerank;
  const ho = held.without_rerank;
  const par = hw.categories.parafrase!;
  const oPar = ho.categories.parafrase!;
  const sr = hw.categories.sem_resposta!;
  const n = (hw.overall.n ?? 0) + (sr.n ?? 0);
  if (run) return externalMarkdown(dev, held, run, n);
  return [
    'Juiz local deterministico (sem API).',
    '',
    section('Held-out (validacao: numero do README)', held),
    '',
    section('Dev (usado para ajustar o sistema)', dev),
    '',
    '# Limitacoes',
    '',
    '- O embedding local (hashing de tokens + stemming leve) e lexical: acerta quando pergunta e trecho compartilham palavras e erra em parafrases e sinonimos. O held-out mostra a capacidade real; o dev foi usado para ajustar o sistema e superestima.',
    '- Com Ollama / embeddings neurais os numeros tendem a subir (nao medido).',
    '- O gerador local e extrativo: faithfulness 100% e otimista. O juiz e lexical (sobreposicao de tokens), sem entailment semantico.',
    '- Poucas perguntas por categoria (4 a 8) e 2 sem resposta no held-out: variacao alta, nao ha intervalo de confianca.',
    '- Meta aspiracional de recall@5 no held-out: 80%. Alvo, nao atingido com embeddings locais lexicais. O gate de CI e um piso de regressao (60%), nao a meta.',
    '',
    '# Frase para o curriculo (baseada no held-out)',
    '',
    `Avaliacao automatica local do RAG (zero API externa), validada em ${n} perguntas held-out nunca usadas para ajuste: recall@5 de ${pct(hw.overall['recall@5'])} e recall@1 de ${pct(hw.overall['recall@1'])} com reranking (${pct(ho.overall['recall@1'])} sem), sendo ${pct(par['recall@1'])} de recall@1 em perguntas parafraseadas (${pct(oPar['recall@1'])} sem reranking). Em perguntas sem resposta no corpus, a taxa de abstencao foi de ${pct(sr.abstention_rate)}.`,
  ].join('\n');
}

function externalMarkdown(dev: EvalResult, held: EvalResult, run: RunInfo, n: number): string {
  const hw = held.with_rerank.overall;
  const ho = held.without_rerank.overall;
  const sr = held.with_rerank.categories.sem_resposta!;
  const u = run.usage;
  return [
    `Provider \`${run.provider}\` (${run.date}): embeddings \`${run.embedModel}\` para chunks e consultas, geracao \`${run.chatModel}\` (temperatura ${run.temperature ?? 'padrao da API'}), rerank ${run.rerank}${run.rank ? ` (pesos rerank/sim/rrf ${run.rank.weights.rerank}/${run.rank.weights.sim}/${run.rank.weights.rrf}, limiar de relevancia ${run.rank.minRelevance})` : ''}. Juiz lexical deterministico (sem API).`,
    '',
    `Tokens reais da rodada (dev + held-out, com e sem rerank): ${u.embedTokens} de embedding (${u.embedCalls} chamadas), ${u.chatIn} de entrada e ${u.chatOut} de saida no chat (${u.chatCalls} chamadas). Custo estimado: US$ ${run.usd.toFixed(4)} (tabela de precos de ${run.pricesVerifiedAt}).`,
    '',
    section('Held-out (validacao: numero do README)', held),
    '',
    section('Dev (usado para ajustar o sistema)', dev),
    '',
    '# Limitacoes',
    '',
    '- Juiz lexical (sobreposicao de tokens, sem entailment): o LLM parafraseia, entao faithfulness e answer_relevance ficam subestimados em relacao ao gerador extrativo local. Abstencao so conta respostas que comecam com "nao encontrei".',
    '- Temperatura 0 para reduzir a variancia; a producao usa o padrao da API. Nem com temperatura 0 a OpenAI garante saida identica entre rodadas.',
    '- Pesos do ranking, limiar de abstencao (0.17) e sinonimos foram calibrados no dev com embeddings locais e o LocalReranker; nada foi recalibrado para a OpenAI nem ajustado sobre o held-out.',
    '- Poucas perguntas por categoria (4 a 8) e 2 sem resposta no held-out: variacao alta, nao ha intervalo de confianca.',
    '- Modo agente nao roda nesta configuracao (so no modo local, em `latest.md`).',
    '',
    '# Frase para o curriculo (baseada no held-out)',
    '',
    `RAG avaliado com a configuracao de producao (${run.embedModel.replace(/^openai:|:\d+$/g, '')} + ${run.chatModel}) em ${n} perguntas held-out nunca usadas para ajuste: recall@5 de ${pct(ho['recall@5'])} sem reranking e ${pct(hw['recall@5'])} com reranking (${pts(hw['recall@5']! - ho['recall@5']!)}); recall@1 de ${pct(ho['recall@1'])} para ${pct(hw['recall@1'])} (${pts(hw['recall@1']! - ho['recall@1']!)}). Abstencao de ${pct(sr.abstention_rate)} em perguntas sem resposta no corpus (n=${sr.n}).`,
  ].join('\n');
}

/** Calibracao: uma linha por pergunta e config de pesos, gerada com limiar 0 (o gerador sempre e chamado). */
export type CalibRow = { id: string; weights: string; category: Category; rank: number; relevance: number; llmAbstained: boolean; answer: string };
export type CalibCell = { weights: string; threshold: number; recall5: number; abstention: number; falseAbstention: number; falseAbstentionGate: number };

/**
 * O limiar so decide se o gerador e chamado (a ordem dos trechos nao muda): com limiar t a pergunta abstem se
 * relevance < t ou se o gerador disse "nao encontrei". Assim uma rodada por config de pesos cobre todos os limiares.
 */
export function sweep(rows: CalibRow[], thresholds: number[]): CalibCell[] {
  return [...new Set(rows.map((r) => r.weights))].flatMap((weights) => {
    const rs = rows.filter((r) => r.weights === weights);
    const ans = rs.filter((r) => r.category !== 'sem_resposta');
    const none = rs.filter((r) => r.category === 'sem_resposta');
    const recall5 = r4(mean(ans.map((r) => (r.rank > 0 && r.rank <= 5 ? 1 : 0))));
    return thresholds.map((threshold) => {
      const abst = (r: CalibRow) => (r.relevance < threshold || r.llmAbstained ? 1 : 0);
      return {
        weights,
        threshold,
        recall5,
        abstention: r4(mean(none.map(abst))),
        falseAbstention: r4(mean(ans.map(abst))),
        falseAbstentionGate: r4(mean(ans.map((r) => (r.relevance < threshold ? 1 : 0)))),
      };
    });
  });
}

/**
 * Maior abstencao correta (sem resposta) com falsa abstencao <= maxFalse e recall@5 >= o dos pesos atuais.
 * Empate: pesos na ordem da grade (o atual primeiro), depois limiar mais proximo do atual, depois menos falsa abstencao.
 */
export function pick(cells: CalibCell[], current: { weights: string; threshold: number }, maxFalse = 0.1): CalibCell | undefined {
  const base = cells.find((c) => c.weights === current.weights)?.recall5 ?? 0;
  const order = [...new Set(cells.map((c) => c.weights))];
  const dist = (c: CalibCell) => r4(Math.abs(c.threshold - current.threshold));
  return cells
    .filter((c) => c.falseAbstention <= maxFalse && c.recall5 >= base)
    .sort(
      (a, b) =>
        b.abstention - a.abstention ||
        order.indexOf(a.weights) - order.indexOf(b.weights) ||
        dist(a) - dist(b) ||
        a.falseAbstention - b.falseAbstention,
    )[0];
}
