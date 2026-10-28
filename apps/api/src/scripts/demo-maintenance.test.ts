import { afterAll, beforeAll, expect, it } from 'vitest';
import { collections, conversations, createDb, documents, eq, feedback, memberships, messages, organizations, sql, users, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createStorage } from '@docmind/storage';
import { processDocument, type IngestJob } from '@docmind/worker';
import { DEMO_COLLECTION, demoMaintenance } from './demo-maintenance';

// O script contra PGlite: cria a conta/colecao/documentos, e idempotente e limpa so o historico com mais de 24 h da org demo.
let db: DbHandle;
const storage = createStorage({ dir: './data/test' });
const EMAIL = 'Demo@DocMind.app';

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
}, 60_000);
afterAll(() => db.close());

it('cria, ingere, e idempotente e apaga so conversas da org demo com mais de 24 h', async () => {
  const queued: IngestJob[] = [];
  const ingestInline = async (job: IngestJob) => {
    queued.push(job);
    await processDocument(job, { db: db.db, storage, llm: createLLM(), retries: 1, baseMs: 0 });
  };

  const first = await demoMaintenance({ db: db.db, storage, email: EMAIL, enqueue: ingestInline });
  expect(first).toEqual({ userCreated: true, documentsQueued: 4, conversationsDeleted: 0 });
  const [user] = await db.db.select().from(users).where(eq(users.email, 'demo@docmind.app'));
  const orgId = user!.organizationId;
  expect((await db.db.select().from(organizations).where(eq(organizations.id, orgId)))[0]!.name).toBe('Demonstração');
  expect(await db.db.select({ role: memberships.role }).from(memberships).where(eq(memberships.userId, user!.id))).toEqual([{ role: 'member' }]);
  const cols = await db.db.select().from(collections).where(eq(collections.organizationId, orgId));
  expect(cols.map((c) => c.name)).toEqual([DEMO_COLLECTION]);
  const docs = await db.db.select().from(documents).where(eq(documents.organizationId, orgId));
  expect(docs.map((d) => [d.filename, d.status]).sort()).toEqual([
    ['politica-ferias.md', 'ready'],
    ['reembolso-despesas.md', 'ready'],
    ['seguranca-informacao.md', 'ready'],
    ['trabalho-remoto.md', 'ready'],
  ]);

  // historico: uma conversa velha (com mensagem e feedback), uma recente, e uma velha de OUTRA org
  const [other] = await db.db.insert(organizations).values({ name: 'Outra', slug: `outra-${crypto.randomUUID()}` }).returning();
  const [otherUser] = await db.db.insert(users).values({ organizationId: other!.id, email: 'o@x.com', name: 'O', passwordHash: 'x' }).returning();
  const old = sql`now() - interval '25 hours'`;
  const [velha] = await db.db.insert(conversations).values({ organizationId: orgId, userId: user!.id, title: 'velha', createdAt: old }).returning();
  const [msg] = await db.db.insert(messages).values({ organizationId: orgId, conversationId: velha!.id, role: 'assistant', content: 'oi', createdAt: old }).returning();
  await db.db.insert(feedback).values({ organizationId: orgId, messageId: msg!.id, userId: user!.id, rating: 'up' });
  await db.db.insert(conversations).values({ organizationId: orgId, userId: user!.id, title: 'recente' });
  await db.db.insert(conversations).values({ organizationId: other!.id, userId: otherUser!.id, title: 'alheia', createdAt: old });
  // documento que falhou volta para a fila na proxima execucao
  await db.db.update(documents).set({ status: 'failed', error: 'x' }).where(eq(documents.filename, 'trabalho-remoto.md'));

  const second = await demoMaintenance({ db: db.db, storage, email: EMAIL, enqueue: async (j) => void queued.push(j) });
  expect(second).toEqual({ userCreated: false, documentsQueued: 1, conversationsDeleted: 1 });
  expect(queued.at(-1)).toEqual({ organizationId: orgId, documentId: docs.find((d) => d.filename === 'trabalho-remoto.md')!.id });
  expect((await db.db.select().from(conversations)).map((c) => c.title).sort()).toEqual(['alheia', 'recente']);
  expect(await db.db.select().from(messages).where(eq(messages.conversationId, velha!.id))).toEqual([]);
  expect(await db.db.select().from(feedback).where(eq(feedback.messageId, msg!.id))).toEqual([]);
  // nada duplicado
  expect(await db.db.select().from(organizations).where(eq(organizations.name, 'Demonstração'))).toHaveLength(1);
  expect(await db.db.select().from(documents).where(eq(documents.organizationId, orgId))).toHaveLength(4);
}, 60_000);

it('recusa um DEMO_USER_EMAIL de conta real (fora da org "Demonstração") sem alterar nada', async () => {
  const [org] = await db.db.insert(organizations).values({ name: 'Empresa Real', slug: `real-${crypto.randomUUID()}` }).returning();
  await db.db.insert(users).values({ organizationId: org!.id, email: 'chefe@real.com', name: 'C', passwordHash: 'x' });
  await expect(demoMaintenance({ db: db.db, storage, email: 'chefe@real.com', enqueue: async () => {} })).rejects.toThrow(/fora da organização/);
  expect(await db.db.select().from(collections).where(eq(collections.organizationId, org!.id))).toEqual([]);
  expect(await db.db.select().from(memberships).where(eq(memberships.organizationId, org!.id))).toEqual([]);
});
