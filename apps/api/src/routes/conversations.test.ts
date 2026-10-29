import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { chunks, collections, conversations, createDb, documents, eq, globalMonthlyTokens, messages, organizations, sql, usageEvents, users, withOrg, type DbHandle } from '@docmind/db';
import { createLLM, extractiveAnswer, hashEmbed, LocalProvider, type CallOptions, type ChatMessage } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { API_PREFIX } from '@docmind/shared';
import { invalidate } from '@docmind/retrieval';
import { buildApp } from '../app';
import { identify, signAccess } from '../http/auth';
import { errorHandler } from '../http/errors';
import { messagesRouter } from './messages';

let db: DbHandle;
let app: ReturnType<typeof buildApp>;
const config = loadConfig({ NODE_ENV: 'test' });
const MODEL = new LocalProvider().embeddingModel!; // modelo do provider ativo: chunks de outro modelo ficam fora da busca vetorial

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
  app = buildApp({ config, db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });
}, 60000);
afterAll(() => db.close());

/** supertest só bufferiza JSON/texto; para SSE lemos o corpo cru e quebramos em eventos. */
const rawBody = (res: any, cb: (e: Error | null, b?: string) => void) => {
  let d = '';
  res.setEncoding('utf8');
  res.on('data', (c: string) => (d += c));
  res.on('end', () => cb(null, d));
};
const events = (body: string) => body.trim().split('\n\n').map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));

const url = (p: string) => `${API_PREFIX}${p}`;
type User = { token: string; orgId: string; userId: string };
const get = (p: string, u?: User) => request(app).get(url(p)).set(u ? { Authorization: `Bearer ${u.token}` } : {});
const post = (p: string, u: User | undefined, body: object = {}) => request(app).post(url(p)).set(u ? { Authorization: `Bearer ${u.token}` } : {}).send(body);
const ask = (convId: string, u: User, body: object) =>
  request(app).post(url(`/conversations/${convId}/messages`)).set('Authorization', `Bearer ${u.token}`).buffer(true).parse(rawBody).send(body);

async function mkOrg(name: string) {
  const [org] = await db.db.insert(organizations).values({ name, slug: `${name}-${crypto.randomUUID()}` }).returning();
  return org!.id;
}
async function mkUser(orgId: string, name: string): Promise<User> {
  const [u] = await db.db.insert(users).values({ organizationId: orgId, email: `${name}-${crypto.randomUUID()}@x.com`, name, passwordHash: 'x' }).returning();
  return { orgId, userId: u!.id, token: signAccess(config.JWT_SECRET, { userId: u!.id, orgId, role: 'member' }) };
}
/** Coleção com 3 trechos (conexão privilegiada, como o worker de ingestão). */
async function seed(orgId: string) {
  const [col] = await db.db.insert(collections).values({ organizationId: orgId, name: 'Políticas' }).returning();
  const [doc] = await db.db
    .insert(documents)
    .values({ organizationId: orgId, collectionId: col!.id, filename: 'politicas.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: 'k', status: 'ready' })
    .returning();
  const texts = ['O prazo de entrega do pedido é de 10 dias úteis.', 'A garantia cobre defeitos de fabricação por 12 meses.', 'Frete grátis acima de 200 reais.'];
  await db.db.insert(chunks).values(
    texts.map((content, ordinal) => ({ organizationId: orgId, documentId: doc!.id, collectionId: col!.id, ordinal, page: ordinal + 1, content, embedding: hashEmbed(content), embeddingModel: MODEL })),
  );
  return { collectionId: col!.id, documentId: doc!.id };
}

it('conversa completa: SSE com citações, histórico, feedback, usage_events e cache', async () => {
  const orgId = await mkOrg('chat');
  const u = await mkUser(orgId, 'ana');
  const { collectionId, documentId } = await seed(orgId);

  const created = await post('/conversations', u, { collectionId });
  expect(created.status).toBe(201);
  const convId = created.body.id as string;

  const r = await ask(convId, u, { content: 'Qual o prazo de entrega?' });
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/text\/event-stream/);
  const evs = events(r.body);
  const types = evs.map((e) => e.type);
  expect(types).toContain('token');
  expect(types.at(-1)).toBe('done');
  const cit = evs.find((e) => e.type === 'citations');
  expect(cit.citations[0]).toMatchObject({ documentId, page: 1, n: 1 });
  expect(cit.citations[0].snippet).toMatch(/prazo de entrega/);

  const detail = (await get(`/conversations/${convId}`, u)).body;
  expect(detail.title).toBe('Qual o prazo de entrega?');
  expect(detail.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
  expect(detail.messages[1].citations).toEqual(cit.citations);
  expect((await get('/conversations', u)).body.items.map((c: any) => c.id)).toEqual([convId]);

  const usage = await withOrg(db.db, orgId, (tx) => tx.select().from(usageEvents));
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ kind: 'query', userId: u.userId });

  const msgId = detail.messages[1].id;
  const fb = await post(`/messages/${msgId}/feedback`, u, { rating: 'up' });
  expect(fb.status).toBe(200);
  const fb2 = await post(`/messages/${msgId}/feedback`, u, { rating: 'down', comment: 'errado' });
  expect(fb2.body).toMatchObject({ id: fb.body.id, rating: 'down', comment: 'errado' });
  expect((await post(`/messages/${msgId}/feedback`, u, { rating: 'meh' })).status).toBe(400);

  const again = await ask(convId, u, { content: 'Qual o prazo de entrega?' });
  expect(events(again.body).find((e) => e.type === 'citations').citations).toEqual(cit.citations); // cache semântico
});

