import type { Page } from './types';

const norm = (l: string) => l.trim().toLowerCase().replace(/\d+/g, '#');
const isPageNumber = (l: string) => /^(p[aá]g(ina)?\.?|page)?\s*\d+(\s*(de|of|\/)\s*\d+)?$/i.test(l.trim());

/** Normaliza espacos e junta quebras de linha de PDF dentro do paragrafo (mantem titulos, listas e tabelas). */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(new RegExp('[\u00a0\u2007\u202f]', 'g'), ' ')
    .replace(new RegExp('[\u200b\u00ad\ufeff]', 'g'), '')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .replace(/ {2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/([^\n])\n(?!\n|#{1,6} |\s*[-*•][ ]|\s*\d+[.)][ ]|\|)/g, (m, c: string) => (/[.:;!?]/.test(c) ? m : `${c} `))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Remove cabecalhos/rodapes que se repetem em >=50% das paginas (min. 3) e numeros de pagina soltos. */
export function cleanPages(pages: Page[]): Page[] {
  const lines = pages.map((p) => p.text.split('\n'));
  /** Indices das 2 primeiras e 2 ultimas linhas nao vazias. */
  const edgeIdx = (ls: string[]) => {
    const idx = ls.flatMap((l, j) => (l.trim() ? [j] : []));
    return new Set([...idx.slice(0, 2), ...idx.slice(-2)]);
  };
  const counts = new Map<string, number>();
  for (const ls of lines) for (const k of new Set([...edgeIdx(ls)].map((j) => norm(ls[j]!)))) counts.set(k, (counts.get(k) ?? 0) + 1);
  const minHits = Math.max(3, Math.ceil(pages.length / 2));
  const repeated = new Set([...counts].filter(([, n]) => n >= minHits).map(([k]) => k));

  return pages.map((p, i) => {
    const ls = lines[i]!;
    const edge = edgeIdx(ls);
    const kept = ls.filter((l, j) => !(edge.has(j) && (repeated.has(norm(l)) || isPageNumber(l))));
    return { page: p.page, text: normalizeText(kept.join('\n')) };
  });
}
