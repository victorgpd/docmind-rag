import { STOP, stem, words } from './text';

export const DIMS = 384;

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Hashing trick com sinal sobre unigramas (peso 1), bigramas (0.5) e trigramas de
 * caracteres (0.3, aproxima similaridade morfologica). Peso sublinear (1+log tf).
 * Vetor L2-normalizado; texto sem tokens retorna o vetor nulo. Deterministico.
 */
export function hashEmbed(text: string): number[] {
  const feats = new Map<string, number>();
  const add = (f: string, w: number) => feats.set(f, (feats.get(f) ?? 0) + w);
  const raw = words(text);
  const toks = raw.map(stem);
  const wt = raw.map((r) => (STOP.has(r) ? 0.2 : 1));
  toks.forEach((t, i) => {
    const w = wt[i]!;
    add(`u:${t}`, w);
    if (i > 0) add(`b:${toks[i - 1]} ${t}`, 0.5 * Math.min(w, wt[i - 1]!));
    if (t.length > 3) {
      const p = `^${t}$`;
      for (let j = 0; j + 3 <= p.length; j++) add(`c:${p.slice(j, j + 3)}`, 0.3 * w);
    }
  });
  const v = new Array<number>(DIMS).fill(0);
  for (const [f, w] of feats) {
    const h = fnv(f);
    v[h % DIMS]! += ((h >>> 31) & 1 ? -1 : 1) * w * (1 + Math.log(Math.max(w, 1)));
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