it('exige auth, valida entrada e isola histórico entre usuários e organizações', async () => {
  const orgA = await mkOrg('iso-a');
  const a = await mkUser(orgA, 'a');
  const a2 = await mkUser(orgA, 'a2'); // mesma org, outro usuário
  const b = await mkUser(await mkOrg('iso-b'), 'b');
  const conv = (await post('/conversations', a, {})).body;

  expect((await get('/conversations')).status).toBe(401);
  expect((await post('/conversations', undefined, {})).status).toBe(401);
  expect((await get('/conversations/nao-e-uuid', a)).status).toBe(400);
  expect((await post(`/conversations/${conv.id}/messages`, a, { content: '' })).status).toBe(400);

  for (const other of [a2, b]) {
    expect((await get('/conversations', other)).body.items).toEqual([]);
    expect((await get(`/conversations/${conv.id}`, other)).status).toBe(404);
    expect((await post(`/conversations/${conv.id}/messages`, other, { content: 'oi' })).status).toBe(404);
  }
  expect((await post('/conversations', a, { collectionId: crypto.randomUUID() })).status).toBe(404);

  // feedback em mensagem de outro usuário => 404
  const [m] = await withOrg(db.db, orgA, async (tx) => {
    await tx.select().from(conversations);
    return tx.insert((await import('@docmind/db')).messages).values({ organizationId: orgA, conversationId: conv.id, role: 'assistant', content: 'x' }).returning();
  });
  expect((await post(`/messages/${m!.id}/feedback`, a2, { rating: 'up' })).status).toBe(404);
  expect((await post(`/messages/${m!.id}/feedback`, a, { rating: 'up' })).status).toBe(200);
});

