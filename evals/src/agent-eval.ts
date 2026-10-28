import { readFile, readdir } from 'node:fs/promises';
import { runAgent, type AgentEvent, type AgentResult, type ToolName } from '@docmind/agent';
import type { AgentEnv } from './adapter';
import { isAbstention } from './judge';
import { loadData } from './runner';
import type { CorpusDoc } from './types';

/** Tarefa do modo agente. Criterios deterministicos: ferramentas na ordem esperada, passos <= limite, fatos/tabela/abstencao e citacoes. */
export type AgentTask = {
  id: string;
  tool: ToolName;
  query: string;
  docs?: string[];
  steps: ToolName[];
  maxSteps: number;
  facts?: string[];
  table?: { headers: string[]; row: string[]; rows: number };
  /** Pergunta fora do corpus: o agente deve dizer que nao encontrou (qualquer resposta com conteudo = alucinacao). */
  abstain?: boolean;
};

const here = (p: string) => new URL(`../${p}`, import.meta.url);
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

export async function loadAgentData(): Promise<{ docs: CorpusDoc[]; tasks: AgentTask[] }> {
  const dir = 'agent/corpus';
  const files = (await readdir(here(dir))).filter((f) => f.endsWith('.md')).sort();
  const extra = await Promise.all(files.map(async (name) => ({ name, text: await readFile(here(`${dir}/${name}`), 'utf8') })));
  const tasks = JSON.parse(await readFile(here('agent/tasks.json'), 'utf8')) as AgentTask[];
  return { docs: [...(await loadData('dev')).docs, ...extra], tasks };
}

const CRITERIA = ['tool_ok', 'steps_ok', 'content_ok', 'cited_ok'] as const;
type Criterion = (typeof CRITERIA)[number];
export type AgentTaskResult = {
  id: string;
  group: string;
  pass: boolean;
  criteria: Record<Criterion, boolean>;
  tools: string[];
  error?: string;
  answer: string;
  why: string[];
};

function checkTable(task: AgentTask, data: unknown): boolean {
  const t = (data as { table?: { headers: string[]; rows: string[][] } | null } | null)?.table;
  if (!t || !task.table) return false;
  return (
    task.table.headers.join('|') === t.headers.join('|') &&
    t.rows.length === task.table.rows &&
    t.rows.some((r) => r.join('|') === task.table!.row.join('|'))
  );
}

async function runTask(env: AgentEnv, task: AgentTask): Promise<AgentTaskResult> {
  const documentIds = task.docs?.map((d) => env.docId(d));
  const events: AgentEvent[] = [];
  try {
    for await (const e of runAgent({ query: task.query, ...(documentIds && { documentIds }) }, { ...env.deps, maxSteps: task.maxSteps }))
      events.push(e);
  } catch (e) {
    events.push({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
  const err = events.find((e) => e.type === 'error');
  const result: AgentResult | undefined = events.find((e) => e.type === 'result')?.result;
  const tools = result?.steps.map((s) => s.tool) ?? [];
  const answer = result?.answer ?? '';
  const why: string[] = [];

  const tool_ok = tools.join(',') === task.steps.join(',');
  if (!tool_ok) why.push(`ferramentas [${tools.join(', ')}], esperado [${task.steps.join(', ')}]`);
  const steps_ok = !err && !!result && !result.truncated && result.steps.length <= task.maxSteps && result.steps.every((s) => s.ok);
  if (!steps_ok) why.push(err ? `erro: ${err.type === 'error' ? err.message : ''}` : `passos ${result?.steps.length ?? 0} (limite ${task.maxSteps}) ou truncado`);

  let content_ok: boolean;
  if (task.abstain) {
    content_ok = isAbstention(answer) || fold(answer).startsWith('nao encontrei');
    if (!content_ok) why.push(`respondeu algo fora do corpus em vez de abster: "${answer.slice(0, 90)}"`);
  } else if (task.table) {
    content_ok = checkTable(task, result?.data);
    if (!content_ok) why.push('tabela extraida diferente da esperada');
  } else {
    const missing = (task.facts ?? []).filter((f) => !fold(answer).includes(fold(f)));
    content_ok = missing.length === 0 && answer.length > 0;
    if (!content_ok) why.push(`fatos ausentes na resposta: ${missing.join(', ') || '(resposta vazia)'}`);
  }
  const cited_ok = task.abstain ? true : (result?.citations.length ?? 0) > 0;
  if (!cited_ok) why.push('sem citacoes');

  const criteria = { tool_ok, steps_ok, content_ok, cited_ok };
  return {
    id: task.id,
    group: task.abstain ? 'sem_resposta' : task.tool,
    pass: Object.values(criteria).every(Boolean),
    criteria,
    tools,
    ...(err?.type === 'error' && { error: err.message }),
    answer: answer.replace(/\s+/g, ' ').slice(0, 160),
    why,
  };
}

export async function runAgentEval(env: AgentEnv, tasks: AgentTask[]) {
  const results: AgentTaskResult[] = [];
  for (const t of tasks) results.push(await runTask(env, t));
  const groups: Record<string, { n: number; pass_rate: number } & Record<Criterion, number>> = {};
  for (const g of [...new Set(results.map((r) => r.group))]) {
    const rs = results.filter((r) => r.group === g);
    const rate = (f: (r: AgentTaskResult) => boolean) => Math.round((rs.filter(f).length / rs.length) * 1e4) / 1e4;
    groups[g] = { n: rs.length, pass_rate: rate((r) => r.pass), ...(Object.fromEntries(CRITERIA.map((c) => [c, rate((r) => r.criteria[c])])) as Record<Criterion, number>) };
  }
  const overall = Math.round((results.filter((r) => r.pass).length / results.length) * 1e4) / 1e4;
  return { overall, groups, results };
}
export type AgentEvalResult = Awaited<ReturnType<typeof runAgentEval>>;

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function agentMarkdown(r: AgentEvalResult): string {
  const fails = r.results.filter((x) => !x.pass);
  return [
    '# Modo agente',
    '',
    `${r.results.length} tarefas, criterios deterministicos: ferramentas na ordem esperada, passos <= limite, fatos/tabela esperados (ou abstencao fora do corpus) e citacoes. Taxa de acerto geral: ${pct(r.overall)}.`,
    '',
    '| ferramenta | n | acerto | tool_ok | steps_ok | content_ok | cited_ok |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(r.groups).map(
      ([g, m]) => `| ${g} | ${m.n} | ${pct(m.pass_rate)} | ${pct(m.tool_ok)} | ${pct(m.steps_ok)} | ${pct(m.content_ok)} | ${pct(m.cited_ok)} |`,
    ),
    '',
    fails.length ? `Falhas: ${fails.map((f) => f.id).join(', ')} (detalhe em results/latest.json).` : 'Sem falhas.',
  ].join('\n');
}
