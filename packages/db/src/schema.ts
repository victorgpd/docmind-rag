import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// Fonte da verdade do SQL: migrations/0000_init.sql (RLS, HNSW e GIN vivem la). Mantenha em sincronia.

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const id = () => uuid('id').primaryKey().defaultRandom();
const orgId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// organizations: a propria linha e o "tenant"; RLS usa id = app.org_id.
export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  organizationId: orgId(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const memberships = pgTable('memberships', {
  id: id(),
  organizationId: orgId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: createdAt(),
});

export const collections = pgTable('collections', {
  id: id(),
  organizationId: orgId(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: createdAt(),
});

export const documents = pgTable('documents', {
  id: id(),
  organizationId: orgId(),
  collectionId: uuid('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storageKey: text('storage_key').notNull(),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  pageCount: integer('page_count'),
  createdAt: createdAt(),
});

export const chunks = pgTable(
  'chunks',
  {
    id: id(),
    organizationId: orgId(),
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    page: integer('page'),
    content: text('content').notNull(),
    context: text('context'),
    section: text('section'),
    tokenCount: integer('token_count'),
    /** Modelo que gerou o embedding (ex.: 'local:hash-v2:384'); null = desconhecido. */
    embeddingModel: text('embedding_model'),
    embedding: vector('embedding', { dimensions: 384 }),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('simple', content)`),
  },
  (t) => [
    index('chunks_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('chunks_tsv_gin').using('gin', t.tsv),
  ],
);

export const conversations = pgTable('conversations', {
  id: id(),
  organizationId: orgId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  collectionId: uuid('collection_id').references(() => collections.id, { onDelete: 'set null' }),
  title: text('title').notNull().default('Nova conversa'),
  createdAt: createdAt(),
});

export const messages = pgTable('messages', {
  id: id(),
  organizationId: orgId(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  citations: jsonb('citations').notNull().default([]),
  /** Payload estruturado do modo agente (intent, data da ferramenta, passos); NULL no chat comum. */
  data: jsonb('data'),
  createdAt: createdAt(),
});

export const feedback = pgTable('feedback', {
  id: id(),
  organizationId: orgId(),
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rating: text('rating').notNull(),
  comment: text('comment'),
  createdAt: createdAt(),
});

export const usageEvents = pgTable('usage_events', {
  id: id(),
  organizationId: orgId(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  latencyMs: integer('latency_ms'),
  createdAt: createdAt(),
});

export const evalRuns = pgTable('eval_runs', {
  id: id(),
  organizationId: orgId(),
  name: text('name').notNull(),
  metrics: jsonb('metrics').notNull().default({}),
  createdAt: createdAt(),
});

// Fonte do SQL: migrations/0001_refresh_tokens.sql. Sem RLS: so a conexao privilegiada (auth) acessa.
export const refreshTokens = pgTable('refresh_tokens', {
  id: id(),
  organizationId: orgId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  familyId: uuid('family_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  replacedBy: uuid('replaced_by'),
  createdAt: createdAt(),
});