it('modo agente: mesmos eventos de /agent/run + done, resposta persistida com citações e payload, 1 usage_event', async () => {
  const orgId = await mkOrg('agent');
  const u = await mkUser(orgId, 'ag');
  const s = await seed(orgId);
  const conv = (await post('/conversations', u, { collectionId: s.collectionId })).body;

  const r = await ask(conv.id, u, { content: 'Qual a garantia dos produtos?', agent: true });
  const evs = events(r.body);
  expect(evs.map((e) => e.type)).toEqual(['plan', 'step', 'step_result', 'result', 'done']);
  expect(evs[1]).toMatchObject({ type: 'step', n: 1, tool: 'search' });
  expect(evs[2]).toMatchObject({ type: 'step_result', n: 1, tool: 'search', ok: true });
  const result = evs.find((e) => e.type === 'result').result;
  expect(result).toMatchObject({ intent: 'search', truncated: false });
  expect(result.citations.length).toBeGreaterThan(0);

  const detail = (await get(`/conversations/${conv.id}`, u)).body;
  expect(detail.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
  const saved = detail.messages[1];
  expect(saved.id).toBe(evs.at(-1).messageId);
  expect(saved.content).toBe(result.answer);
  expect(saved.citations).toEqual(result.citations);
  expect(saved.data).toMatchObject({ intent: 'search', truncated: false });
  expect(detail.messages[0].data ?? null).toBeNull(); // mensagem do usuário não tem payload
  expect((await post(`/messages/${saved.id}/feedback`, u, { rating: 'up' })).status).toBe(200); // histórico + feedback funcionam

  expect(await withOrg(db.db, orgId, (tx) => tx.select().from(usageEvents))).toHaveLength(1);
});

it('modo agente: extract_table persiste a tabela no payload da mensagem e abstém fora do corpus', async () => {
  const orgId = await mkOrg('agent-table');
  const u = await mkUser(orgId, 'tb');
  const [col] = await db.db.insert(collections).values({ organizationId: orgId, name: 'Preços' }).returning();
  const [doc] = await db.db
    .insert(documents)
    .values({ organizationId: orgId, collectionId: col!.id, filename: 'precos.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: 'p', status: 'ready' })
    .returning();
  const content = ['Tabela de preços dos itens', '| Item | Preço |', '|---|---|', '| Caneta | 2 |', '| Caderno | 10 |'].join('\n');
  await db.db.insert(chunks).values({ organizationId: orgId, documentId: doc!.id, collectionId: col!.id, ordinal: 0, page: 3, content, embedding: hashEmbed(content), embeddingModel: MODEL });
  const conv = (await post('/conversations', u, { collectionId: col!.id })).body;

  const evs = events((await ask(conv.id, u, { content: 'Extraia a tabela de preços', agent: true })).body);
  expect(evs.filter((e) => e.type === 'step').map((e) => e.tool)).toEqual(['search', 'extract_table']);
  expect(evs.at(-1).type).toBe('done');
  const saved = (await get(`/conversations/${conv.id}`, u)).body.messages.at(-1);
  expect(saved.data).toMatchObject({ intent: 'extract_table', data: { documentId: doc!.id, table: { page: 3, headers: ['Item', 'Preço'], rows: [['Caneta', '2'], ['Caderno', '10']] } } });
  expect(saved.citations[0]).toMatchObject({ documentId: doc!.id, page: 3 });

  // pergunta fora do corpus: o limiar de relevância faz o agente abster-se, sem citações
  const off = events((await ask(conv.id, u, { content: 'Quem venceu a Copa do Mundo de 2002 no Japão?', agent: true })).body);
  const res = off.find((e) => e.type === 'result').result;
  expect(res.citations).toEqual([]);
  expect(res.answer).toMatch(/n[aã]o encontrei/i);
  expect(off.at(-1).type).toBe('done');
});

it('modo agente: pedido inválido (mais de 2000 caracteres) é 400 e nada é persistido', async () => {
  const u = await mkUser(await mkOrg('agent-400'), 'a4');
  const conv = (await post('/conversations', u, {})).body;
  const r = await post(`/conversations/${conv.id}/messages`, u, { content: 'x'.repeat(2001), agent: true });
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('validation_error');
  expect((await get(`/conversations/${conv.id}`, u)).body.messages).toEqual([]);
});

it('402 usage_limit_exceeded (chat, modo agente e /agent/run) quando o limite mensal foi excedido, sem persistir nada', async () => {
  const limited = buildApp({ config: loadConfig({ NODE_ENV: 'test', MONTHLY_TOKEN_LIMIT: '100' }), db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });
  const orgId = await mkOrg('limit');
  const u = await mkUser(orgId, 'lim');
  const conv = (await post('/conversations', u, {})).body;
  await db.db.insert(usageEvents).values({ organizationId: orgId, kind: 'query', tokensIn: 90, tokensOut: 20 });
  const auth = { Authorization: `Bearer ${u.token}` };
  for (const [path, body] of [
    [`/conversations/${conv.id}/messages`, { content: 'oi' }],
    [`/conversations/${conv.id}/messages`, { content: 'oi', agent: true }],
    ['/agent/run', { query: 'oi' }],
  ] as const) {
    const r = await request(limited).post(url(path)).set(auth).send(body);
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('usage_limit_exceeded');
  }
  expect((await get(`/conversations/${conv.id}`, u)).body.messages).toEqual([]);
});

it('cliente que desconecta no meio do stream aborta a geração: sem resposta persistida, uso parcial registrado', async () => {
  class Slow extends LocalProvider {
    override async *generateStream(m: ChatMessage[]): AsyncIterable<string> {
      for (const part of extractiveAnswer(m)) {
        await new Promise((r) => setTimeout(r, 150));
        yield `${part} `;
      }
    }
  }
  const slow = buildApp({ config, db, llm: new Slow(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });
  const orgId = await mkOrg('abort');
  const u = await mkUser(orgId, 'ab');
  const s = await seed(orgId);
  const conv = (await request(slow).post(url('/conversations')).set('Authorization', `Bearer ${u.token}`).send({ collectionId: s.collectionId })).body;

  const server = slow.listen(0);
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      { port, method: 'POST', path: url(`/conversations/${conv.id}/messages`), headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` } },
      (res) =>
        res.on('data', (c: Buffer) => {
          if (c.toString().includes('event: token')) {
            req.destroy(); // some depois do 1º token
            resolve();
          }
        }),
    );
    req.on('error', () => undefined);
    req.end(JSON.stringify({ content: 'Qual o prazo de entrega e a garantia?' }));
    setTimeout(() => reject(new Error('nenhum token recebido')), 5000);
  });
  await new Promise((r) => setTimeout(r, 800)); // dá tempo de o servidor perceber e encerrar
  server.close();

  const detail = (await request(slow).get(url(`/conversations/${conv.id}`)).set('Authorization', `Bearer ${u.token}`)).body;
  expect(detail.messages.map((m: any) => m.role)).toEqual(['user']); // sem resposta parcial
  const usage = await withOrg(db.db, orgId, (tx) => tx.select().from(usageEvents));
  expect(usage).toHaveLength(1); // só o que foi gerado antes de abortar
});

it('modo agente: cliente que desconecta no meio do stream não persiste resposta, cobra só o que foi gerado e não gera unhandled rejection', async () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => void rejections.push(e);
  process.on('unhandledRejection', onRejection);

  const hit = { chunkId: crypto.randomUUID(), documentId: crypto.randomUUID(), page: 1, content: 'A multa contratual é de dez por cento.', score: 1 };
  class SlowLLM extends LocalProvider {
    override async *generateStream(m: ChatMessage[]): AsyncIterable<string> {
      await new Promise((r) => setTimeout(r, 400)); // a resposta do agente demora a ser composta
      yield* super.generateStream(m);
    }
  }
  const deps = { config, db, llm: new SlowLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) };
  const slow = express();
  Object.assign(slow.locals, { deps, jwtSecret: config.JWT_SECRET });
  slow.use((req, _res, next) => ((req.log = { error() {} } as never), next()));
  slow.use(express.json(), identify);
  slow.use(API_PREFIX, messagesRouter(deps, { retriever: { search: async () => (await new Promise((r) => setTimeout(r, 150)), [hit]) }, chunks: { get: async () => [hit] } }));
  slow.use(errorHandler);
  const server = slow.listen(0);
  const port = (server.address() as AddressInfo).port;

  // abre o stream e destrói a conexão assim que chega o evento `eventType`
  const disconnectAfter = (u: User, convId: string, eventType: string) =>
    new Promise<void>((resolve, reject) => {
      const req = http.request(
        { port, method: 'POST', path: url(`/conversations/${convId}/messages`), headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` } },
        (res) => {
          let buf = '';
          res.on('data', (c: Buffer) => {
            buf += c.toString();
            if (buf.includes(`event: ${eventType}`)) {
              req.destroy();
              resolve();
            }
          });
        },
      );
      req.on('error', () => undefined);
      req.end(JSON.stringify({ content: 'qual a multa?', agent: true }));
      setTimeout(() => reject(new Error(`evento ${eventType} não recebido`)), 5000);
    });
  const newConversation = async (name: string) => {
    const orgId = await mkOrg(name);
    const u = await mkUser(orgId, name);
    const [c] = await db.db.insert(conversations).values({ organizationId: orgId, userId: u.userId, title: 'Nova conversa' }).returning();
    return { orgId, u, convId: c!.id };
  };
  const state = async (orgId: string, convId: string) => ({
    roles: (await db.db.select({ role: messages.role }).from(messages).where(eq(messages.conversationId, convId))).map((m) => m.role),
    usage: await withOrg(db.db, orgId, (tx) => tx.select().from(usageEvents)),
  });

  try {
    // A) desconecta logo no início (evento plan): o agente para antes de gerar a resposta; nada foi gasto
    const a = await newConversation('agent-disc-a');
    await disconnectAfter(a.u, a.convId, 'plan');
    await new Promise((r) => setTimeout(r, 1500));
    const sa = await state(a.orgId, a.convId);
    expect(sa.roles).toEqual(['user']); // sem resposta parcial
    expect(sa.usage).toHaveLength(0);

    // B) desconecta quando a busca terminou, durante a composição da resposta: o custo gerado é registrado, a resposta não
    const b = await newConversation('agent-disc-b');
    await disconnectAfter(b.u, b.convId, 'step_result');
    await new Promise((r) => setTimeout(r, 1500));
    const sb = await state(b.orgId, b.convId);
    expect(sb.roles).toEqual(['user']);
    expect(sb.usage).toHaveLength(1);
    expect(sb.usage[0]).toMatchObject({ kind: 'query', userId: b.u.userId });
    expect(sb.usage[0]!.tokensIn).toBeGreaterThan(0);
  } finally {
    server.close();
    process.off('unhandledRejection', onRejection);
  }
  expect(rejections).toEqual([]);
}, 30000);

