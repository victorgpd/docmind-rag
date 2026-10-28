import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDb, sql } from './index';

it('aplica cada migration uma vez e e idempotente', async () => {
  const h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  await h.migrate();
  const r: any = await h.db.execute(sql`select name from _migrations order by name`);
  const names = (r.rows ?? r).map((x: any) => x.name);
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  expect(names).toEqual(files);
  await h.close();
});

it('cria pgliteDir com pastas-pai inexistentes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dm-pg-'));
  const h = await createDb({ pgliteDir: join(root, 'a', 'b', 'pglite') });
  await h.migrate();
  await h.close();
  await rm(root, { recursive: true, force: true });
}, 30_000);
