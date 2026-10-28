import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { collections, createDb, documents, organizations, usageEvents, users, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { API_PREFIX } from '@docmind/shared';
import { createStorage } from '@docmind/storage';
import { buildApp } from './app';
import { signAccess } from './http/auth';

// Controle de custo com cadastro aberto: teto global de tokens (todas as organizacoes) e limites de cadastro.
let db: DbHandle;
const SECRET = 'x'.repeat(40);
const url = (p: string) => `${API_PREFIX}${p}`;
const build = (env: Record<string, string> = {}) =>
  buildApp({
    config: loadConfig({ NODE_ENV: 'test', JWT_SECRET: SECRET, ...env }),
    db,
    llm: createLLM(),
    queue: createQueue(),
    storage: createStorage({ dir: './data/test' }),
    logStream: { write() {} },
  });
const sse = (res: any, cb: (e: Error | null, b?: string) => void) => {
  let d = '';
  res.setEncoding('utf8');
  res.on('data', (c: string) => (d += c));
  res.on('end', () => cb(null, d));
};

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
  // outra organizacao ja gastou o teto global padrao (2M) neste mes; o primeiro calculo do teto acontece depois disto
  const [big] = await db.db.insert(organizations).values({ name: 'big', slug: `big-${crypto.randomUUID()}` }).returning();
  await db.db.insert(usageEvents).values({ organizationId: big!.id, kind: 'query', tokensIn: 1_500_000, tokensOut: 500_000 });
}, 60_000);
afterAll(() => db.close());

/** Organizacao nova e zerada (como um cadastro recem-feito), com uma conversa e um documento pending. */
async function freshOrg(app: ReturnType<typeof build>) {
  const [org] = await db.db.insert(organizations).values({ name: 'nova', slug: `nova-${crypto.randomUUID()}` }).returning();
  const [u] = await db.db.insert(users).values({ organizationId: org!.id, email: `${crypto.randomUUID()}@x.com`, name: 'N', passwordHash: 'x' }).returning();
  const [col] = await db.db.insert(collections).values({ organizationId: org!.id, name: 'C' }).returning();
  const [doc] = await db.db
    .insert(documents)
    .values({ organizationId: org!.id, collectionId: col!.id, filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: 'k' })
    .returning();
  const auth = { Authorization: `Bearer ${signAccess(SECRET, { userId: u!.id, orgId: org!.id, role: 'admin' })}` };
  const conv = (await request(app).post(url('/conversations')).set(auth).send({})).body;
  const calls = [
    [`/conversations/${conv.id}/messages`, { content: 'oi' }],
    [`/conversations/${conv.id}/messages`, { content: 'oi', agent: true }],
    ['/agent/run', { query: 'oi' }],
    [`/documents/${doc!.id}/process`, {}],
  ] as const;
  return { auth, convId: conv.id as string, calls };
}

it('teto global atingido por outra org: chat, modo agente, /agent/run e /process de uma org nova e zerada dao 402 global_limit_exceeded', async () => {
  const app = build();
  const { auth, convId, calls } = await freshOrg(app);
  for (const [path, body] of calls) {
    const r = await request(app).post(url(path)).set(auth).send(body);
    expect(r.status, path).toBe(402);
    expect(r.body.error).toEqual({ code: 'global_limit_exceeded', message: 'O limite de uso do serviço foi atingido este mês. Tente novamente mais tarde.' });
  }
  expect((await request(app).get(url(`/conversations/${convId}`)).set(auth)).body.messages).toEqual([]);
  // /usage avisa sem expor o consumo das outras organizacoes
  const usage = (await request(app).get(url('/usage')).set(auth)).body;
  expect(usage).toMatchObject({ tokensIn: 0, tokensOut: 0, limitExceeded: false, serviceLimitReached: true });
});

it.each([
  ['abaixo do teto', '3000000'],
  ['0 desliga', '0'],
])('teto global %s: chat, agente e /process seguem', async (_name, limit) => {
  const app = build({ GLOBAL_MONTHLY_TOKEN_LIMIT: limit });
  const { auth, calls } = await freshOrg(app);
  for (const [path, body] of calls) {
    const r = await request(app).post(url(path)).set(auth).buffer(true).parse(sse).send(body);
    expect(r.status, path).toBe(path.endsWith('/process') ? 202 : 200);
  }
  expect((await request(app).get(url('/usage')).set(auth)).body.serviceLimitReached).toBe(false);
});

it('cadastro: padrao de producao e 5 por IP por dia; o 6o do mesmo IP da 429 com retry-after, outro IP passa', async () => {
  const app = build({ NODE_ENV: 'production', TRUST_PROXY: '1', CORS_ORIGINS: 'https://docmind.example.com' });
  const reg = (ip: string) =>
    request(app)
      .post(url('/auth/register'))
      .set('X-Forwarded-For', ip)
      .send({ email: `r-${crypto.randomUUID()}@x.com`, password: 'senha-forte-123', name: 'R', organizationName: 'R' });
  for (let i = 0; i < 5; i++) expect((await reg('203.0.113.7')).status).toBe(201);
  const blocked = await reg('203.0.113.7');
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(3600);
  expect(blocked.body.error.message).toMatch(/^Limite de cadastros deste endereço atingido hoje/);
  expect((await reg('198.51.100.9')).status).toBe(201);
});

it('REGISTRATION_ENABLED=false: /auth/register da 403 registration_closed; login segue', async () => {
  const app = build({ REGISTRATION_ENABLED: 'false' });
  const r = await request(app).post(url('/auth/register')).send({ email: 'a@x.com', password: 'senha-forte-123', name: 'A', organizationName: 'A' });
  expect(r.status).toBe(403);
  expect(r.body.error).toEqual({ code: 'registration_closed', message: 'Cadastro fechado no momento.' });
  expect((await request(app).post(url('/auth/login')).send({ email: 'a@x.com', password: 'senha-forte-123' })).status).toBe(401);
});
