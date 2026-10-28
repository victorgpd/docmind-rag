// Carga leve da busca: `pnpm --filter @docmind/retrieval bench [chunks] [consultas]` (padrão 5000 / 40).
// Mede, em PGlite em memória com HNSW + GIN, a latência p50/p95 de cada etapa e do pipeline completo.
import { chunks, collections, createDb, documents, organizations, sql, users } from '@docmind/db';
import { createReranker, hashEmbed, LocalProvider } from '@docmind/llm';
import { buildMessages } from './prompt';
import { createRag, SemanticCache, retrieve, DEFAULT_RANK } from './index';

const N = Number(process.argv[2]) || 5000;
const Q = Number(process.argv[3]) || 40;

// PRNG determinístico: resultados comparáveis entre execuções
let seed = 42;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const VOCAB = Array.from({ length: 3000 }, (_, i) => `termo${i.toString(36)}`);
const word = () => VOCAB[Math.floor(rnd() ** 2 * VOCAB.length)]!; // cauda longa: poucos termos muito comuns
const text = (n: number) => Array.from({ length: n }, word).join(' ');

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const row = (name: string, xs: number[]) =>
  `${name.padEnd(22)} p50 ${pct(xs, 50).toFixed(1).padStart(7)} ms   p95 ${pct(xs, 95).toFixed(1).padStart(7)} ms   média ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1).padStart(7)} ms`;

const h = await createDb({ pgliteDir: ':memory:' });
await h.migrate();
const [org] = await h.db.insert(organizations).values({ name: 'bench', slug: 'bench' }).returning();
const [user] = await h.db.insert(users).values({ organizationId: org!.id, email: 'b@x.com', name: 'b', passwordHash: 'x' }).returning();
const [col] = await h.db.insert(collections).values({ organizationId: org!.id, name: 'c' }).returning();
const [doc] = await h.db
  .insert(documents)
  .values({ organizationId: org!.id, collectionId: col!.id, filename: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: 'k', status: 'ready' })
  .returning();

const llm = new LocalProvider();
const contents = Array.from({ length: N }, () => text(40));
let t = performance.now();
for (let i = 0; i < N; i += 250) {
  await h.db.insert(chunks).values(
    contents.slice(i, i + 250).map((content, j) => ({
      organizationId: org!.id, documentId: doc!.id, collectionId: col!.id, ordinal: i + j, page: ((i + j) % 200) + 1, content, embedding: hashEmbed(content), embeddingModel: llm.embeddingModel,
    })),
  );
}
console.log(`ingestão de ${N} chunks (com HNSW+GIN): ${((performance.now() - t) / 1000).toFixed(1)} s\n`);

const reranker = createReranker();
const rank = { ...DEFAULT_RANK, minRelevance: 0 };
const queries = Array.from({ length: Q }, () => contents[Math.floor(rnd() * N)]!.split(' ').slice(0, 6).join(' '));

async function measure(label: string) {
  const stage: Record<string, number[]> = { embed: [], vector: [], text: [], fuse: [], rank: [], retrieve: [], prompt: [], generate: [], answer: [] };
  const push = (k: string, v: number) => stage[k]!.push(v);
  // aquecimento (JIT, planos de consulta)
  for (const q of queries.slice(0, 3)) await retrieve({ db: h.db, llm, reranker, rank }, { orgId: org!.id, query: q, collectionId: col!.id });
  for (const q of queries) {
    const timings: Record<string, number> = {};
    t = performance.now();
    const r = await retrieve({ db: h.db, llm, reranker, rank }, { orgId: org!.id, query: q, collectionId: col!.id, timings });
    push('retrieve', performance.now() - t);
    for (const k of ['embed', 'vector', 'text', 'fuse', 'rank']) push(k, timings[k] ?? 0);
    t = performance.now();
    const messages = buildMessages(q, [], r.passages);
    push('prompt', performance.now() - t);
    t = performance.now();
    for await (const _ of llm.generateStream(messages)) void _;
    push('generate', performance.now() - t);
    t = performance.now();
    for await (const _ of createRag({ db: h.db, llm, reranker, cache: new SemanticCache(), rank }).answer({
      orgId: org!.id, userId: user!.id, collectionId: col!.id, question: q, history: [],
    }))
      void _;
    push('answer', performance.now() - t);
  }
  console.log(`## ${label}: ${N} chunks, ${Q} consultas (6 termos), top30+top30 -> RRF -> rerank -> top${DEFAULT_RANK.topK}`);
  for (const k of Object.keys(stage)) console.log(row(k, stage[k]!));
  console.log();
}

await measure('SEM estatísticas do planner (logo após a carga em lote)');
t = performance.now();
await h.db.execute(sql`analyze chunks`);
console.log(`ANALYZE chunks: ${(performance.now() - t).toFixed(0)} ms
`);
await measure('COM ANALYZE');
console.log('answer = pipeline completo (embed, busca, rank, prompt, gerador local, usage_events), cache frio.');
await h.close();
