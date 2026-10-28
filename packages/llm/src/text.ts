// Palavras funcionais pt/en (já sem acento): pouco peso na similaridade.
export const STOP = new Set(
  ('de da do das dos em no na nos nas um uma uns umas o os as e ou que se por para com sem ao aos como mais ' +
    'the of and or to in on for with is are was be it this that an at by from as')
    .split(' '),
);

/** Minúsculas, sem acentos, só [a-z0-9], tokens com 2+ caracteres. */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

// Sufixos comuns do PT-BR (já sem acento), do mais longo ao mais curto.
const SUFFIXES = [
  'issimo', 'amento', 'imento', 'mente', 'idade', 'adora', 'acao', 'ador', 'avel', 'ivel', 'ante', 'ismo', 'ista',
  'amos', 'emos', 'imos', 'ando', 'endo', 'indo', 'aram', 'eram', 'iram', 'ado', 'ido', 'ada', 'ida', 'oso', 'osa', 'ico', 'ica', 'ava',
  'ar', 'er', 'ir', 'ou', 'ia',
];
const MIN_STEM = 3;

/** Stemming leve PT-BR: plural -> sufixo -> vogal final. "contratos"/"contrato" e "cancelamento"/"cancelar" colapsam. */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let t = w;
  if (/oes$|aes$/.test(t)) t = t.slice(0, -3) + 'ao';
  else if (/(ais|eis|ois)$/.test(t) && t.length > 4) t = t.slice(0, -2) + 'l';
  else if (/(res|zes)$/.test(t)) t = t.slice(0, -2);
  else if (/ns$/.test(t)) t = t.slice(0, -2) + 'm';
  else if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  const suf = SUFFIXES.find((s) => t.endsWith(s) && t.length - s.length >= MIN_STEM);
  if (suf) t = t.slice(0, -suf.length);
  else if (t.length > 3 && /[aeo]$/.test(t)) t = t.slice(0, -1);
  return t;
}

/** Tokens normalizados e com stem: base de embed, BM25 e geração. */
export function tokenize(s: string): string[] {
  return words(s).map(stem);
}

/** Como tokenize, sem palavras funcionais. */
export function contentTokens(s: string): string[] {
  return words(s)
    .filter((w) => !STOP.has(w))
    .map(stem);
}

/** Aproximação: ~4 caracteres por token (ordem de grandeza de BPE em pt/en). */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extrai o primeiro objeto JSON de um texto (modelos costumam cercar com prosa/markdown). */
export function extractJson(text: string): unknown {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON object found in model output');
  return JSON.parse(text.slice(a, b + 1));
}
