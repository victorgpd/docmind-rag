/**
 * Manutencao da conta de demonstracao (DEMO_USER_EMAIL). Idempotente: rode uma vez e agende 1x/dia.
 *  a) garante o usuario (papel member) na organizacao propria "Demonstração", com senha aleatoria descartada (so entra por POST /auth/demo);
 *  b) garante a colecao "Políticas da empresa (exemplo)" com os documentos ficticios de ./demo-docs e enfileira os que nao estao prontos;
 *  c) apaga as conversas da organizacao demo com mais de 24 h (mensagens e feedback saem em cascata).
 * Producao (a imagem da API roda com tsx; cwd /app/apps/api):
 *   docker compose -p docmind -f docker-compose.prod.yml --env-file .env.production exec -T api /app/node_modules/.bin/tsx src/scripts/demo-maintenance.ts
 * Sem REDIS_URL a fila e em memoria e nao cruza processos: a ingestao roda aqui mesmo. Com PGlite quem roda isto e a propria API, no boot (main.ts).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash } from '@node-rs/argon2';
import { loadConfig } from '@docmind/config';
import { collections, conversations, createDb, documents, eq, memberships, organizations, sql, users, withOrg, type Db } from '@docmind/db';
import { createLLMFromConfig } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage, type Storage } from '@docmind/storage';
import { INGEST_QUEUE, ingestOptionsFromConfig, processDocument, type IngestJob } from '@docmind/worker';
import { DEMO_ORG_NAME } from '../http/demo';

export const DEMO_COLLECTION = 'Políticas da empresa (exemplo)';
const DOCS_DIR = new URL('./demo-docs/', import.meta.url);

export type DemoMaintenanceDeps = {
  /** Conexao crua (privilegiada): so para usuario/organizacao/membership; o resto passa por withOrg (RLS da org demo). */
  db: Db;
  storage: Storage;
  email: string;
  /** Enfileira a ingestao (ou a executa, sem fila entre processos). */
  enqueue: (job: IngestJob) => Promise<void>;
};

export async function demoMaintenance({ db, storage, email, enqueue }: DemoMaintenanceDeps) {
  email = email.toLowerCase();
  // a) usuario + organizacao: ainda nao ha org para o RLS (como no cadastro)
  let [user] = await db.select().from(users).where(eq(users.email, email));
  const userCreated = !user;
  if (!user) {
    const passwordHash = await hash(randomBytes(32).toString('base64url')); // descartada: ninguem entra por senha
    user = await db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ name: DEMO_ORG_NAME, slug: `demonstracao-${randomUUID().slice(0, 6)}` }).returning();
      const [u] = await tx.insert(users).values({ organizationId: org!.id, email, name: 'Visitante', passwordHash }).returning();
      return u!;
    });
  }
  const orgId = user.organizationId;
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  // o passo c apaga conversas da org inteira: nunca numa conta real apontada por engano em DEMO_USER_EMAIL
  if (org?.name !== DEMO_ORG_NAME) throw new Error(`DEMO_USER_EMAIL pertence a uma conta fora da organização "${DEMO_ORG_NAME}"; nada foi alterado`);
  await db
    .insert(memberships)
    .values({ organizationId: orgId, userId: user.id, role: 'member' })
    .onConflictDoUpdate({ target: [memberships.organizationId, memberships.userId], set: { role: 'member' } });

  // b) colecao e documentos, sob RLS da org demo
  const files = (await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md')).sort();
  const toIngest = await withOrg(db, orgId, async (tx) => {
    let [col] = await tx.select().from(collections).where(eq(collections.name, DEMO_COLLECTION));
    col ??= (
      await tx.insert(collections).values({ organizationId: orgId, name: DEMO_COLLECTION, description: 'Documentos fictícios para a demonstração.' }).returning()
    )[0]!;
    const have = new Map((await tx.select().from(documents).where(eq(documents.collectionId, col.id))).map((d) => [d.filename, d]));
    const ids: string[] = [];
    for (const filename of files) {
      const doc = have.get(filename);
      if (doc?.status === 'ready' || doc?.status === 'processing') continue;
      if (doc) {
        await tx.update(documents).set({ status: 'pending', error: null }).where(eq(documents.id, doc.id));
        ids.push(doc.id);
        continue;
      }
      const data = await readFile(new URL(filename, DOCS_DIR));
      const id = randomUUID();
      const storageKey = `${orgId}/${id}/${filename}`;
      await storage.put(storageKey, data);
      await tx.insert(documents).values({ id, organizationId: orgId, collectionId: col.id, filename, mimeType: 'text/markdown', sizeBytes: data.length, storageKey });
      ids.push(id);
    }
    return ids;
  });
  for (const documentId of toIngest) await enqueue({ organizationId: orgId, documentId });

  // c) historico de visitantes com mais de 24 h
  const deleted = await withOrg(db, orgId, (tx) =>
    tx.delete(conversations).where(sql`${conversations.createdAt} < now() - interval '24 hours'`).returning({ id: conversations.id }),
  );
  return { userCreated, documentsQueued: toIngest.length, conversationsDeleted: deleted.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig();
  if (!config.DEMO_USER_EMAIL) {
    console.error('[demo] defina DEMO_USER_EMAIL');
    process.exit(1);
  }
  const handle = await createDb({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
  await handle.migrate();
  const storage = createStorage({ dir: config.STORAGE_DIR, s3Endpoint: config.S3_ENDPOINT });
  const queue = config.REDIS_URL ? createQueue({ redisUrl: config.REDIS_URL }) : undefined;
  const llm = queue ? undefined : createLLMFromConfig(config);
  try {
    const summary = await demoMaintenance({
      db: handle.db,
      storage,
      email: config.DEMO_USER_EMAIL,
      enqueue: queue
        ? (job) => queue.enqueue<IngestJob>(INGEST_QUEUE, job)
        : (job) => processDocument(job, { db: handle.db, storage, llm: llm!, ...ingestOptionsFromConfig(config) }),
    });
    console.log(`[demo] ok ${JSON.stringify(summary)}`); // so contagens: nada de e-mail, chaves ou URLs
  } catch (e) {
    console.error(`[demo] falhou: ${e instanceof Error ? e.message : 'erro desconhecido'}`);
    process.exitCode = 1;
  } finally {
    await queue?.close();
    await handle.close();
  }
}
