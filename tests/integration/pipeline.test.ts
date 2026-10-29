import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chunks, collections, documents, eq, orgScope, users, usageEvents, withOrg } from '@docmind/db';
import { createLLM, createReranker } from '@docmind/llm';
import { FsStorage } from '@docmind/storage';
import { createRag, NO_ANSWER, SemanticCache, type AnswerEvent, type Cached } from '@docmind/retrieval';
import { processDocument } from '../../apps/worker/src/index';
import { fixture, QA } from '../fixtures';
import { setupDb } from './helpers';

let ctx: Awaited<ReturnType<typeof setupDb>>;
let dir: string;
let storage: FsStorage;
const llm = createLLM();
const userOf: Record<string, string> = {};

/** Cria colecao + documento pendente, grava o arquivo no storage e roda a ingestao do worker. */
async function ingestFixture(orgId: string, filename: string) {
  const { h } = ctx;
  const [c] = await h.db.insert(collections).values({ organizationId: orgId, name: `col-${filename}` }).returning();
  const data = fixture(filename);
  const storageKey = `${orgId}/${c!.id}/${filename}`;
  await storage.put(storageKey, data);
  const [d] = await h.db.insert(documents).values({
    organizationId: orgId, collectionId: c!.id, filename, mimeType: 'text/plain', sizeBytes: data.length, storageKey,
  }).returning();
  await processDocument({ organizationId: orgId, documentId: d!.id }, { db: h.db, storage, llm, retries: 0, baseMs: 0 });
  return { collectionId: c!.id, documentId: d!.id };
}

async function ask(orgId: string, question: string, collectionId: string | null = null, rag = createRag({ scope: orgScope(ctx.h.db), llm, reranker: createReranker() })) {
  let result: Extract<AnswerEvent, { type: 'result' }> | undefined;
  for await (const e of rag.answer({ orgId, userId: userOf[orgId]!, collectionId, question, history: [] })) if (e.type === 'result') result = e;
  return result!;
}

beforeAll(async () => {
  ctx = await setupDb();
  dir = await mkdtemp(join(tmpdir(), 'docmind-it-'));
  storage = new FsStorage(dir);
  for (const [org, slug] of [[ctx.orgA, 'a'], [ctx.orgB, 'b']] as const) {
    const [u] = await ctx.h.db.insert(users).values({ organizationId: org, email: `${slug}@x.com`, name: slug, passwordHash: 'x' }).returning();
    userOf[org] = u!.id;
  }
});
afterAll(async () => {
  await ctx.h.close();
  await rm(dir, { recursive: true, force: true });
});

it('ingestao marca o documento como ready e grava chunks com embedding de 384 dims', async () => {
  const { documentId } = await ingestFixture(ctx.orgA, 'ferias.txt');
  const [doc] = await ctx.h.db.select().from(documents).where(eq(documents.id, documentId));
  expect(doc!.status).toBe('ready');
  const rows = await ctx.h.db.select().from(chunks).where(eq(chunks.documentId, documentId));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]!.embedding).toHaveLength(384);
});

it.each(QA)('pergunta "$question" responde com citacao de $doc', async ({ doc, question, expect: trecho }) => {
  const { documentId } = doc === 'ferias.txt'
    ? await ctx.h.db.select().from(documents).where(eq(documents.filename, doc)).then(([d]) => ({ documentId: d!.id }))
    : await ingestFixture(ctx.orgA, doc);
  const r = await ask(ctx.orgA, question);
  expect(r.content).toContain(trecho);
  expect(r.citations.length).toBeGreaterThan(0);
  const c = r.citations.find((x) => x.documentId === documentId)!;
  expect(c).toBeDefined();
  expect(c.snippet).toContain(trecho);
  expect(r.content).toMatch(/\[\d+\]/);
});

it('registra usage_events da consulta na organizacao certa', async () => {
  const rows = await withOrg(ctx.h.db, ctx.orgA, (tx) => tx.select().from(usageEvents).where(eq(usageEvents.kind, 'query')));
  expect(rows.length).toBeGreaterThan(0);
  expect(await withOrg(ctx.h.db, ctx.orgB, (tx) => tx.select().from(usageEvents).where(eq(usageEvents.kind, 'query')))).toHaveLength(0);
});

it('org A nunca recebe conteudo ou citacao do documento da org B', async () => {
  const b = await ingestFixture(ctx.orgB, 'org-b-secreto.txt');
  const r = await ask(ctx.orgA, 'Qual o codigo do cofre da Org B?');
  expect(r.content).not.toContain('BETA-7731');
  expect(r.citations.every((c) => c.documentId !== b.documentId)).toBe(true);
  // sanidade: a propria org B encontra o segredo
  const own = await ask(ctx.orgB, 'Qual o codigo do cofre da Org B?');
  expect(own.content).toContain('BETA-7731');
});

it('pergunta sem nenhum trecho relevante devolve a mensagem padrao, sem citacoes', async () => {
  const lone = await setupDb();
  const rag = createRag({ scope: orgScope(lone.h.db), llm, reranker: createReranker() });
  const [u] = await lone.h.db.insert(users).values({ organizationId: lone.orgA, email: 'z@x.com', name: 'z', passwordHash: 'x' }).returning();
  let result: Extract<AnswerEvent, { type: 'result' }> | undefined;
  for await (const e of rag.answer({ orgId: lone.orgA, userId: u!.id, collectionId: null, question: 'qualquer coisa', history: [] })) if (e.type === 'result') result = e;
  expect(result!.content).toBe(NO_ANSWER);
  expect(result!.citations).toEqual([]);
  await lone.h.close();
});

it('worker em outro processo (sem invalidateCache, como com REDIS_URL): reprocessar ou excluir nao deixa o cache semantico servir a resposta antiga', async () => {
  const rag = createRag({ scope: orgScope(ctx.h.db), llm, reranker: createReranker(), cache: new SemanticCache<Cached>() }); // o cache da API
  const { collectionId, documentId } = await ingestFixture(ctx.orgA, 'reembolso.txt');
  const q = 'Qual o limite diario para alimentacao?';
  expect((await ask(ctx.orgA, q, collectionId, rag)).content).toContain('R$ 120,00');
  expect((await ask(ctx.orgA, q, collectionId, rag)).cached).toBe(true);

  // o worker de outro processo reprocessa com conteudo novo; esta API nao e avisada (apps/worker/src/main.ts nao tem invalidateCache)
  const [doc] = await ctx.h.db.select().from(documents).where(eq(documents.id, documentId));
  await storage.put(doc!.storageKey, Buffer.from(fixture('reembolso.txt').toString('utf8').replace('R$ 120,00', 'R$ 150,00')));
  await processDocument({ organizationId: ctx.orgA, documentId }, { db: ctx.h.db, storage, llm, retries: 0, baseMs: 0 });
  const fresh = await ask(ctx.orgA, q, collectionId, rag);
  expect(fresh.cached).toBe(false);
  expect(fresh.content).toContain('R$ 150,00');

  // exclusao feita por outro processo (outra replica, cron da demo): idem
  await ctx.h.db.delete(documents).where(eq(documents.id, documentId));
  const gone = await ask(ctx.orgA, q, collectionId, rag);
  expect(gone.cached).toBe(false);
  expect(gone.content).toBe(NO_ANSWER);
});