it('chunks de dois modelos: done traz warnings:["reindex_needed"] (chat e agente); coleção limpa e reindexação removem o aviso', async () => {
  const OTHER = 'openai:text-embedding-3-small:384';
  const orgId = await mkOrg('two-models');
  const u = await mkUser(orgId, 'tm');
  const clean = await seed(orgId); // 3 chunks do modelo ativo
  const mixed = await seed(orgId);
  const [old] = await db.db.select().from(chunks).where(eq(chunks.collectionId, mixed.collectionId)).limit(1);
  await db.db.update(chunks).set({ embeddingModel: OTHER }).where(eq(chunks.id, old!.id)); // 1 chunk de outro modelo na coleção "mista"
  const done = async (collectionId: string, body: object) => {
    const conv = (await post('/conversations', u, { collectionId })).body;
    const evs = events((await ask(conv.id, u, { content: 'Qual o prazo de entrega?', ...body })).body);
    return evs.find((e) => e.type === 'done');
  };

  expect((await done(clean.collectionId, {})).warnings).toBeUndefined(); // sem chunks de outro modelo: nada a avisar
  expect((await done(mixed.collectionId, {})).warnings).toEqual(['reindex_needed']);
  expect((await done(mixed.collectionId, { agent: true })).warnings).toEqual(['reindex_needed']);

  await db.db.update(chunks).set({ embeddingModel: MODEL }).where(eq(chunks.collectionId, mixed.collectionId)); // reindexou
  invalidate({ organizationId: orgId }); // o worker faz isto quando o documento fica ready
  expect((await done(mixed.collectionId, {})).warnings).toBeUndefined();
});

