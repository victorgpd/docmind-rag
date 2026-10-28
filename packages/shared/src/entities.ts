import { z } from 'zod';

export const Id = z.string().uuid();
export const Timestamp = z.string().datetime();

export const Role = z.enum(['owner', 'admin', 'member', 'viewer']);
export type Role = z.infer<typeof Role>;

export const Organization = z.object({ id: Id, name: z.string(), slug: z.string(), createdAt: Timestamp });
export type Organization = z.infer<typeof Organization>;

export const User = z.object({
  id: Id,
  organizationId: Id,
  email: z.string().email(),
  name: z.string(),
  createdAt: Timestamp,
});
export type User = z.infer<typeof User>;

export const Membership = z.object({ id: Id, organizationId: Id, userId: Id, role: Role, createdAt: Timestamp });
export type Membership = z.infer<typeof Membership>;

export const Collection = z.object({
  id: Id,
  organizationId: Id,
  name: z.string().min(1).max(120),
  description: z.string().nullable(),
  createdAt: Timestamp,
});
export type Collection = z.infer<typeof Collection>;

export const DocumentStatus = z.enum(['pending', 'processing', 'ready', 'failed']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const Document = z.object({
  id: Id,
  organizationId: Id,
  collectionId: Id,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  storageKey: z.string(),
  status: DocumentStatus,
  error: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  createdAt: Timestamp,
});
export type Document = z.infer<typeof Document>;

export const Chunk = z.object({
  id: Id,
  organizationId: Id,
  documentId: Id,
  collectionId: Id,
  ordinal: z.number().int(),
  page: z.number().int().nullable(),
  content: z.string(),
});
export type Chunk = z.infer<typeof Chunk>;

/** Citacao: n e o marcador [n] no texto da resposta. */
export const Citation = z.object({
  documentId: Id,
  page: z.number().int().nullable(),
  snippet: z.string(),
  n: z.number().int().positive(),
});
export type Citation = z.infer<typeof Citation>;

export const Conversation = z.object({
  id: Id,
  organizationId: Id,
  userId: Id,
  collectionId: Id.nullable(),
  title: z.string(),
  createdAt: Timestamp,
});
export type Conversation = z.infer<typeof Conversation>;

export const MessageRole = z.enum(['user', 'assistant', 'system']);
export const Message = z.object({
  id: Id,
  organizationId: Id,
  conversationId: Id,
  role: MessageRole,
  content: z.string(),
  citations: z.array(Citation),
  /** Modo agente: { intent, data (ex.: tabela extraida), steps, truncated }. Ausente/null no chat comum. */
  data: z.unknown().nullable().optional(),
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const Feedback = z.object({
  id: Id,
  organizationId: Id,
  messageId: Id,
  userId: Id,
  rating: z.enum(['up', 'down']),
  comment: z.string().nullable(),
  createdAt: Timestamp,
});
export type Feedback = z.infer<typeof Feedback>;

export const UsageEventKind = z.enum(['query', 'ingest', 'embed']);
export const UsageEvent = z.object({
  id: Id,
  organizationId: Id,
  userId: Id.nullable(),
  kind: UsageEventKind,
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  latencyMs: z.number().int().nullable(),
  createdAt: Timestamp,
});
export type UsageEvent = z.infer<typeof UsageEvent>;

export const EvalRun = z.object({
  id: Id,
  organizationId: Id,
  name: z.string(),
  metrics: z.record(z.string(), z.number()),
  createdAt: Timestamp,
});
export type EvalRun = z.infer<typeof EvalRun>;
