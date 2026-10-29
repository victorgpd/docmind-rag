import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Db = PgDatabase<any, typeof schema>;
export type DbHandle = {
  db: Db;
  kind: 'pglite' | 'postgres';
  /** Aplica migrations/*.sql pendentes, em ordem, uma vez cada (tabela de controle _migrations). */
  migrate(): Promise<void>;
  /** SQL cru, multi-statement, sem parametros (usado por migrations e testes). */
  exec(sqlText: string): Promise<void>;
  close(): Promise<void>;
};

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

/** DATABASE_URL setado => Postgres real; senao PGlite (arquivo em pgliteDir, ou memoria se ':memory:'). */
export async function createDb(opts: { databaseUrl?: string; pgliteDir?: string } = {}): Promise<DbHandle> {
  let db: Db;
  let kind: DbHandle['kind'];
  let exec: (q: string) => Promise<unknown>;
  let close: () => Promise<void>;

  if (opts.databaseUrl) {
    const [{ default: pg }, { drizzle }] = await Promise.all([import('pg'), import('drizzle-orm/node-postgres')]);
    const pool = new pg.Pool({ connectionString: opts.databaseUrl });
    db = drizzle(pool, { schema }) as unknown as Db;
    kind = 'postgres';
    exec = (q) => pool.query(q);
    close = () => pool.end();
  } else {
    const [{ PGlite }, { vector }, { drizzle }] = await Promise.all([
      import('@electric-sql/pglite'),
      import('@electric-sql/pglite/vector'),
      import('drizzle-orm/pglite'),
    ]);
    const dir = opts.pgliteDir && opts.pgliteDir !== ':memory:' ? opts.pgliteDir : undefined;
    if (dir) await mkdir(dir, { recursive: true }); // pasta-pai inexistente quebrava o PGlite
    const client = new PGlite({ ...(dir ? { dataDir: dir } : {}), extensions: { vector } });
    await client.waitReady;
    db = drizzle(client, { schema }) as unknown as Db;
    kind = 'pglite';
    exec = (q) => client.exec(q);
    close = () => client.close();
  }

  return {
    db,
    kind,
    close,
    exec: async (q) => void (await exec(q)),
    async migrate() {
      const rowsOf = (r: any): any[] => r.rows ?? r;
      await db.execute(sql`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`);
      const files = (await readdir(fileURLToPath(MIGRATIONS_DIR))).filter((f) => f.endsWith('.sql')).sort();
      const applied = new Set(rowsOf(await db.execute(sql`select name from _migrations`)).map((r) => r.name));
      // bancos criados antes da tabela de controle: o init ja foi aplicado
      if (!applied.size && files[0] && rowsOf(await db.execute(sql`select to_regclass('public.organizations') as t`))[0]?.t) {
        await db.execute(sql`insert into _migrations (name) values (${files[0]})`);
        applied.add(files[0]);
      }
      for (const f of files) {
        if (applied.has(f)) continue;
        await exec(await readFile(new URL(f, MIGRATIONS_DIR), 'utf8'));
        await db.execute(sql`insert into _migrations (name) values (${f})`);
      }
    },
  };
}

/** Executa fn numa transacao com RLS ativo para a organizacao (role docmind_app + app.org_id). */
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error('invalid orgId');
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role docmind_app`);
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Só abre transações com RLS (withOrg). Busca e agente recebem isto, nunca o Db privilegiado: esquecer o withOrg deixa de ser possível. */
export type OrgScope = <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
export const orgScope = (db: Db): OrgScope => (orgId, fn) => withOrg(db, orgId, fn);
