import type { z } from 'zod';
import { hashEmbed, DIMS } from './embed';
import { contentTokens, extractJson } from './text';
import type { ChatMessage, LLMProvider } from './types';

export const NO_ANSWER = 'Não encontrei informação suficiente nos documentos.';
const PASSAGE = /^\[(\d+)\]\s+(.+)$/gm;
const MAX_SENTENCES = 3;

/** Gerador extrativo: escolhe as frases dos trechos "[n] texto" mais afins à pergunta e cita [n]. */
export function extractiveAnswer(messages: ChatMessage[]): string[] {
  const all = messages.map((m) => m.content).join('\n');
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content.replace(PASSAGE, '') ?? '';
  const q = new Set(contentTokens(question));
  const sentences: { n: string; s: string; score: number; order: number }[] = [];
  for (const [, n, text] of all.matchAll(PASSAGE)) {
    for (const s of text!.split(/(?<=[.!?])\s+/)) {
      const hits = contentTokens(s).filter((t) => q.has(t)).length;
      sentences.push({ n: n!, s: s.trim(), score: hits, order: sentences.length });
    }
  }
  if (!sentences.length) return [NO_ANSWER];
  // sem palavra em comum, as primeiras frases (ordem dos trechos) são o melhor palpite
  const best = [...sentences].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, MAX_SENTENCES);
  return best.sort((a, b) => a.order - b.order).map((x) => `${x.s} [${x.n}]`);
}

export class LocalProvider implements LLMProvider {
  readonly name = 'local';
  readonly dims = DIMS;
  /** Subir a versão quando embed.ts/stemming mudar (vetores antigos deixam de ser comparáveis). */
  readonly embeddingModel = 'local:hash-v2:384';
  async embed(texts: string[]) {
    return texts.map(hashEmbed);
  }
  async *generateStream(messages: ChatMessage[]): AsyncIterable<string> {
    const parts = extractiveAnswer(messages);
    for (let i = 0; i < parts.length; i++) yield i ? ` ${parts[i]}` : parts[i]!;
  }
  /** Sem LLM não há geração estruturada livre: aceita JSON na última mensagem, ou {answer, text}. */
  async generateObject<T>(schema: z.ZodType<T>, messages: ChatMessage[]): Promise<T> {
    let text = '';
    for await (const c of this.generateStream(messages)) text += c;
    const last = messages[messages.length - 1]?.content ?? '';
    const candidates: unknown[] = [];
    try {
      candidates.push(extractJson(last));
    } catch {
      /* sem JSON na mensagem */
    }
    candidates.push({ answer: text, text });
    for (const c of candidates) {
      const r = schema.safeParse(c);
      if (r.success) return r.data;
    }
    return schema.parse(candidates[0]); // lança ZodError descritivo
  }
}
