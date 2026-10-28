import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb, refreshTokens, sql, usageEvents, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { buildApp } from '../app';
import { purgeExpiredRefreshTokens } from './auth';

let db: DbHandle;
let app: ReturnType<typeof buildApp>;
const build = (env: Record<string, string> = {}) =>
  buildApp({ config: loadConfig({ NODE_ENV: 'test', ...env }), db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
  app = build({ AUTH_RATE_LIMIT: '1000' }); // os testes nao devem esbarrar no limite de /auth; o teste de rate limit usa o seu
}, 60000);
afterAll(async () => {
  await db.close();
});

const PASS = 'senha-forte-1';
const api = (a = app) => ({
  get: (url: string, token?: string) => request(a).get(`/api/v1${url}`).set(token ? { Authorization: `Bearer ${token}` } : {}),
  post: (url: string, token?: string, body?: object, cookie?: string) =>
    request(a).post(`/api/v1${url}`).set({ ...(token && { Authorization: `Bearer ${token}` }), ...(cookie && { Cookie: cookie }) }).send(body),
  patch: (url: string, token: string, body: object) => request(a).patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  del: (url: string, token: string) => request(a).delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
});
const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('refresh_token='))?.split(';')[0];

const register = async (email: string, org = 'Acme') => {
  const res = await api().post('/auth/register', undefined, { email, password: PASS, name: 'Fulano', organizationName: org });
  return { res, token: res.body.token as string, user: res.body.user, cookie: cookieOf(res)! };
};

it('register e login com cookie httpOnly; email duplicado 409; credenciais erradas 401', async () => {
  const a = await register('a@x.com');
  expect(a.res.status).toBe(201);
  expect((a.res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/HttpOnly/i);
  expect((await register('A@x.com')).res.status).toBe(409);
  expect((await api().post('/auth/login', undefined, { email: 'a@x.com', password: 'errada-123' })).status).toBe(401);
  expect((await api().post('/auth/login', undefined, { email: 'ninguem@x.com', password: 'errada-123' })).status).toBe(401);
  const login = await api().post('/auth/login', undefined, { email: 'A@x.com', password: PASS });
  expect(login.status).toBe(200);
  expect(login.body.user.email).toBe('a@x.com');
});

it('politica de senha e validacao de entrada', async () => {
  const reg = (password: string) => api().post('/auth/register', undefined, { email: 'p@x.com', password, name: 'P', organizationName: 'P' });
  for (const bad of ['curta1', 'somenteletras', '123456789', 'a1'.repeat(70)]) {
    const r = await reg(bad);
    expect(r.status, bad).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
  }
  expect((await api().post('/auth/register', undefined, { email: 'nao-e-email', password: PASS, name: '', organizationName: '' })).status).toBe(400);
});

it('rotas protegidas exigem token valido', async () => {
  expect((await api().get('/collections')).status).toBe(401);
  expect((await api().get('/collections', 'lixo')).status).toBe(401);
  expect((await api().get('/rota-que-nao-existe')).status).toBe(404);
});

it('refresh rotaciona o token; reuso do antigo fora da janela revoga a familia inteira', async () => {
  const a = await register('rot@x.com');
  const r1 = await api().post('/auth/refresh', undefined, undefined, a.cookie);
  expect(r1.status).toBe(200);
  expect(r1.body.user.email).toBe('rot@x.com');
  const c1 = cookieOf(r1)!;
  expect(c1).not.toBe(a.cookie);
  expect((await api().get('/collections', r1.body.token)).status).toBe(200);

  // passada a janela de tolerancia, reapresentar o token original e reuso: 401 e a familia cai, inclusive o token novo
  await db.db.update(refreshTokens).set({ revokedAt: new Date(Date.now() - 60_000) }).where(sql`${refreshTokens.revokedAt} is not null`);
  const reuse = await api().post('/auth/refresh', undefined, undefined, a.cookie);
  expect(reuse.status).toBe(401);
  expect(reuse.body.error.code).toBe('refresh_reuse');
  expect((await api().post('/auth/refresh', undefined, undefined, c1)).status).toBe(401);

  expect((await api().post('/auth/refresh')).status).toBe(401);
  expect((await api().post('/auth/refresh', undefined, undefined, 'refresh_token=lixo')).status).toBe(401);
  // access token nao serve como refresh
  expect((await api().post('/auth/refresh', undefined, undefined, `refresh_token=${a.token}`)).status).toBe(401);
});

it('duas abas renovando com o mesmo token recebem o mesmo sucessor e a sessao continua', async () => {
  const a = await register('tabs@x.com');
  const [t1, t2] = await Promise.all([a.cookie, a.cookie].map((c) => api().post('/auth/refresh', undefined, undefined, c)));
  expect([t1!.status, t2!.status]).toEqual([200, 200]);
  expect(cookieOf(t1!)).toBe(cookieOf(t2!));
  // o sucessor segue valido e rotaciona normalmente
  expect((await api().post('/auth/refresh', undefined, undefined, cookieOf(t1!))).status).toBe(200);
});

it('logout revoga a sessao; refresh expirado e rejeitado; so o hash fica no banco', async () => {
  const a = await register('out@x.com');
  expect((await api().post('/auth/logout', undefined, undefined, a.cookie)).status).toBe(204);
  expect((await api().post('/auth/refresh', undefined, undefined, a.cookie)).status).toBe(401);

  const b = await register('exp@x.com');
  const rows = await db.db.select().from(refreshTokens);
  expect(rows.some((r) => r.tokenHash === b.cookie.split('=')[1])).toBe(false);
  await db.db.update(refreshTokens).set({ expiresAt: new Date(Date.now() - 1000) });
  expect((await api().post('/auth/refresh', undefined, undefined, b.cookie)).status).toBe(401);

  await purgeExpiredRefreshTokens(db.db);
  expect((await db.db.select().from(refreshTokens)).every((r) => r.expiresAt.getTime() > Date.now())).toBe(true);
});

it('rate limit estrito em /auth por IP e por e-mail', async () => {
  {
    const ipApp = build({ AUTH_RATE_LIMIT: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await api(ipApp).post('/auth/login', undefined, { email: `ip${i}@x.com`, password: PASS })).status);
    expect(codes).toEqual([401, 401, 401, 429]);

    const mailApp = build({ AUTH_RATE_LIMIT: '3' });
    const c2: number[] = [];
    for (let i = 0; i < 3; i++) c2.push((await api(mailApp).post('/auth/login', undefined, { email: 'alvo@x.com', password: PASS })).status);
    expect(c2).toEqual([401, 401, 429]); // por e-mail: metade do limite por IP
    const r = await api(mailApp).post('/auth/login', undefined, { email: 'alvo@x.com', password: PASS });
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.body.error.code).toBe('rate_limited');
  }
});

