import type { Citation } from '@docmind/shared';

/** `sim` = similaridade de cosseno com a pergunta; `rrf` = score da fusão híbrida (ambos preenchidos por hybridSearch). */
export type Passage = { id: string; documentId: string; page: number | null; content: string; sim?: number; rrf?: number };

/**
 * Filtro de stream: deixa passar só marcadores [n] com 1 <= n <= max e registra os usados.
 * Marcadores inventados pelo modelo ([9] com 3 trechos) são removidos antes de chegar ao cliente.
 * shortcut: só reconhece "[n]" isolado; "[1, 2]" passa como texto e não conta como citação.
 */
export class CitationFilter {
  readonly used = new Set<number>();
  private buf = '';
  constructor(private readonly max: number) {}

  push(chunk: string): string {
    let out = '';
    for (const ch of chunk) {
      if (!this.buf) {
        if (ch === '[') this.buf = ch;
        else out += ch;
      } else if (ch === ']') {
        out += this.close();
      } else if (/\d/.test(ch)) {
        this.buf += ch;
      } else {
        out += this.buf;
        this.buf = ch === '[' ? ch : '';
        if (ch !== '[') out += ch;
      }
    }
    return out;
  }

  /** Descarrega um "[12" incompleto no fim do stream. */
  flush(): string {
    const rest = this.buf;
    this.buf = '';
    return rest;
  }

  private close(): string {
    const raw = `${this.buf}]`;
    const n = Number(this.buf.slice(1));
    this.buf = '';
    if (raw === '[]') return raw;
    if (n < 1 || n > this.max) return '';
    this.used.add(n);
    return raw;
  }
}

/** Citações {documentId, page, snippet, n} dos marcadores efetivamente usados na resposta. */
export function buildCitations(passages: Passage[], used: Iterable<number>): Citation[] {
  return [...new Set(used)]
    .filter((n) => n >= 1 && n <= passages.length)
    .sort((a, b) => a - b)
    .map((n) => {
      const p = passages[n - 1]!;
      return { documentId: p.documentId, page: p.page, snippet: p.content.slice(0, 300), n };
    });
}
