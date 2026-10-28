import { afterAll, beforeAll, expect, it } from 'vitest';
import { chunks, collections, createDb, documents, organizations, sql, withOrg, type DbHandle } from '@docmind/db';
import { hashEmbed } from '@docmind/llm';
import { hybridSearch } from './search';

// Org de 5000 chunks (coleções de 50, 500, 1500 e 2950) e consultas "fora do tema" para a coleção-alvo de 1500 (30%):
// os vizinhos mais próximos estão na outra coleção, e o filtro, aplicado depois da varredura do HNSW com ef_search=40,
// esvazia o top-30 (medido: 2,5 linhas e 7% de recall). Mesmo layout e semente da medição que motivou a mitigação.
let h: DbHandle;
let orgId: string;
let target: string;
let queries: number[][];
let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const region = (lo: number, hi: number) => () => `termo${(lo + Math.floor(rnd() ** 2 * (hi - lo))).toString(36)}`;
const make = (n: number, w: () => string) => Array.from({ length: n }, () => Array.from({ length: 40 }, w).join(' '));

async function load(name: string, texts: string[]) {
  const [c] = await h.db.insert(collections).values({ organizationId: orgId, name }).returning();
  const [d] = await h.db
    .insert(documents)
    .values({ organizationId: orgId, collectionId: c!.id, filename: name, mimeType: 'x', sizeBytes: 1, storageKey: name, status: 'ready' })
    .returning();
  for (let i = 0; i < texts.length; i += 250)
    await h.db.insert(chunks).values(
      texts.slice(i, i + 250).map((t, j) => ({ organizationId: orgId, documentId: d!.id, collectionId: c!.id, ordinal: i + j, page: 1, content: t, embedding: hashEmbed(t) })),
    );
  return c!.id;
}

beforeAll(async () => {
  h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  const [org] = await h.db.insert(organizations).values({ name: 'f', slug: 'f' }).returning();
  orgId = org!.id;
  await load('s', make(50, region(0, 300)));
  await load('m', make(500, region(300, 1000)));
  target = await load('alvo', make(1500, region(1000, 1800)));
  const rest = make(2950, region(1800, 3000));
  await load('resto', rest);
  await h.db.execute(sql`analyze chunks`); // como o worker faz ao esvaziar a fila: o planner precisa das estatísticas
  queries = Array.from({ length: 8 }, () => hashEmbed(rest[Math.floor(rnd() * rest.length)]!.split(' ').slice(0, 6).join(' ')));
}, 120000);
afterAll(() => h.close());

const exactTop30 = (embedding: number[]) =>
  withOrg(h.db, orgId, async (tx) => {
    await tx.execute(sql`select set_config('enable_indexscan', 'off', true)`);
    const r: any = await tx.execute(sql`select id from chunks where embedding is not null and collection_id = ${target}
      order by embedding <=> ${`[${embedding.join(',')}]`}::vector limit 30`);
    return (r.rows ?? r).map((x: any) => x.id as string);
  });
const filtered = (embedding: number[], iterative: boolean) =>
  withOrg(h.db, orgId, (tx) => hybridSearch(tx, { embedding, text: '', collectionId: target, iterative }));

it('filtro de coleção devolve o top-30 completo e igual ao exato (scan iterativo + ef_search maior)', async () => {
  for (const q of queries) {
    const got = (await filtered(q, true)).map((p) => p.id);
    const truth = await exactTop30(q);
    expect(got).toHaveLength(30);
    expect(got.filter((id) => truth.includes(id)).length / 30).toBeGreaterThanOrEqual(0.95);
  }
}, 120000);

it('sem a mitigação o mesmo cenário perde linhas ou recall (documenta o problema que o teste anterior cobre)', async () => {
  let worst = 1;
  for (const q of queries) {
    const got = (await filtered(q, false)).map((p) => p.id);
    const truth = await exactTop30(q);
    worst = Math.min(worst, got.filter((id) => truth.includes(id)).length / 30);
  }
  expect(worst).toBeLessThan(0.95);
}, 120000);
