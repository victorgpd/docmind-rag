import { z } from 'zod';
import { NO_ANSWER, rankConfigFromEnv } from '@docmind/retrieval';
import { Citation } from '@docmind/shared';
import type { ChatMessage, LLMProvider } from '@docmind/llm';
import { detectIntent, nextAction, type AgentRequest, type Intent, type StepRecord } from './planner';
import { groundedMessages } from './prompt';
import { TOOLS } from './tools';
import type { ChunkReader, Passage, Retriever, ToolCtx } from './types';

export const AgentRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  collectionId: z.string().uuid().optional(),
  documentIds: z.array(z.string().uuid()).max(10).optional(),
});

export const AgentResult = z.object({
  intent: z.enum(['search', 'summarize', 'compare', 'extract_table']),
  answer: z.string(),
  data: z.unknown().nullable(), // saida validada da ferramenta principal (schema em TOOLS[tool].output)
  citations: z.array(Citation),
  steps: z.array(z.object({ tool: z.string(), ok: z.boolean(), ms: z.number().int() })),
  truncated: z.boolean(),
  usage: z.object({ tokensIn: z.number().int(), tokensOut: z.number().int(), latencyMs: z.number().int() }),
});
export type AgentResult = z.infer<typeof AgentResult>;

const Intent = z.enum(['search', 'summarize', 'compare', 'extract_table']);
const Tool = z.enum(['search', 'summarize', 'compare', 'extract_table']);

/** Eventos do stream SSE (event: <type>, data: JSON do proprio evento). Contrato com a UI. */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan'), intent: Intent }),
  z.object({ type: z.literal('step'), n: z.number().int().positive(), tool: Tool, input: z.unknown() }),
  z.object({ type: z.literal('step_result'), n: z.number().int().positive(), tool: Tool, ok: z.boolean(), ms: z.number().int(), error: z.string().optional() }),
  z.object({ type: z.literal('result'), result: AgentResult }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export type AgentDeps = {
  orgId: string;
  llm: LLMProvider;
  retriever: Retriever;
  chunks: ChunkReader;
  maxSteps?: number;
  /** Corte de relevancia da busca (padrao: RAG_MIN_RELEVANCE, o mesmo do chat). */
  minRelevance?: number;
};

// shortcut: tokens estimados por chars/4 (provider local nao reporta uso); trocar se o provider passar a reportar
const tokens = (s: string) => Math.ceil(s.length / 4);

function compose(intent: Intent, data: any): string {
  if (!data) return NO_ANSWER;
  switch (intent) {
    case 'summarize':
      return data.summary;
    case 'compare':
      return [
        `Documento A: ${data.a.summary}`,
        `Documento B: ${data.b.summary}`,
        `Termos em comum: ${data.common.join(', ') || '-'}`,
        `So no A: ${data.onlyA.join(', ') || '-'}`,
        `So no B: ${data.onlyB.join(', ') || '-'}`,
      ].join('\n');
    case 'extract_table':
      return data.table
        ? `Tabela encontrada${data.table.page ? ` na pagina ${data.table.page}` : ''}: ${data.table.headers.length} colunas, ${data.table.rows.length} linhas.`
        : 'Nenhuma tabela encontrada no documento.';
    default:
      return '';
  }
}

export async function* runAgent(rawReq: AgentRequest, deps: AgentDeps): AsyncGenerator<AgentEvent, void> {
  const started = Date.now();
  const req = AgentRequestSchema.parse(rawReq);
  const maxSteps = deps.maxSteps ?? 4;
  const usage = { in: 0, out: 0 };
  const cites: Passage[] = [];
  const ctx: ToolCtx = {
    orgId: deps.orgId,
    llm: deps.llm,
    retriever: deps.retriever,
    chunks: deps.chunks,
    minRelevance: deps.minRelevance ?? rankConfigFromEnv().minRelevance,
    cite(p) {
      const i = cites.findIndex((c) => c.documentId === p.documentId && c.page === p.page && c.snippet === p.snippet);
      return i >= 0 ? i + 1 : cites.push(p);
    },
    async generate(messages: ChatMessage[]) {
      usage.in += tokens(messages.map((m) => m.content).join('\n'));
      let out = '';
      for await (const c of deps.llm.generateStream(messages)) out += c;
      usage.out += tokens(out);
      return out;
    },
  };

  const intent = detectIntent(req.query);
  yield { type: 'plan', intent };

  const history: StepRecord[] = [];
  const steps: AgentResult['steps'] = [];
  let data: unknown = null;
  let truncated = false;

  for (let n = 1; ; n++) {
    const action = nextAction(req, intent, history);
    if (action.done) break;
    if (n > maxSteps) {
      truncated = true;
      break;
    }
    yield { type: 'step', n, tool: action.tool, input: action.input };
    const t0 = Date.now();
    const tool = TOOLS[action.tool];
    try {
      const input = (tool.input as z.ZodTypeAny).parse(action.input);
      const out = (tool.output as z.ZodTypeAny).parse(await (tool.run as (i: any, c: ToolCtx) => Promise<unknown>)(input, ctx));
      const docIds = [...new Set((out as { passages?: Passage[] }).passages?.map((p) => p.documentId) ?? [])];
      history.push({ tool: action.tool, ok: true, documentIds: docIds });
      steps.push({ tool: action.tool, ok: true, ms: Date.now() - t0 });
      if (action.tool !== 'search') data = out;
      else if (intent === 'search') data = out;
      yield { type: 'step_result', n, tool: action.tool, ok: true, ms: Date.now() - t0 };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      history.push({ tool: action.tool, ok: false, documentIds: [] });
      steps.push({ tool: action.tool, ok: false, ms: Date.now() - t0 });
      yield { type: 'step_result', n, tool: action.tool, ok: false, ms: Date.now() - t0, error: message };
      yield { type: 'error', message };
      return;
    }
  }

  let answer: string;
  if (intent === 'search') {
    const passages = (data as { passages: (Passage & { n: number })[] } | null)?.passages ?? [];
    const g = groundedMessages('Responda em portugues usando so os trechos, citando [n].', passages, req.query);
    answer = passages.length ? g.relabel((await ctx.generate(g.messages)).trim()) : compose(intent, null);
  } else {
    answer = truncated && !data ? 'Limite de passos atingido antes de concluir o pedido.' : compose(intent, data);
  }

  yield {
    type: 'result',
    result: AgentResult.parse({
      intent,
      answer,
      data,
      citations: cites.map((c, i) => ({ ...c, n: i + 1 })),
      steps,
      truncated,
      usage: { tokensIn: usage.in, tokensOut: usage.out, latencyMs: Date.now() - started },
    }),
  };
}
