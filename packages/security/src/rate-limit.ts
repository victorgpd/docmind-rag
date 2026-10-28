import type { Request, RequestHandler } from 'express';
import { Redis } from 'ioredis';

export type HitResult = { allowed: boolean; remaining: number; resetMs: number };

export interface RateLimiter {
  /** Conta uma chamada em `key` na janela atual (janela fixa). */
  hit(key: string, limit: number, windowMs: number): Promise<HitResult>;
  close?(): Promise<void>;
}

/** Memoria do processo (shortcut: nao compartilha contador entre instancias da API; use REDIS_URL em producao). */
export function memoryLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key, limit, windowMs) {
      const t = now();
      let b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        // limpeza oportunista para o Map nao crescer sem limite
        if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
        buckets.set(key, (b = { count: 0, resetAt: t + windowMs }));
      }
      b.count++;
      return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetMs: b.resetAt - t };
    },
  };
}

export function redisLimiter(redis: Redis): RateLimiter {
  return {
    async hit(key, limit, windowMs) {
      const k = `rl:${key}`;
      // NX: so define o TTL na primeira chamada da janela
      const [count, , ttl] = (await redis
        .multi()
        .incr(k)
        .pexpire(k, windowMs, 'NX')
        .pttl(k)
        .exec()
        .then((r) => r!.map(([err, v]) => {
          if (err) throw err;
          return v as number;
        }))) as [number, number, number];
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetMs: ttl };
    },
    close: async () => void (await redis.quit()),
  };
}

/** Redis se `redisUrl` (REDIS_URL) estiver setada, senao memoria. */
export function createRateLimiter(redisUrl?: string): RateLimiter {
  return redisUrl ? redisLimiter(new Redis(redisUrl, { maxRetriesPerRequest: 2 })) : memoryLimiter();
}

export type Rule = { limit: number; windowMs: number };

export type RateLimitOptions = {
  limiter: RateLimiter;
  /** Quem e a requisicao. Sem userId/orgId (rota publica), cai para o IP e usa a regra de usuario. */
  identify: (req: Request) => { userId?: string; orgId?: string } | undefined;
  user: Rule;
  org: Rule;
};

/** Registre DEPOIS do middleware que autentica e preenche o usuario da requisicao. */
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    const id = opts.identify(req);
    const checks: [string, Rule][] = [[`user:${id?.userId ?? `ip:${req.ip}`}`, opts.user]];
    if (id?.orgId) checks.push([`org:${id.orgId}`, opts.org]);

    for (const [key, rule] of checks) {
      const r = await opts.limiter.hit(key, rule.limit, rule.windowMs);
      if (!r.allowed) {
        const retryAfter = Math.max(1, Math.ceil(r.resetMs / 1000));
        res.set('retry-after', String(retryAfter)).status(429).json({
          error: { code: 'rate_limited', message: `Limite de requisicoes excedido (${key.split(':')[0]}). Tente em ${retryAfter}s.` },
        });
        return;
      }
    }
    next();
  };
}
