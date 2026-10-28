import type { Chunk, Page } from './types';

/** ~4 caracteres por token (heuristica; o tokenizer real depende do modelo de embedding). */
export const countTokens = (s: string) => Math.ceil(s.length / 4);

type Block = { page: number | null; section: string | null; text: string };

const HEADING = /^(#{1,6})\s+(.+)$/;
// shortcut: heuristica de titulo para PDF/TXT (caixa alta ou numeracao), trocar por analise de fonte se errar muito.
const looksLikeHeading = (p: string) =>
  p.length <= 80 &&
  !p.includes('\n') &&
  !/[.,;:]$/.test(p) &&
  (/^\d+(\.\d+)*[.)]?\s+\p{Lu}/u.test(p) || (/\p{L}/u.test(p) && p === p.toUpperCase()));

function toBlocks(pages: Page[]): Block[] {
  const blocks: Block[] = [];
  let section: string | null = null;
  for (const { page, text } of pages) {
    for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
      const h = HEADING.exec(para);
      if (h || looksLikeHeading(para)) section = (h ? h[2]! : para).trim();
      blocks.push({ page, section, text: para });
    }
  }
  return blocks;
}

/** Quebra um paragrafo maior que max por sentencas e, em ultimo caso, por palavras. */
function splitLong(text: string, maxTokens: number): string[] {
  if (countTokens(text) <= maxTokens) return [text];
  const parts: string[] = [];
  let cur = '';
  const pieces = text.split(/(?<=[.!?])\s+/).flatMap((s) => (countTokens(s) > maxTokens ? s.split(/\s+/) : [s]));
  for (const piece of pieces) {
    if (cur && countTokens(`${cur} ${piece}`) > maxTokens) {
      parts.push(cur);
      cur = piece;
    } else cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Ultimas palavras de `text` somando ~tokens (inicio do proximo chunk). */
function tail(text: string, tokens: number): string {
  const words = text.split(/\s+/);
  let out: string[] = [];
  for (let i = words.length - 1; i >= 0 && countTokens(out.join(' ')) < tokens; i--) out = [words[i]!, ...out];
  return out.join(' ');
}

/** Chunking por estrutura (titulos/paragrafos), ~500 tokens, 15% de sobreposicao; page = pagina onde o chunk comeca. */
export function chunkPages(pages: Page[], opts: { targetTokens?: number; overlap?: number } = {}): Chunk[] {
  const target = opts.targetTokens ?? 500;
  const overlapTokens = Math.round(target * (opts.overlap ?? 0.15));
  const chunks: Chunk[] = [];
  let cur: { page: number | null; section: string | null; text: string } | null = null;

  const flush = () => {
    if (cur) chunks.push({ ordinal: chunks.length, page: cur.page, section: cur.section, content: cur.text, tokenCount: countTokens(cur.text) });
  };

  for (const b of toBlocks(pages)) {
    for (const piece of splitLong(b.text, target - overlapTokens)) {
      if (cur && countTokens(`${cur.text}\n\n${piece}`) > target) {
        const overlap = tail(cur.text, overlapTokens);
        flush();
        cur = { page: b.page, section: b.section, text: `${overlap} ${piece}` };
      } else if (cur) cur.text = `${cur.text}\n\n${piece}`;
      else cur = { page: b.page, section: b.section, text: piece };
    }
  }
  flush();
  return chunks;
}
