import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb, documents, eq, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { API_PREFIX } from '@docmind/shared';
import { createStorage } from '@docmind/storage';
import { buildApp } from './app';
import { demoMaintenance } from './scripts/demo-maintenance';

// Conta de demonstracao: login sem senha (POST /auth/demo) e somente leitura, salvo conversar/feedback/sessao.
let db: DbHandle;
const EMAIL = 'demo@docmind.app';
const url = (p: string) => `${API_PREFIX}${p}`;
const storage = createStorage({ dir: './data/test' });
const build = (env: Record<string, string> = {}) =>
  buildApp({ config: loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), ...env }), db, llm: createLLM(), queue: createQueue(), storage, logStream: { write() {} } });
const enabled = { DEMO_LOGIN_ENABLED: 'true', DEMO_USER_EMAIL: EMAIL };
const sse = (res: any, cb: (e: Error | null, b?: string) => void) => {
  let d = '';
  res.setEncoding('utf8');
  res.on('data', (c: string) => (d += c));
  res.on('end', () => cb(null, d));
};

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
}, 60_000);
afterAll(() => db.close());

it('desligada (padrao): GET /auth/demo diz enabled=false e POST /auth/demo e 404', async () => {
  const app = build();
  expect((await request(app).get(url('/auth/demo'))).body).toEqual({ enabled: false });
  expect((await request(app).post(url('/auth/demo'))).status).toBe(404);
});

it('ligada sem o usuario preparado: enabled=false e POST da 503 demo_unavailable', async () => {
  const app = build({ DEMO_LOGIN_ENABLED: 'true', DEMO_USER_EMAIL: 'ainda-nao@docmind.app' });
  expect((await request(app).get(url('/auth/demo'))).body).toEqual({ enabled: false });
  const r = await request(app).post(url('/auth/demo'));
  expect(r.status).toBe(503);
  expect(r.body.error.code).toBe('demo_unavailable');
});

