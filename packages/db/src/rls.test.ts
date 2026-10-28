import { expect, it } from 'vitest';
import { collections, createDb, organizations, withOrg } from './index';

it('isola dados por organizacao via RLS', async () => {
  const h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  const [a, b] = await h.db.insert(organizations).values([
    { name: 'A', slug: 'a' },
    { name: 'B', slug: 'b' },
  ]).returning();
  await withOrg(h.db, a!.id, (tx) => tx.insert(collections).values({ organizationId: a!.id, name: 'ca' }));
  const seenByB = await withOrg(h.db, b!.id, (tx) => tx.select().from(collections));
  const seenByA = await withOrg(h.db, a!.id, (tx) => tx.select().from(collections));
  expect(seenByB).toHaveLength(0);
  expect(seenByA).toHaveLength(1);
  await h.close();
}, 60000);