it('GET /organizations e switch-org exigem membership', async () => {
  const a = await register('sw-a@x.com', 'Org S1');
  const b = await register('sw-b@x.com', 'Org S2');
  const list = await api().get('/organizations', a.token);
  expect(list.body.items).toMatchObject([{ id: a.user.organizationId, name: 'Org S1', role: 'admin' }]);

  expect((await api().post('/auth/switch-org', a.token, { organizationId: b.user.organizationId })).status).toBe(403);
  const same = await api().post('/auth/switch-org', a.token, { organizationId: a.user.organizationId }, a.cookie);
  expect(same.status).toBe(200);
  expect(same.body.user.organizationId).toBe(a.user.organizationId);
  // a sessao anterior foi encerrada
  expect((await api().post('/auth/refresh', undefined, undefined, a.cookie)).status).toBe(401);
  expect((await api().post('/auth/refresh', undefined, undefined, cookieOf(same)!)).status).toBe(200);
});

it('CRUD de colecoes com isolamento entre organizacoes (RLS)', async () => {
  const a = await register('crud-a@x.com', 'Org A');
  const b = await register('crud-b@x.com', 'Org B');

  const created = await api().post('/collections', a.token, { name: 'Contratos' });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect(created.body.organizationId).toBe(a.user.organizationId);

  expect((await api().get('/collections', a.token)).body.items.map((c: { id: string }) => c.id)).toEqual([id]);
  expect((await api().get('/collections', b.token)).body.items).toEqual([]);
  expect((await api().get(`/collections/${id}`, b.token)).status).toBe(404);
  expect((await api().patch(`/collections/${id}`, b.token, { name: 'x' })).status).toBe(404);
  expect((await api().del(`/collections/${id}`, b.token)).status).toBe(404);
  expect((await api().get('/collections/nao-uuid', a.token)).status).toBe(400);

  const patched = await api().patch(`/collections/${id}`, a.token, { name: 'Contratos 2026', description: 'd' });
  expect(patched.body).toMatchObject({ name: 'Contratos 2026', description: 'd' });
  expect((await api().del(`/collections/${id}`, a.token)).status).toBe(204);
  expect((await api().get(`/collections/${id}`, a.token)).status).toBe(404);
});

