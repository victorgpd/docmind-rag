import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, sql } from './index';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const rows = (r: any): any[] => r.rows ?? r;

let shared: Awaited<ReturnType<typeof createDb>>;
beforeAll(async () => {
  shared = await createDb({ pgliteDir: ':memory:' });
  await shared.migrate();
});
afterAll(() => shared.close());

it('migrations tem numeracao unica e sequencial', async () => {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  expect(files.map((f) => Number(f.slice(0, 4)))).toEqual(files.map((_, i) => i));
});

it('toda tabela com organization_id tem RLS habilitada e forcada (ou nenhum acesso para docmind_app)', async () => {
  const h = shared;
  const r = rows(
    await h.db.execute(sql`
      select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (has_table_privilege('docmind_app', c.oid, 'SELECT') or has_table_privilege('docmind_app', c.oid, 'INSERT')
          or has_table_privilege('docmind_app', c.oid, 'UPDATE') or has_table_privilege('docmind_app', c.oid, 'DELETE')) as app_access
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relname = 'organizations'
          or exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'organization_id'))`),
  );
  expect(r.length).toBeGreaterThan(5);
  const bad = r.filter((x) => x.app_access && !(x.rls && x.forced)).map((x) => x.t);
  expect(bad).toEqual([]);
  // refresh_tokens e a unica fora do RLS, e docmind_app nao enxerga
  expect(r.filter((x) => !(x.rls && x.forced)).map((x) => x.t)).toEqual(['refresh_tokens']);
});

it('docmind_app nao ganha acesso a tabela nova nem altera esquema/politicas', async () => {
  const h = shared;
  await h.db.execute(sql`create table zz_nova (id int, organization_id uuid)`);
  const q = async (s: ReturnType<typeof sql>) => rows(await h.db.execute(s))[0];
  expect((await q(sql`select has_table_privilege('docmind_app', 'zz_nova', 'SELECT') as v`)).v).toBe(false);
  expect((await q(sql`select has_schema_privilege('docmind_app', 'public', 'CREATE') as v`)).v).toBe(false);
  const role = await q(sql`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'docmind_app'`);
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
  // sem default privileges para o papel e sem ser dono de nada
  expect(rows(await h.db.execute(sql`select 1 from pg_default_acl d, aclexplode(d.defaclacl) a join pg_roles r on r.oid = a.grantee where r.rolname = 'docmind_app'`))).toHaveLength(0);
  expect(rows(await h.db.execute(sql`select 1 from pg_tables where tableowner = 'docmind_app'`))).toHaveLength(0);
});

it('banco antigo (so 0000, sem tabela de controle) chega ao estado atual', async () => {
  const h = await createDb({ pgliteDir: ':memory:' });
  await h.exec(await readFile(new URL('0000_init.sql', MIGRATIONS), 'utf8'));
  // chunk pre-existente: precisa receber o embedding_model de backfill da 0007
  await h.exec(`
    insert into organizations (id, name, slug) values ('00000000-0000-0000-0000-0000000000a1', 'O', 'o');
    insert into collections (id, organization_id, name) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'c');
    insert into documents (id, organization_id, collection_id, filename, mime_type, size_bytes, storage_key)
      values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'f', 'text/plain', 1, 'k');
    insert into chunks (organization_id, document_id, collection_id, ordinal, content)
      values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', 0, 'x');`);
  await h.migrate();
  expect(rows(await h.db.execute(sql`select embedding_model from chunks`)).map((x) => x.embedding_model)).toEqual(['local:hash-v2:384']);
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  expect(rows(await h.db.execute(sql`select name from _migrations order by name`)).map((x) => x.name)).toEqual(files);
  await h.migrate(); // idempotente
  await h.close();
});
