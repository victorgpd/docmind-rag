import { mkdir, writeFile } from 'node:fs/promises';
import { PRICES_VERIFIED_AT } from '@docmind/llm';
import { DEFAULT_RANK } from '@docmind/retrieval';
import { createAdapter } from './adapter';
import { addUsage, costUsd, emptyUsage, providerFromArgs } from './cli';
import { isAbstention, isSourceHit } from './judge';
import { loadData, pick, sweep, type CalibRow } from './runner';

// Uso (em evals/): node --env-file=../.env ../node_modules/tsx/dist/cli.mjs src/calibrate.ts --provider openai
// Calibra RAG_MIN_RELEVANCE e RAG_W_* SO no conjunto calib/ (corpus dev). Nunca le o held-out.
// Uma rodada por config de pesos com limiar 0 (o gerador sempre responde); o limiar e varrido offline (ver sweep).
const GRID = [
  [0.8, 0.1, 0.1], // atual (defaults); os demais em ordem de distancia
  [0.5, 0.4, 0.1],
  [0.3, 0.6, 0.1],
] as const;
const THRESHOLDS = [...new Set([...Array.from({ length: 16 }, (_, i) => (i * 2) / 100), DEFAULT_RANK.minRelevance])].sort((a, b) => a - b);
const w = DEFAULT_RANK.weights;
const current = { weights: `${w.rerank}/${w.sim}/${w.rrf}`, threshold: DEFAULT_RANK.minRelevance };

const { provider, openai } = providerFromArgs();
const { docs, questions } = await loadData('calib');
const usage = emptyUsage();
const rows: CalibRow[] = [];
for (const [rerank, sim, rrf] of GRID) {
  const rag = await createAdapter(openai, undefined, { ...DEFAULT_RANK, weights: { rerank, sim, rrf }, minRelevance: 0 });
  try {
    await rag.ingest(docs);
    for (const q of questions) {
      const { hits, relevance } = await rag.search(q.question, { rerank: true });
      const { answer } = await rag.generate(q.question, { rerank: true });
      const rank = q.doc && q.snippet ? hits.findIndex((h) => isSourceHit(h, q.doc!, q.snippet!)) + 1 : 0;
      rows.push({ id: q.id, weights: `${rerank}/${sim}/${rrf}`, category: q.category, rank, relevance, llmAbstained: isAbstention(answer), answer });
    }
  } finally {
    addUsage(usage, rag.usage);
    await rag.close();
  }
}

const cells = sweep(rows, THRESHOLDS);
const chosen = pick(cells, current);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = openai ? costUsd(openai, usage) : 0;
const md = [
  `# Calibracao (${provider}, ${new Date().toISOString().slice(0, 10)})`,
  '',
  `${questions.length} perguntas de \`calib/\` sobre o corpus dev. Criterio: maior abstencao correta nas sem resposta com falsa abstencao <= 10% e recall@5 >= o dos pesos atuais; empate: pesos atuais, depois limiar mais proximo de ${current.threshold}.`,
  `Atual: pesos ${current.weights}, limiar ${current.threshold}. **Escolhido: ${chosen ? `pesos ${chosen.weights}, limiar ${chosen.threshold}` : 'nenhuma combinacao atende ao criterio'}.**`,
  '',
  `Tokens: ${usage.embedTokens} de embedding, ${usage.chatIn} de entrada e ${usage.chatOut} de saida no chat (${usage.chatCalls} chamadas). Custo estimado: US$ ${usd.toFixed(4)} (precos de ${PRICES_VERIFIED_AT}).`,
  '',
  '| pesos rerank/sim/rrf | limiar | recall@5 | abstencao correta | falsa abstencao | falsa abstencao pelo limiar |',
  '|---|---|---|---|---|---|',
  ...cells.map((c) => `| ${c.weights} | ${c.threshold} | ${pct(c.recall5)} | ${pct(c.abstention)} | ${pct(c.falseAbstention)} | ${pct(c.falseAbstentionGate)} |`),
].join('\n');

const out = new URL('../results/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL(`calib-${provider}.json`, out), JSON.stringify({ stamp: new Date().toISOString(), provider, current, chosen, usage, usd, cells, rows }, null, 2));
await writeFile(new URL(`calib-${provider}.md`, out), md + '\n');
console.log(md);
