import { z } from 'zod';
import { Citation, Collection, Conversation, Document, DocumentStatus, Feedback, Id, Message, Organization, Role, User } from './entities';

export const API_PREFIX = '/api/v1';

// auth
/** Politica minima de senha: 8-128 caracteres com ao menos uma letra e um numero (128 evita DoS no argon2). */
export const Password = z
  .string()
  .min(8)
  .max(128)
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/[0-9]/, 'must contain a digit');
export const RegisterBody = z.object({
  email: z.string().email(),
  password: Password,
  name: z.string().min(1),
  organizationName: z.string().min(1),
});
export const LoginBody = z.object({ email: z.string().email(), password: z.string().max(128) });
export const SwitchOrgBody = z.object({ organizationId: Id });
export const OrganizationList = z.object({ items: z.array(Organization.extend({ role: Role })) });
/** demo: true so na conta de demonstracao (somente leitura); o web desabilita as acoes de escrita. */
export const AuthResponse = z.object({ token: z.string(), user: User, demo: z.boolean().optional() });
/** GET /auth/demo: a conta de demonstracao esta ligada e preparada? (o web so mostra o botao com enabled=true) */
export const DemoStatus = z.object({ enabled: z.boolean() });
export type RegisterBody = z.infer<typeof RegisterBody>;
export type LoginBody = z.infer<typeof LoginBody>;
export type AuthResponse = z.infer<typeof AuthResponse>;

// collections  (GET/POST /collections, GET/PATCH/DELETE /collections/:id)
export const CreateCollectionBody = z.object({ name: z.string().min(1).max(120), description: z.string().optional() });
export const UpdateCollectionBody = CreateCollectionBody.partial();
export const CollectionList = z.object({ items: z.array(Collection) });

// documents  (POST /collections/:id/documents multipart; GET /documents?collectionId=; GET/DELETE /documents/:id)
// nextCursor: id do ultimo item da pagina (passe em ?cursor=); null/ausente = ultima pagina
export const DocumentList = z.object({ items: z.array(Document), nextCursor: z.string().nullable().optional() });
export const ListDocumentsQuery = z.object({ collectionId: Id.optional() });
export const ListDocumentsPageQuery = ListDocumentsQuery.extend({
  status: DocumentStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: Id.optional(),
});
export type ListDocumentsPageQuery = z.infer<typeof ListDocumentsPageQuery>;

// conversations  (POST/GET /conversations, GET /conversations/:id, POST /conversations/:id/messages -> SSE)
export const CreateConversationBody = z.object({ collectionId: Id.optional(), title: z.string().optional() });
export const ConversationList = z.object({ items: z.array(Conversation) });
// warnings: avisos calculados ao abrir a conversa (ex.: 'reindex_needed' se a coleção hoje tem chunks de outro modelo de embedding). Ausente = nenhum.
export const ConversationDetail = Conversation.extend({ messages: z.array(Message), warnings: z.array(z.string()).optional() });
export const SendMessageBody = z.object({ content: z.string().min(1), agent: z.boolean().optional() });

// SSE do POST /conversations/:id/messages (event: <type>, data: JSON)
export const SseEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), delta: z.string() }),
  // modo agente ({agent:true}): os mesmos eventos de POST /agent/run, seguidos de `done` com o messageId
  z.object({ type: z.literal('plan'), intent: z.string() }),
  z.object({ type: z.literal('step'), tool: z.string(), n: z.number().int().optional(), input: z.unknown().optional(), output: z.unknown().optional() }),
  z.object({ type: z.literal('step_result'), n: z.number().int(), tool: z.string(), ok: z.boolean(), ms: z.number().int(), error: z.string().optional() }),
  z.object({ type: z.literal('result'), result: z.unknown() }), // AgentResult de @docmind/agent (answer, citations, data, steps, truncated, usage)
  z.object({ type: z.literal('citations'), citations: z.array(Citation) }),
  // warnings: avisos não fatais da busca. 'reindex_needed' = há chunks de outro modelo de embedding (ou desconhecido) no escopo;
  // a parte vetorial os ignora (a de texto não) e o usuário deve reindexar. Ausente = nenhum aviso.
  z.object({ type: z.literal('done'), messageId: Id, tokensIn: z.number().int(), tokensOut: z.number().int(), warnings: z.array(z.string()).optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type SseEvent = z.infer<typeof SseEvent>;

// feedback  (POST /messages/:id/feedback)
export const CreateFeedbackBody = z.object({ rating: z.enum(['up', 'down']), comment: z.string().optional() });
export const FeedbackResponse = Feedback;

// usage  (GET /usage?from=&to=)
export const UsageQuery = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });
export const UsageSummary = z.object({
  queries: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  documents: z.number().int(),
});
/** Resposta de GET /usage: UsageSummary + custo, periodo e limite mensal de tokens (null = sem limite). */
export const UsageReport = UsageSummary.extend({
  costUsd: z.number(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  monthlyTokenLimit: z.number().int().nullable(),
  limitExceeded: z.boolean(),
  /** Teto global do servico (todas as organizacoes, GLOBAL_MONTHLY_TOKEN_LIMIT) atingido no mes; nao expoe os numeros globais. */
  serviceLimitReached: z.boolean(),
});
export type UsageReport = z.infer<typeof UsageReport>;

// organizacao e membros  (GET /organization, GET/POST /organization/members, PATCH /organization/members/:userId)
export const MemberRole = z.enum(['admin', 'member']);
export const AddMemberBody = RegisterBody.pick({ email: true, password: true, name: true }).extend({ role: MemberRole.default('member') });
export const UpdateMemberBody = z.object({ role: MemberRole });
export const Member = z.object({ userId: Id, email: z.string().email(), name: z.string(), role: Role });
export const MemberList = z.object({ items: z.array(Member) });
export const OrganizationDetail = Organization.extend({ role: Role });

// health  (GET /health)
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  db: z.enum(['pglite', 'postgres']),
  queue: z.enum(['memory', 'bullmq']),
  llm: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

// import por URL  (POST /collections/:id/documents/import)
export const ImportDocumentUrlBody = z.object({ url: z.string().url() });
export type ImportDocumentUrlBody = z.infer<typeof ImportDocumentUrlBody>;
