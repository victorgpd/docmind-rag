import { readFileSync } from 'node:fs';

export const fixture = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url));

/** Pergunta -> trecho esperado na resposta/citacao. */
export const QA = [
  { doc: 'ferias.txt', question: 'Quantos dias de ferias o colaborador tem direito?', expect: '30 dias' },
  { doc: 'reembolso.txt', question: 'Qual o limite diario para alimentacao?', expect: 'R$ 120,00' },
] as const;