describe('com a conta preparada pelo demo-maintenance', () => {
  let app: ReturnType<typeof build>;
  let demo: Record<string, string>;
  let cookie: string;
  let admin: Record<string, string>;
  let adminCollectionId: string;
  let docId: string;
  let collectionId: string;

  beforeAll(async () => {
    await demoMaintenance({ db: db.db, storage, email: EMAIL, enqueue: async () => {} });
    app = build(enabled);
    const r = await request(app).post(url('/auth/demo'));
    expect(r.status).toBe(200);
    demo = { Authorization: `Bearer ${r.body.token}` };
    cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!;
    const [d] = await db.db.select().from(documents).where(eq(documents.organizationId, r.body.user.organizationId));
    docId = d!.id;
    collectionId = d!.collectionId;

    const reg = await request(app).post(url('/auth/register')).send({ email: 'normal@x.com', password: 'senha-forte-123', name: 'N', organizationName: 'Normal' });
    admin = { Authorization: `Bearer ${reg.body.token}` };
    adminCollectionId = (await request(app).post(url('/collections')).set(admin).send({ name: 'Minha' })).body.id;
  });

  it('GET enabled=true; POST emite a sessao normal (cookie de refresh com os atributos do login) marcada demo, papel member', async () => {
    expect((await request(app).get(url('/auth/demo'))).body).toEqual({ enabled: true });
    const r = await request(app).post(url('/auth/demo'));
    expect(r.body).toMatchObject({ demo: true, user: { email: EMAIL } });
    expect(cookie).toMatch(/; Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect((await request(app).get(url('/organization')).set(demo)).body).toMatchObject({ name: 'Demonstração', role: 'member' });
    // refresh mantem a marca (o web volta a desabilitar as escritas depois de recarregar)
    const ref = await request(app).post(url('/auth/refresh')).set('Cookie', cookie.split(';')[0]!);
    expect(ref.status).toBe(200);
    expect(ref.body.demo).toBe(true);
    cookie = (ref.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!;
  });

  it('permitido: criar conversa, enviar mensagem (chat e agente), /agent/run, feedback e logout', async () => {
    const conv = await request(app).post(url('/conversations')).set(demo).send({});
    expect(conv.status).toBe(201);
    const chat = await request(app).post(url(`/conversations/${conv.body.id}/messages`)).set(demo).buffer(true).parse(sse).send({ content: 'Quantos dias de férias?' });
    expect(chat.status).toBe(200);
    expect(chat.body).toContain('event: done');
    const agent = await request(app).post(url(`/conversations/${conv.body.id}/messages`)).set(demo).buffer(true).parse(sse).send({ content: 'férias', agent: true });
    expect(agent.status).toBe(200);
    expect((await request(app).post(url('/agent/run')).set(demo).buffer(true).parse(sse).send({ query: 'férias' })).status).toBe(200);
    const msgs = (await request(app).get(url(`/conversations/${conv.body.id}`)).set(demo)).body.messages;
    const answer = msgs.find((m: { role: string }) => m.role === 'assistant');
    expect((await request(app).post(url(`/messages/${answer.id}/feedback`)).set(demo).send({ rating: 'up' })).status).toBe(200);
    // leituras seguem livres
    expect((await request(app).get(url('/collections')).set(demo)).status).toBe(200);
    expect((await request(app).get(url(`/documents/${docId}`)).set(demo)).status).toBe(200);
    expect((await request(app).post(url('/auth/logout')).set(demo).set('Cookie', cookie.split(';')[0]!)).status).toBe(204);
  });

  const blocked = (): [string, string, (r: request.Test) => request.Test][] => [
    ['coleções: criar', `POST /collections`, (r) => r.send({ name: 'X' })],
    ['coleções: editar', `PATCH /collections/${collectionId}`, (r) => r.send({ name: 'X' })],
    ['coleções: excluir', `DELETE /collections/${collectionId}`, (r) => r],
    ['documentos: upload', `POST /collections/${collectionId}/documents`, (r) => r.attach('file', Buffer.from('oi'), 'a.txt')],
    ['documentos: importar URL', `POST /collections/${collectionId}/documents/import`, (r) => r.send({ url: 'https://example.com/a' })],
    ['documentos: importar URL (alias)', `POST /documents/url`, (r) => r.send({ url: 'https://example.com/a', collectionId })],
    ['documentos: processar', `POST /documents/${docId}/process`, (r) => r],
    ['documentos: excluir', `DELETE /documents/${docId}`, (r) => r],
    ['organização: adicionar membro', `POST /organization/members`, (r) => r.send({ email: 'm@x.com', name: 'M', password: 'senha-forte-123', role: 'member' })],
    ['organização: alterar papel', `PATCH /organization/members/${crypto.randomUUID()}`, (r) => r.send({ role: 'admin' })],
    ['sessão: trocar de organização', `POST /auth/switch-org`, (r) => r.send({ organizationId: crypto.randomUUID() })],
  ];

  it('bloqueado com 403 demo_read_only: coleções, documentos, organização e switch-org (nada muda)', async () => {
    for (const [name, route, body] of blocked()) {
      const [method, path] = route.split(' ') as [string, string];
      const r = await body(request(app)[method.toLowerCase() as 'post'](url(path)).set(demo));
      expect(r.status, name).toBe(403);
      expect(r.body.error, name).toEqual({ code: 'demo_read_only', message: 'A conta de demonstração é somente leitura.' });
    }
    expect((await request(app).get(url(`/documents/${docId}`)).set(demo)).body.status).toBe('pending'); // nem processou nem apagou
    expect((await request(app).get(url('/collections')).set(demo)).body.items).toHaveLength(1);
  });

  it('usuarios normais nao sao afetados (mesmo com a demo ligada)', async () => {
    const created = await request(app).post(url('/collections')).set(admin).send({ name: 'Outra' });
    expect(created.status).toBe(201);
    expect((await request(app).patch(url(`/collections/${created.body.id}`)).set(admin).send({ name: 'Renomeada' })).status).toBe(200);
    expect((await request(app).post(url(`/collections/${adminCollectionId}/documents`)).set(admin).attach('file', Buffer.from('oi'), 'a.txt')).status).toBe(201);
    expect((await request(app).delete(url(`/collections/${created.body.id}`)).set(admin)).status).toBe(204);
    // e um token demo nao vira escrita em outra org: o 403 vem antes de qualquer rota
    expect((await request(app).post(url(`/collections/${adminCollectionId}/documents`)).set(demo).attach('file', Buffer.from('oi'), 'a.txt')).status).toBe(403);
  });

  it('POST /auth/demo: 20 por hora por IP (21a da 429)', async () => {
    const fresh = build(enabled);
    for (let i = 0; i < 20; i++) expect((await request(fresh).post(url('/auth/demo'))).status).toBe(200);
    const r = await request(fresh).post(url('/auth/demo'));
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(60);
  });
});

it('DEMO_USER_EMAIL de uma conta real (fora da org "Demonstração") nao vira login sem senha', async () => {
  const app = build({ DEMO_LOGIN_ENABLED: 'true', DEMO_USER_EMAIL: 'real@x.com' });
  await request(app).post(url('/auth/register')).send({ email: 'real@x.com', password: 'senha-forte-123', name: 'R', organizationName: 'Real' });
  expect((await request(app).get(url('/auth/demo'))).body).toEqual({ enabled: false });
  expect((await request(app).post(url('/auth/demo'))).status).toBe(503);
});