it('GET /conversations/:id devolve warnings:["reindex_needed"] só quando a coleção tem chunks de outro modelo, e some ao reindexar', async () => {
  const orgId = await mkOrg('detail-warn');
  const u = await mkUser(orgId, 'dw');
  const clean = await seed(orgId);
  const mixed = await seed(orgId);
  const [old] = await db.db.select().from(chunks).where(eq(chunks.collectionId, mixed.collectionId)).limit(1);
  await db.db.update(chunks).set({ embeddingModel: 'openai:text-embedding-3-small:384' }).where(eq(chunks.id, old!.id));
  const detail = async (collectionId?: string) => {
    const conv = (await post('/conversations', u, collectionId ? { collectionId } : {})).body;
    return (await get(`/conversations/${conv.id}`, u)).body;
  };

  expect((await detail(clean.collectionId)).warnings).toBeUndefined(); // coleção só com o modelo ativo
  const m = await detail(mixed.collectionId);
  expect(m.warnings).toEqual(['reindex_needed']);
  expect(m.messages).toEqual([]); // o resto do contrato não mudou
  expect((await detail()).warnings).toEqual(['reindex_needed']); // sem coleção: vale a organização inteira

  await db.db.update(chunks).set({ embeddingModel: MODEL }).where(eq(chunks.collectionId, mixed.collectionId)); // reindexou
  invalidate({ organizationId: orgId });
  expect((await detail(mixed.collectionId)).warnings).toBeUndefined();
  expect((await detail()).warnings).toBeUndefined();
  expect((await get('/conversations', u)).body.items[0]).not.toHaveProperty('warnings'); // a lista não calcula aviso
});

