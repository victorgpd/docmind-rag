import { mkdir, writeFile } from 'node:fs/promises';
import { PRICES_VERIFIED_AT } from '@docmind/llm';
import { DEFAULT_RANK, type RankConfig } from '@docmind/retrieval';
import { createAdapter } from './adapter';
import { agentMarkdown, loadAgentData, runAgentEval } from './agent-eval';
import { addUsage, costUsd, emptyUsage, flag, providerFromArgs } from './cli';
import { aggregateOnly, runEval, toMarkdown, type DataSet, type RunInfo } from './runner';

// Uso: pnpm eval [--provider local|openai] [--min-relevance 0.17] [--weights 0.8/0.1/0.1] [--out nome] [--min-recall5 0.85] [--min-heldout-recall5 0.60] [--min-faithfulness 0.9]
// Exit 1 se a config com rerank ficar abaixo em dev ou held-out.
// Os limiares sao PISOS DE REGRESSAO, nao metas: evitam piorar, nao atestam qualidade.
//  - dev recall@5 0.85 e faithfulness 0.9: medidos em 2026-10-28 em 0.98 e 1.0.
//  - held-out recall@5 0.60: medido em 2026-10-28 em 0.67 (margem pequena). A meta 0.80 NAO foi atingida
//    com embeddings locais lexicais (ver evals/README.md). Nao otimizar o sistema sobre o held-out.
// --provider local (padrao, sem rede: o do gate de CI) grava results/latest.*; openai grava results/openai-latest.* (ver cli.ts).
// --min-relevance/--weights trocam so a config com rerank (padrao: DEFAULT_RANK); --out muda o nome dos arquivos.
const arg = (name: string, def: number) => (flag(name) === undefined ? def : Number(flag(name)));
const minRecall5 = { dev: arg('min-recall5', 0.85), heldout: arg('min-heldout-recall5', 0.6) };
const minFaith = arg('min-faithfulness', 0.9);
const { provider, openai } = providerFromArgs();
const usage = emptyUsage();
const weights = flag('weights')?.split('/').map(Number);
if (weights && (weights.length !== 3 || weights.some((w) => !(w >= 0)))) throw new Error('--weights rerank/sim/rrf, ex.: 0.8/0.1/0.1');
const rank: RankConfig | undefined =
  flag('min-relevance') !== undefined || weights
    ? {
        ...DEFAULT_RANK,
        minRelevance: arg('min-relevance', DEFAULT_RANK.minRelevance),
        ...(weights && { weights: { rerank: weights[0]!, sim: weights[1]!, rrf: weights[2]! } }),
      }
    : undefined;

// um indice limpo por conjunto: o held-out ve o corpus dev + os documentos novos
async function run(set: DataSet) {
  const rag = await createAdapter(openai, undefined, rank);
  try {
    const result = await runEval(rag, set);
    const stamp = new Date().toISOString();
    for (const [cfg, r] of [['sem-rerank', result.without_rerank], ['com-rerank', result.with_rerank]] as const)
      await rag.saveRun(`rag-${set}-${cfg}${openai ? `-${provider}` : ''} ${stamp}`, { overall: r.overall, categories: r.categories });
    return result;
  } finally {
    addUsage(usage, rag.usage);
    await rag.close();
  }
}

const dev = await run('dev');
const held = await run('heldout');

const out = new URL('../results/', import.meta.url);
await mkdir(out, { recursive: true });
// modo agente: indice proprio (corpus dev + documentos do agente). So no local: e o RAG que se mede com a OpenAI.
const agent = openai
  ? undefined
  : await (async () => {
      const agentData = await loadAgentData();
      const agentRag = await createAdapter();
      try {
        await agentRag.ingest(agentData.docs);
        return await runAgentEval(agentRag.agent, agentData.tasks);
      } finally {
        await agentRag.close();
      }
    })();

const info: RunInfo | undefined = openai && {
  provider,
  date: new Date().toISOString().slice(0, 10),
  embedModel: openai.embeddingModel,
  chatModel: openai.chatModel,
  temperature: openai.temperature ?? null,
  rerank: 'LocalReranker',
  rank: rank ?? DEFAULT_RANK,
  usage,
  usd: costUsd(openai, usage),
  pricesVerifiedAt: PRICES_VERIFIED_AT,
};
const md = [toMarkdown(dev, held, info), ...(agent ? [agentMarkdown(agent)] : [])].join('\n\n');
const name = flag('out') ?? (openai ? `${provider}-latest` : 'latest');
if (!/^[\w-]+$/.test(name)) throw new Error(`--out ${name}: use letras, numeros, _ ou -`);
await writeFile(
  new URL(`${name}.json`, out),
  JSON.stringify({ stamp: new Date().toISOString(), ...(info && { run: info }), dev, heldout: aggregateOnly(held), ...(agent && { agent }) }, null, 2),
);
await writeFile(new URL(`${name}.md`, out), md + '\n');
console.log(md);

const fails = (['dev', 'heldout'] as const).flatMap((set) => {
  const m = (set === 'dev' ? dev : held).with_rerank.overall;
  return [
    m['recall@5']! < minRecall5[set] && `${set}: recall@5 ${m['recall@5']} < ${minRecall5[set]}`,
    m.list_mismatches! > 0 && `${set}: ${m.list_mismatches} perguntas com search() != lista do prompt`,
    m.faithfulness! < minFaith && `${set}: faithfulness ${m.faithfulness} < ${minFaith}`,
  ].filter(Boolean);
});
if (fails.length) {
  console.error(`\nFALHOU: ${fails.join('; ')}`);
  process.exitCode = 1;
}
