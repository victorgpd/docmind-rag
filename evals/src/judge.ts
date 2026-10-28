import type { Hit } from './types';

// Juiz local deterministico: sobreposicao lexical de tokens de conteudo (sem API, sem modelo).
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const STOP = new Set(
  fold(
    'a o as os um uma uns umas de do da dos das em no na nos nas por para com sem e ou que se ao aos à às pelo pela pelos pelas seu sua seus suas ele ela eles elas é são foi ser ter tem têm há como mais mas já também só sobre entre até quando qual quais quanto quantos quantas onde me meu minha isso este esta esse essa',
  ).split(' '),
);

export function contentTokens(s: string): string[] {
  return (fold(s).match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP.has(t));
}

/** Fracao dos tokens unicos de `claim` presentes em `evidence`. 1 se `claim` nao tem tokens de conteudo. */
export function coverage(claim: string, evidence: string): number {
  const c = [...new Set(contentTokens(claim))];
  if (!c.length) return 1;
  const e = new Set(contentTokens(evidence));
  return c.filter((t) => e.has(t)).length / c.length;
}

/** O hit e o trecho-fonte esperado? Mesmo documento e snippet quase inteiro contido no chunk. */
export const isSourceHit = (hit: Hit, doc: string, snippet: string) => hit.doc === doc && coverage(snippet, hit.text) >= 0.9;

/** O sistema disse que nao encontrou? (NO_ANSWER do pipeline real e do gerador local) */
export const isAbstention = (answer: string) => /^n[aã]o encontrei/i.test(answer.trim());

/**
 * Faithfulness: fracao das afirmacoes da resposta sustentadas pelo contexto.
 * Afirmacao = texto antes de cada marcador [n]; verificada contra o chunk n citado (ou todo o contexto, se sem citacao).
 * Resposta sem afirmacoes (ex.: "nao encontrei") nao alucina: 1.
 */
export function faithfulness(answer: string, context: Hit[]): number {
  if (isAbstention(answer)) return 1;
  const claims = [...answer.matchAll(/([^[\]]+?)\s*\[(\d+)\]/g)].map((m) => ({ text: m[1]!, n: Number(m[2]) }));
  if (!claims.length) claims.push({ text: answer, n: 0 });
  const all = context.map((h) => h.text).join(' ');
  const checked = claims.filter((c) => contentTokens(c.text).length);
  const ok = checked.filter((c) => coverage(c.text, context[c.n - 1]?.text ?? all) >= 0.8);
  return checked.length ? ok.length / checked.length : 1;
}