it('papeis: membro le e cria, mas so admin edita/remove; nao remove o ultimo admin', async () => {
  const a = await register('roles-a@x.com', 'Org Roles');
  const added = await api().post('/organization/members', a.token, { email: 'm@x.com', password: PASS, name: 'Membro' });
  expect(added.status).toBe(201);
  expect(added.body.role).toBe('member');
  expect((await api().post('/organization/members', a.token, { email: 'm@x.com', password: PASS, name: 'Dup' })).status).toBe(409);

  const m = (await api().post('/auth/login', undefined, { email: 'm@x.com', password: PASS })).body.token;
  expect((await api().post('/organization/members', m, { email: 'n@x.com', password: PASS, name: 'N' })).status).toBe(403);
  const col = await api().post('/collections', m, { name: 'do membro' });
  expect(col.status).toBe(201);
  expect((await api().patch(`/collections/${col.body.id}`, m, { name: 'x' })).status).toBe(403);
  expect((await api().del(`/collections/${col.body.id}`, m)).status).toBe(403);
  expect((await api().get('/organization/members', m)).body.items).toHaveLength(2);

  // unico admin nao pode virar membro; depois de promover o outro, pode
  expect((await api().patch(`/organization/members/${a.user.id}`, a.token, { role: 'member' })).status).toBe(409);
  expect((await api().patch(`/organization/members/${added.body.userId}`, a.token, { role: 'admin' })).status).toBe(200);
  expect((await api().patch(`/organization/members/${a.user.id}`, a.token, { role: 'member' })).status).toBe(200);
  expect((await api().get('/organization', a.token)).body).toMatchObject({ id: a.user.organizationId, name: 'Org Roles' });
});

it('GET /usage soma tokens do mes por organizacao e respeita limite e preco da config', async () => {
  const a = await register('usage-a@x.com', 'Org U1');
  const b = await register('usage-b@x.com', 'Org U2');
  await db.db.insert(usageEvents).values([
    { organizationId: a.user.organizationId, kind: 'query', tokensIn: 100, tokensOut: 50 },
    { organizationId: a.user.organizationId, kind: 'query', tokensIn: 10, tokensOut: 5 },
    { organizationId: a.user.organizationId, kind: 'ingest', tokensIn: 40, tokensOut: 0 },
    { organizationId: a.user.organizationId, kind: 'query', tokensIn: 999, tokensOut: 999, createdAt: new Date('2020-01-15') },
    { organizationId: b.user.organizationId, kind: 'query', tokensIn: 7, tokensOut: 7 },
  ]);

  expect((await api().get('/usage', a.token)).body).toMatchObject({ queries: 2, tokensIn: 150, tokensOut: 55, documents: 0, costUsd: 0, limitExceeded: false });
  expect((await api().get('/usage', b.token)).body).toMatchObject({ queries: 1, tokensIn: 7, tokensOut: 7 });
  const old = await api().get('/usage?from=2020-01-01T00:00:00.000Z&to=2020-02-01T00:00:00.000Z', a.token);
  expect(old.body).toMatchObject({ queries: 1, tokensIn: 999 });
  expect((await api().get('/usage?from=ontem', a.token)).status).toBe(400);

  const limited = build({ MONTHLY_TOKEN_LIMIT: '200', USAGE_PRICE_IN_PER_1M: '1000000' });
  expect((await api(limited).get('/usage', a.token)).body).toMatchObject({ monthlyTokenLimit: 200, limitExceeded: true, costUsd: 150 });
});

it('OpenAPI publico em /api/v1/openapi.json', async () => {
  const res = await api().get('/openapi.json');
  expect(res.status).toBe(200);
  expect(res.body.openapi).toMatch(/^3/);
  expect(Object.keys(res.body.paths).some((p) => p.endsWith('/collections'))).toBe(true);
});
