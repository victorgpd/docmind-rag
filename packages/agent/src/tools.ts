import { z } from 'zod';
import { tokenize } from '@docmind/llm';
import { groundedMessages } from './prompt';
import type { Hit, ToolCtx } from './types';

const Id = z.string().uuid();
const Passage = z.object({ documentId: Id, page: z.number().int().nullable(), snippet: z.string() });
const oneLine = (s: string, max = 240) => s.replace(/\s+/g, ' ').trim().slice(0, max);
const passageOf = (h: Hit) => ({ documentId: h.documentId, page: h.page, snippet: oneLine(h.content) });

// shortcut: amostra 3 trechos (inicio/meio/fim) em vez de map-reduce, trocar se o LLM tiver contexto longo
function sample(chunks: Hit[]): Hit[] {
  if (chunks.length <= 3) return chunks;
  return [chunks[0]!, chunks[Math.floor(chunks.length / 2)]!, chunks[chunks.length - 1]!];
}

async function summarizeDoc(ctx: ToolCtx, documentId: string) {
  const chunks = await ctx.chunks.get(ctx.orgId, documentId, 40);
  if (!chunks.length) return { documentId, summary: 'Documento sem conteudo indexado.', passages: [] };
  const passages = sample(chunks).map(passageOf);
  const { messages, relabel } = groundedMessages(
    'Resuma o documento em portugues, citando os trechos como [n].',
    passages.map((p) => ({ n: ctx.cite(p), snippet: p.snippet })),
  );
  return { documentId, summary: relabel((await ctx.generate(messages)).trim()), passages };
}

function topTerms(texts: string[], keep: (t: string) => boolean, n = 10): string[] {
  const freq = new Map<string, number>();
  for (const t of texts.flatMap(tokenize)) if (t.length > 3 && keep(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([t]) => t);
}

function splitRow(line: string): string[] | null {
  const raw = line.includes('|') ? line.replace(/^\s*\||\|\s*$/g, '').split('|') : line.trim().split(/\t| {2,}/);
  const cells = raw.map((c) => c.trim());
  return cells.length >= 2 && cells.some(Boolean) ? cells : null;
}

/** Maior bloco consecutivo de linhas com o mesmo numero de colunas (markdown `|`, TSV ou colunas por espacos). */
export function findTable(chunks: Hit[]): { page: number | null; rows: string[][] } | null {
  let best: { page: number | null; rows: string[][] } | null = null;
  for (const c of chunks) {
    let cur: string[][] = [];
    const flush = () => {
      if (cur.length >= 2 && (!best || cur.length > best.rows.length)) best = { page: c.page, rows: cur };
      cur = [];
    };
    for (const line of c.content.split('\n')) {
      if (line.includes('-') && /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue; // separador markdown
      const row = splitRow(line);
      if (row && (!cur.length || cur[0]!.length === row.length)) cur.push(row);
      else {
        flush();
        if (row) cur.push(row);
      }
    }
    flush();
  }
  return best;
}

export const searchTool = {
  name: 'search',
  description: 'Busca trechos relevantes nos documentos.',
  input: z.object({
    query: z.string().min(1),
    collectionId: Id.optional(),
    topK: z.number().int().min(1).max(20).default(5),
  }),
  output: z.object({ passages: z.array(Passage.extend({ n: z.number().int().positive() })) }),
  async run(i: { query: string; collectionId?: string | undefined; topK: number }, ctx: ToolCtx) {
    const found = await ctx.retriever.search(ctx.orgId, { query: i.query, collectionId: i.collectionId, topK: i.topK, onUsage: ctx.countUsage });
    // abstencao: sem relevancia suficiente o agente nao usa os trechos (mesmo corte do createRag)
    const hits = found.filter((h) => h.relevance === undefined || h.relevance >= ctx.minRelevance);
    return { passages: hits.map((h) => ({ ...passageOf(h), n: ctx.cite(passageOf(h)) })) };
  },
};

export const summarizeTool = {
  name: 'summarize',
  description: 'Resume um documento.',
  input: z.object({ documentId: Id }),
  output: z.object({ documentId: Id, summary: z.string(), passages: z.array(Passage) }),
  run: (i: { documentId: string }, ctx: ToolCtx) => summarizeDoc(ctx, i.documentId),
};

export const compareTool = {
  name: 'compare',
  description: 'Compara dois documentos (resumos e termos comuns/exclusivos).',
  input: z
    .object({ documentIds: z.tuple([Id, Id]) })
    .refine((v) => v.documentIds[0] !== v.documentIds[1], 'documentos iguais'),
  output: z.object({
    a: z.object({ documentId: Id, summary: z.string() }),
    b: z.object({ documentId: Id, summary: z.string() }),
    common: z.array(z.string()),
    onlyA: z.array(z.string()),
    onlyB: z.array(z.string()),
  }),
  async run(i: { documentIds: [string, string] }, ctx: ToolCtx) {
    const [ida, idb] = i.documentIds;
    const [ca, cb] = await Promise.all([ctx.chunks.get(ctx.orgId, ida, 40), ctx.chunks.get(ctx.orgId, idb, 40)]);
    const ta = new Set(ca.flatMap((c) => tokenize(c.content)));
    const tb = new Set(cb.flatMap((c) => tokenize(c.content)));
    const inBoth = (t: string) => ta.has(t) && tb.has(t);
    const sa = await summarizeDoc(ctx, ida);
    const sb = await summarizeDoc(ctx, idb);
    return {
      a: { documentId: ida, summary: sa.summary },
      b: { documentId: idb, summary: sb.summary },
      common: topTerms([...ca, ...cb].map((c) => c.content), inBoth),
      onlyA: topTerms(ca.map((c) => c.content), (t) => !tb.has(t)),
      onlyB: topTerms(cb.map((c) => c.content), (t) => !ta.has(t)),
    };
  },
};

export const extractTableTool = {
  name: 'extract_table',
  description: 'Extrai a maior tabela de um documento.',
  input: z.object({ documentId: Id }),
  output: z.object({
    documentId: Id,
    table: z
      .object({ page: z.number().int().nullable(), headers: z.array(z.string()), rows: z.array(z.array(z.string())) })
      .nullable(),
  }),
  async run(i: { documentId: string }, ctx: ToolCtx) {
    const found = findTable(await ctx.chunks.get(ctx.orgId, i.documentId, 200));
    if (!found) return { documentId: i.documentId, table: null };
    const [headers, ...rows] = found.rows;
    ctx.cite({ documentId: i.documentId, page: found.page, snippet: oneLine(headers!.join(' | ')) });
    return { documentId: i.documentId, table: { page: found.page, headers: headers!, rows } };
  },
};

export const TOOLS = {
  search: searchTool,
  summarize: summarizeTool,
  compare: compareTool,
  extract_table: extractTableTool,
} as const;
export type ToolName = keyof typeof TOOLS;