it('tokens reais do provider (embedding + geração) chegam ao usage_events, ao /usage e ao teto global; agente que falha no stream registra o parcial', async () => {
  class Billed extends LocalProvider {
    override async embed(t: string[], opts?: CallOptions) {
      opts?.onUsage?.({ inputTokens: 7, outputTokens: 0 });
      return super.embed(t);
    }
    override async *generateStream(m: ChatMessage[], opts?: CallOptions): AsyncIterable<string> {
      yield* super.generateStream(m);
      opts?.onUsage?.({ inputTokens: 1000, outputTokens: 50 });
    }
  }
  const billed = buildApp({ config, db, llm: new Billed(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });
  const orgId = await mkOrg('real-usage');
  const u = await mkUser(orgId, 'real');
  const { collectionId } = await seed(orgId);
  const conv = (await post('/conversations', u, { collectionId })).body;
  const globalTotal = async () => {
    const [r] = await db.db.select({ t: sql<number>`coalesce(sum(${usageEvents.tokensIn} + ${usageEvents.tokensOut}), 0)` }).from(usageEvents);
    return Number(r!.t);
  };
  const before = await globalTotal();
  const r = await request(billed).post(url(`/conversations/${conv.id}/messages`)).set('Authorization', `Bearer ${u.token}`).buffer(true).parse(rawBody).send({ content: 'Qual o prazo de entrega?' });
  expect(events(r.body).at(-1)).toMatchObject({ type: 'done', tokensIn: 1007, tokensOut: 50 });
  const usage = (await request(billed).get(url('/usage')).set('Authorization', `Bearer ${u.token}`)).body;
  expect(usage).toMatchObject({ tokensIn: 1007, tokensOut: 50 }); // o /usage soma o gravado, não a estimativa
  expect((await globalTotal()) - before).toBe(1057); // base do teto global (db/usage.ts)
  // `now` 60 s à frente fura o cache de 30 s do teto e lê o banco; é a soma que o teto compara com GLOBAL_MONTHLY_TOKEN_LIMIT
  expect(await globalMonthlyTokens(db.db, new Date(Date.now() + 60_000))).toBe(before + 1057);

  // modo agente com o stream caindo: o runner grava o gasto parcial (embedding + prompt estimado) em vez de perder
  class Broken extends Billed {
    override async *generateStream(): AsyncIterable<string> {
      yield 'resposta parcial';
      throw new Error('stream caiu');
    }
  }
  const broken = buildApp({ config, db, llm: new Broken(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });
  const rows0 = (await withOrg(db.db, orgId, (tx) => tx.select().from(usageEvents))).length;
  await request(broken).post(url('/agent/run')).set('Authorization', `Bearer ${u.token}`).send({ query: 'qual o prazo de entrega?', collectionId }).buffer(true).parse(rawBody);
  const rows = await withOrg(db.db, orgId, (tx) => tx.select().from(usageEvents));
  expect(rows).toHaveLength(rows0 + 1);
  expect(rows.at(-1)!.tokensIn).toBeGreaterThan(7);
});
