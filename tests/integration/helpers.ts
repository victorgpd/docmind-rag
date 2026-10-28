import { createDb, organizations } from '@docmind/db';

/** PGlite em memoria, migrado, com duas organizacoes (A e B). */
export async function setupDb() {
  const h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  const [a, b] = await h.db.insert(organizations).values([
    { name: 'Org A', slug: 'org-a' },
    { name: 'Org B', slug: 'org-b' },
  ]).returning();
  return { h, orgA: a!.id, orgB: b!.id };
}
