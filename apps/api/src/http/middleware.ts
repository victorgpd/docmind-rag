import type { RequestHandler } from 'express';
import { createRateLimiter, type RateLimiter, type Rule } from '@docmind/security';

/** Rate limit por usuario (ou IP, se anonimo) e por organizacao. `scope` separa contadores de rotas diferentes. */
export const rateLimit = (limiter: RateLimiter, rules: { user: Rule; org?: Rule }, scope = 'api'): RequestHandler =>
  async (req, res, next) => {
    const checks: [string, Rule][] = [[`${scope}:user:${req.auth?.userId ?? `ip:${req.ip}`}`, rules.user]];
    if (req.auth && rules.org) checks.push([`${scope}:org:${req.auth.orgId}`, rules.org]);
    for (const [key, rule] of checks) {
      const r = await limiter.hit(key, rule.limit, rule.windowMs);
      if (!r.allowed) {
        const retryAfter = Math.max(1, Math.ceil(r.resetMs / 1000));
        return void res.set('retry-after', String(retryAfter)).status(429).json({ error: { code: 'rate_limited', message: `Too many requests. Retry in ${retryAfter}s.` } });
      }
    }
    next();
  };

/** Limite por chave arbitraria (ex.: IP, e-mail). keyFn devolve undefined para pular. */
export const rateLimitBy =
  (
    limiter: RateLimiter,
    scope: string,
    rule: Rule,
    keyFn: (req: import('express').Request) => string | undefined,
    message = (retryAfter: number) => `Too many requests. Retry in ${retryAfter}s.`,
  ): RequestHandler =>
  async (req, res, next) => {
    const key = keyFn(req);
    if (key) {
      const r = await limiter.hit(`${scope}:${key}`, rule.limit, rule.windowMs);
      if (!r.allowed) {
        const retryAfter = Math.max(1, Math.ceil(r.resetMs / 1000));
        return void res.set('retry-after', String(retryAfter)).status(429).json({ error: { code: 'rate_limited', message: message(retryAfter) } });
      }
    }
    next();
  };

export { createRateLimiter };
