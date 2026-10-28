import { loadConfig, type Config } from '@docmind/config';
import { globalLimitReached, sql, usageEvents, documents } from '@docmind/db';
import type { Db } from '@docmind/db';
import { UsageQuery, UsageReport } from '@docmind/shared';
import { Router } from 'express';
import type { Deps } from '../app';
import { authenticate, withOrg } from '../http/auth';
import { HttpError } from '../http/errors';
import { validate } from '../http/validate';

export const SERVICE_LIMIT_MESSAGE = 'O limite de uso do serviço foi atingido este mês. Tente novamente mais tarde.';
const serviceLimitReached = (deps: Deps) => globalLimitReached(deps.db.db, deps.config.GLOBAL_MONTHLY_TOKEN_LIMIT);

/** 402 quando o teto global (todas as organizacoes) foi atingido: chat, agente e /process. Chame FORA de withOrg (conexao privilegiada). */
export async function assertWithinGlobalLimit(deps: Deps) {
  if (await serviceLimitReached(deps)) throw new HttpError(402, 'global_limit_exceeded', SERVICE_LIMIT_MESSAGE);
}

type UsageConfig = Pick<Config, 'MONTHLY_TOKEN_LIMIT' | 'USAGE_PRICE_IN_PER_1M' | 'USAGE_PRICE_OUT_PER_1M'>;

export function monthRange(now = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from, to };
}

/** Consumo da organizacao no periodo [from, to). `tx` deve vir de withOrg. Reutilizavel pelo chat para aplicar o limite. */
export async function getUsage(tx: Db, range = monthRange(), cfg: UsageConfig = loadConfig()) {
  const inRange = sql`${usageEvents.createdAt} >= ${range.from.toISOString()}::timestamptz and ${usageEvents.createdAt} < ${range.to.toISOString()}::timestamptz`;
  const [u] = await tx
    .select({
      queries: sql<number>`count(*) filter (where ${usageEvents.kind} = 'query')`,
      tokensIn: sql<number>`coalesce(sum(${usageEvents.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${usageEvents.tokensOut}), 0)`,
    })
    .from(usageEvents)
    .where(inRange);
  const [d] = await tx.select({ n: sql<number>`count(*)` }).from(documents);
  const tokensIn = Number(u!.tokensIn);
  const tokensOut = Number(u!.tokensOut);
  const limit = cfg.MONTHLY_TOKEN_LIMIT;
  return {
    queries: Number(u!.queries),
    tokensIn,
    tokensOut,
    documents: Number(d!.n),
    costUsd: (tokensIn * cfg.USAGE_PRICE_IN_PER_1M + tokensOut * cfg.USAGE_PRICE_OUT_PER_1M) / 1e6,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    monthlyTokenLimit: limit,
    // shortcut: compara o periodo consultado com o limite mensal; so e exato com o periodo padrao (mes corrente)
    limitExceeded: tokensIn + tokensOut >= limit,
  };
}

export function usageRouter(deps: Deps) {
  const r = Router();
  r.get('/usage', authenticate, validate({ query: UsageQuery }), async (req, res) => {
    const def = monthRange();
    const { from, to } = req.query as { from?: string; to?: string };
    const range = { from: from ? new Date(from) : def.from, to: to ? new Date(to) : def.to };
    const usage = await withOrg(req, (tx) => getUsage(tx, range, deps.config));
    res.json(UsageReport.parse({ ...usage, serviceLimitReached: await serviceLimitReached(deps) }));
  });
  return r;
}
