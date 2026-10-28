import { STOP, stem, words } from './text';

/** Grupo de termos equivalentes (siglas, sinônimos, flexões de expressão). Casam depois de normalizar e aplicar stem. */
export type SynonymGroups = string[][];

// Tabela genérica de siglas e sinônimos comuns em documentos corporativos PT-BR; troque via `new LocalReranker({ synonyms })`.
export const DEFAULT_SYNONYMS: SynonymGroups = [
  ['vr', 'vale refeição'],
  ['va', 'vale alimentação'],
  ['vt', 'vale transporte'],
  ['ti', 'tecnologia da informação'],
  ['rh', 'recursos humanos'],
  ['vpn', 'rede privada virtual'],
  ['2fa', 'autenticação em duas etapas', 'autenticação de dois fatores', 'verificação em duas etapas'],
  ['sms', 'mensagem de texto'],
  ['clt', 'consolidação das leis do trabalho'],
  ['fgts', 'fundo de garantia'],
  ['inss', 'previdência social'],
  ['nf', 'nota fiscal'],
  ['pj', 'pessoa jurídica'],
  ['pf', 'pessoa física'],
  ['lgpd', 'lei geral de proteção de dados'],
  ['férias', 'descanso', 'recesso'],
  ['colaborador', 'funcionário', 'empregado', 'trabalhador'],
  ['notebook', 'laptop', 'computador', 'máquina'],
  ['visitante', 'visita'],
  ['rescisão', 'encerramento do contrato', 'encerrar o vínculo', 'cancelamento'],
  ['multa', 'penalidade'],
  ['licença', 'afastamento'],
  ['diária', 'hospedagem', 'hotel'],
  ['reembolso', 'ressarcimento'],
  ['gestor', 'chefe', 'gerente', 'supervisor'],
  ['segurança', 'proteção'],
  ['senha', 'credencial'],
  ['valor', 'preço', 'custo'],
  ['aviso', 'antecedência', 'comunicar'],
  ['curso', 'treinamento', 'capacitação'],
];

const norm = (s: string) => words(s).map(stem);

/** Pré-compila os termos de cada grupo (tokens com stem). */
export function compileSynonyms(groups: SynonymGroups) {
  return groups.map((g) => g.map((text) => ({ text, tokens: norm(text) })).filter((t) => t.tokens.length));
}

const hasPhrase = (q: string[], p: string[]) => {
  for (let i = 0; i + p.length <= q.length; i++) if (p.every((t, j) => q[i + j] === t)) return true;
  return false;
};

/** Termos extras (tokens com stem, sem stopwords, fora da consulta) e o texto original, p/ expandir uma consulta. */
export function expandQuery(query: string, groups: ReturnType<typeof compileSynonyms>) {
  const q = norm(query);
  const have = new Set(q);
  const tokens = new Set<string>();
  const texts: string[] = [];
  for (const g of groups) {
    const hit = g.some((t) => hasPhrase(q, t.tokens));
    if (!hit) continue;
    for (const t of g) {
      if (hasPhrase(q, t.tokens)) continue;
      texts.push(t.text);
      for (const tok of t.tokens) if (!have.has(tok) && !STOP.has(tok)) tokens.add(tok);
    }
  }
  return { tokens: [...tokens], text: texts.join(' ') };
}
