import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { memoryLimiter, rateLimit } from '@docmind/security';

function app(now: () => number) {
  const a = express();
  a.use(
    rateLimit({
      limiter: memoryLimiter(now),
      identify: (req) => ({ userId: req.get('x-user'), orgId: req.get('x-org') }),
      user: { limit: 3, windowMs: 1000 },
      org: { limit: 4, windowMs: 1000 },
    }),
  );
  a.get('/x', (_req, res) => void res.json({ ok: true }));
  return a;
}
const get = (a: ReturnType<typeof app>, user: string, org = 'o1') => request(a).get('/x').set('x-user', user).set('x-org', org);

it('bloqueia o usuario acima do limite com 429 e retry-after', async () => {
  const a = app(() => 0);
  for (let i = 0; i < 3; i++) expect((await get(a, 'u1')).status).toBe(200);
  const r = await get(a, 'u1');
  expect(r.status).toBe(429);
  expect(r.headers['retry-after']).toBe('1');
  expect(r.body.error.code).toBe('rate_limited');
  expect((await get(a, 'u2')).status).toBe(200); // outro usuario nao e afetado
});

it('limite por organizacao vale somando usuarios', async () => {
  const a = app(() => 0);
  for (const u of ['a', 'b', 'c', 'd']) expect((await get(a, u)).status).toBe(200);
  expect((await get(a, 'e')).status).toBe(429);
  expect((await get(a, 'f', 'o2')).status).toBe(200);
});

it('libera de novo apos a janela', async () => {
  let t = 0;
  const a = app(() => t);
  for (let i = 0; i < 3; i++) await get(a, 'u1');
  expect((await get(a, 'u1')).status).toBe(429);
  t = 1001;
  expect((await get(a, 'u1')).status).toBe(200);
});
