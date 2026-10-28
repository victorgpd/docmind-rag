import { afterAll, beforeAll, expect, it } from 'vitest';
import { chunks, collections, documents, withOrg } from '@docmind/db';
import { setupDb } from './helpers';

let ctx: Awaited<ReturnType<typeof setupDb>>;
let docA: string;
let colA: string;
const vec = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

beforeAll(async () => {
  ctx = await setupDb();
  const { h, orgA } = ctx;
  await withOrg(h.db, orgA, async (tx) => {
    const [c] = await tx.insert(collections).values({ organizationId: orgA, name: 'ca' }).returning();
    colA = c!.id;
    const [d] = await tx.insert(documents).values({
      organizationId: orgA, collectionId: colA, filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: 'k',
    }).returning();
    docA = d!.id;
    await tx.insert(chunks).values({
      organizationId: orgA, documentId: docA, collectionId: colA, ordinal: 0, page: 1, content: 'segredo da org A', embedding: vec,
    });
  });
});
afterAll(() => ctx.h.close());

it('org B nao ve colecoes, documentos nem chunks da org A', async () => {
  const { h, orgA, orgB } = ctx;
  for (const t of [collections, documents, chunks]) {
    expect(await withOrg(h.db, orgB, (tx) => tx.select().from(t))).toHaveLength(0);
    expect((await withOrg(h.db, orgA, (tx) => tx.select().from(t))).length).toBeGreaterThan(0);
  }
});

it('org B nao escreve com organization_id da org A (WITH CHECK)', async () => {
  const { h, orgA, orgB } = ctx;
  await expect(
    withOrg(h.db, orgB, (tx) => tx.insert(collections).values({ organizationId: orgA, name: 'invasao' })),
  ).rejects.toThrow();
});

it('org B nao altera nem apaga dados da org A', async () => {
  const { h, orgA, orgB } = ctx;
  await withOrg(h.db, orgB, (tx) => tx.delete(documents));
  expect(await withOrg(h.db, orgA, (tx) => tx.select().from(documents))).toHaveLength(1);
});

it('busca vetorial e full-text de B nao retornam chunks de A', async () => {
  const { h, orgB } = ctx;
  const lit = `[${vec.join(',')}]`;
  const rows = await withOrg(h.db, orgB, async (tx) => {
    const { sql } = await import('@docmind/db');
    const v = await tx.execute(sql`select id from chunks order by embedding <=> ${lit}::vector limit 5`);
    const f = await tx.execute(sql`select id from chunks where tsv @@ plainto_tsquery('simple', 'segredo')`);
    return [(v as any).rows ?? v, (f as any).rows ?? f] as const;
  });
  expect(rows[0]).toHaveLength(0);
  expect(rows[1]).toHaveLength(0);
});

it('withOrg rejeita orgId invalido (sem injecao via app.org_id)', async () => {
  await expect(withOrg(ctx.h.db, "x'; drop table chunks;--", async () => 1)).rejects.toThrow('invalid orgId');
});
