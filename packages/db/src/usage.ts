import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { usageEvents } from './schema';

const TTL_MS = 30_000;
const cache = new WeakMap<Db, { at: number; month: number; tokens: number }>();

/**
 * Tokens (entrada + saida) de TODAS as organizacoes no mes corrente (UTC). `db` e a conexao privilegiada (fora do RLS):
 * nunca chame dentro de withOrg (no PGlite, conexao unica, a consulta esperaria a transacao aberta).
 * shortcut: cache de 30 s por banco (por processo); o teto pode ser ultrapassado pelo que se gastar nessa janela.
 */
export async function globalMonthlyTokens(db: Db, now = new Date()): Promise<number> {
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const hit = cache.get(db);
  if (hit && hit.month === month && now.getTime() - hit.at < TTL_MS) return hit.tokens;
  const [r] = await db
    .select({ t: sql<number>`coalesce(sum(${usageEvents.tokensIn} + ${usageEvents.tokensOut}), 0)` })
    .from(usageEvents)
    .where(sql`${usageEvents.createdAt} >= ${new Date(month).toISOString()}::timestamptz`);
  const tokens = Number(r!.t);
  cache.set(db, { at: now.getTime(), month, tokens });
  return tokens;
}

/** Teto global do servico (GLOBAL_MONTHLY_TOKEN_LIMIT); limit 0 desliga sem consultar o banco. */
export const globalLimitReached = async (db: Db, limit: number) => limit > 0 && (await globalMonthlyTokens(db)) >= limit;
