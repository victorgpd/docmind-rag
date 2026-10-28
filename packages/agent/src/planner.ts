import type { ToolName } from './tools';

export type Intent = 'search' | 'summarize' | 'compare' | 'extract_table';
export type AgentRequest = { query: string; collectionId?: string | undefined; documentIds?: string[] | undefined };
/** Passo ja executado: so o que o planejador precisa para decidir o proximo. */
export type StepRecord = { tool: ToolName; ok: boolean; documentIds: string[] };
export type Action = { done: true } | { done: false; tool: ToolName; input: unknown };

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Ordem importa: a primeira regra que casar vence.
const RULES: [RegExp, Intent][] = [
  [/\b(compar\w*|diferenc\w*|versus|vs)\b/, 'compare'],
  [/\b(tabel\w*|planilha\w*|colunas?|linhas)\b/, 'extract_table'],
  [/\b(resum\w*|sintetiz\w*|sintese|visao geral)\b/, 'summarize'],
];

export function detectIntent(query: string): Intent {
  const q = norm(query);
  return RULES.find(([re]) => re.test(q))?.[1] ?? 'search';
}

const NEEDED: Record<Intent, number> = { search: 0, summarize: 1, extract_table: 1, compare: 2 };
const MAIN_TOOL: Record<Intent, ToolName> = {
  search: 'search',
  summarize: 'summarize',
  extract_table: 'extract_table',
  compare: 'compare',
};

/** Funcao pura e deterministica: (pedido, intencao, historico) -> proxima acao. Sem LLM no roteamento. */
export function nextAction(req: AgentRequest, intent: Intent, history: StepRecord[]): Action {
  const ran = (t: ToolName) => history.some((s) => s.tool === t);
  const failed = history.some((s) => !s.ok);
  if (failed) return { done: true };

  if (intent === 'search') {
    return ran('search') ? { done: true } : { done: false, tool: 'search', input: { query: req.query, collectionId: req.collectionId } };
  }
  if (ran(MAIN_TOOL[intent])) return { done: true };

  // Resolve os documentos alvo: explicitos no pedido, senao os mais relevantes da busca.
  const found = [...new Set(history.filter((s) => s.tool === 'search').flatMap((s) => s.documentIds))];
  const docs = (req.documentIds?.length ? req.documentIds : found).slice(0, NEEDED[intent]);
  if (docs.length >= NEEDED[intent]) {
    return {
      done: false,
      tool: MAIN_TOOL[intent],
      input: intent === 'compare' ? { documentIds: docs } : { documentId: docs[0] },
    };
  }
  if (!ran('search') && !req.documentIds?.length) {
    return { done: false, tool: 'search', input: { query: req.query, collectionId: req.collectionId, topK: 10 } };
  }
  return { done: true }; // documentos insuficientes: o agente responde que nao achou
}
