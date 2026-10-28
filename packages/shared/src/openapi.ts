import { z } from 'zod';
import * as api from './api';
import { Collection, Conversation, Document, Id } from './entities';

type Method = 'get' | 'post' | 'patch' | 'delete';
type Route = {
  method: Method;
  /** Relativo a API_PREFIX, no formato Express (`/documents/:id`). */
  path: string;
  summary: string;
  tag: string;
  /** false = rota pública (sem bearerAuth). */
  auth?: boolean;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  /** multipart/form-data em vez de JSON. */
  multipart?: boolean;
  /** Código -> schema (null = sem corpo). SSE usa `sse`. */
  responses: Record<number, z.ZodTypeAny | null>;
  sse?: z.ZodTypeAny;
};

const IdParams = z.object({ id: Id });
const UrlBody = api.ImportDocumentUrlBody.extend({ collectionId: Id });
// espelha AgentRequestSchema de @docmind/agent (shared não depende de agent)
const AgentRequest = z.object({ query: z.string().min(1).max(2000), collectionId: Id.optional(), documentIds: z.array(Id).max(10).optional() });
const Ready = z.object({ status: z.enum(['ready', 'unavailable']), checks: z.object({ db: z.enum(['ok', 'fail']), redis: z.enum(['ok', 'fail', 'skipped']) }) });
const Feedback = api.FeedbackResponse;

/**
 * Tabela de rotas do contrato /api/v1 (fonte única para o OpenAPI). Framework-agnóstica:
 * ao criar/alterar uma rota, edite esta tabela junto com o schema Zod em ./api.
 */
export const ROUTES: Route[] = [
  { method: 'get', path: '/health', tag: 'system', summary: 'Health check', auth: false, responses: { 200: api.HealthResponse } },
  { method: 'get', path: '/ready', tag: 'system', summary: 'Readiness (db/redis); 503 em shutdown ou dependência fora', auth: false, responses: { 200: Ready, 503: Ready } },
  { method: 'get', path: '/openapi.json', tag: 'system', summary: 'Este documento', auth: false, responses: { 200: z.record(z.string(), z.unknown()) } },

  { method: 'post', path: '/auth/register', tag: 'auth', summary: 'Cria organização e usuário owner', auth: false, body: api.RegisterBody, responses: { 201: api.AuthResponse } },
  { method: 'post', path: '/auth/login', tag: 'auth', summary: 'Login', auth: false, body: api.LoginBody, responses: { 200: api.AuthResponse } },
  { method: 'post', path: '/auth/refresh', tag: 'auth', summary: 'Renova o token', auth: false, responses: { 200: api.AuthResponse } },
  { method: 'post', path: '/auth/logout', tag: 'auth', summary: 'Logout', auth: false, responses: { 204: null } },
  { method: 'get', path: '/auth/demo', tag: 'auth', summary: 'A conta de demonstração está disponível?', auth: false, responses: { 200: api.DemoStatus } },
  { method: 'post', path: '/auth/demo', tag: 'auth', summary: 'Entra na conta de demonstração, sem senha e somente leitura (404 se DEMO_LOGIN_ENABLED=false; 20/h por IP)', auth: false, responses: { 200: api.AuthResponse } },
  { method: 'post', path: '/auth/switch-org', tag: 'auth', summary: 'Troca a organização ativa (exige membership)', body: api.SwitchOrgBody, responses: { 200: api.AuthResponse } },
  { method: 'get', path: '/organizations', tag: 'auth', summary: 'Organizações do usuário', responses: { 200: api.OrganizationList } },

  { method: 'get', path: '/collections', tag: 'collections', summary: 'Lista coleções', responses: { 200: api.CollectionList } },
  { method: 'post', path: '/collections', tag: 'collections', summary: 'Cria coleção', body: api.CreateCollectionBody, responses: { 201: Collection } },
  { method: 'get', path: '/collections/:id', tag: 'collections', summary: 'Detalha coleção', params: IdParams, responses: { 200: Collection } },
  { method: 'patch', path: '/collections/:id', tag: 'collections', summary: 'Atualiza coleção', params: IdParams, body: api.UpdateCollectionBody, responses: { 200: Collection } },
  { method: 'delete', path: '/collections/:id', tag: 'collections', summary: 'Remove coleção (admin)', params: IdParams, responses: { 204: null } },

  { method: 'post', path: '/collections/:id/documents', tag: 'documents', summary: 'Upload de documento (campo `file`)', params: IdParams, multipart: true, responses: { 201: Document } },
  { method: 'post', path: '/collections/:id/documents/import', tag: 'documents', summary: 'Importa documento por URL para a coleção', params: IdParams, body: api.ImportDocumentUrlBody, responses: { 201: Document } },
  { method: 'post', path: '/documents/url', tag: 'documents', summary: 'Importa documento por URL (alias; collectionId no corpo)', body: UrlBody, responses: { 201: Document } },
  { method: 'get', path: '/documents', tag: 'documents', summary: 'Lista documentos (paginado por cursor)', query: api.ListDocumentsPageQuery, responses: { 200: api.DocumentList } },
  { method: 'get', path: '/documents/events', tag: 'documents', summary: 'Eventos de ingestão da organização/coleção (SSE)', query: api.ListDocumentsQuery, responses: {}, sse: z.unknown() },
  { method: 'get', path: '/documents/:id', tag: 'documents', summary: 'Detalha documento', params: IdParams, responses: { 200: Document } },
  { method: 'post', path: '/documents/:id/process', tag: 'documents', summary: '(Re)processa documento pending/failed', params: IdParams, responses: { 202: Document } },
  { method: 'delete', path: '/documents/:id', tag: 'documents', summary: 'Remove documento', params: IdParams, responses: { 204: null } },
  { method: 'get', path: '/documents/:id/events', tag: 'documents', summary: 'Progresso da ingestão (SSE)', params: IdParams, responses: {}, sse: z.unknown() },

  { method: 'post', path: '/conversations', tag: 'conversations', summary: 'Cria conversa', body: api.CreateConversationBody, responses: { 201: Conversation } },
  { method: 'get', path: '/conversations', tag: 'conversations', summary: 'Lista conversas', responses: { 200: api.ConversationList } },
  { method: 'get', path: '/conversations/:id', tag: 'conversations', summary: 'Detalha conversa com mensagens', params: IdParams, responses: { 200: api.ConversationDetail } },
  { method: 'post', path: '/conversations/:id/messages', tag: 'conversations', summary: 'Envia pergunta; resposta em SSE (token, citations, done, error)', params: IdParams, body: api.SendMessageBody, responses: {}, sse: api.SseEvent },
  { method: 'post', path: '/messages/:id/feedback', tag: 'conversations', summary: 'Avalia uma resposta', params: IdParams, body: api.CreateFeedbackBody, responses: { 200: Feedback } },

  { method: 'post', path: '/agent/run', tag: 'agent', summary: 'Executa o agente; eventos SSE (plan, step, step_result, result | error)', body: AgentRequest, responses: {}, sse: z.unknown() },

  { method: 'get', path: '/usage', tag: 'usage', summary: 'Consumo e custo do período', query: api.UsageQuery, responses: { 200: api.UsageReport } },

  { method: 'get', path: '/organization', tag: 'organization', summary: 'Organização atual', responses: { 200: api.OrganizationDetail } },
  { method: 'get', path: '/organization/members', tag: 'organization', summary: 'Lista membros', responses: { 200: api.MemberList } },
  { method: 'post', path: '/organization/members', tag: 'organization', summary: 'Adiciona membro (admin)', body: api.AddMemberBody, responses: { 201: api.Member } },
  { method: 'patch', path: '/organization/members/:userId', tag: 'organization', summary: 'Altera papel de membro (admin)', params: z.object({ userId: Id }), body: api.UpdateMemberBody, responses: { 200: api.Member } },
];

const schema = (s: z.ZodTypeAny, io: 'input' | 'output' = 'output') => {
  const json = z.toJSONSchema(s, { target: 'openapi-3.0', io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
};

function parameters(r: Route) {
  const out: object[] = [];
  for (const [where, s] of [['path', r.params], ['query', r.query]] as const) {
    if (!s) continue;
    const json = schema(s, 'input') as { properties?: Record<string, object>; required?: string[] };
    for (const [name, sch] of Object.entries(json.properties ?? {}))
      out.push({ name, in: where, required: where === 'path' || !!json.required?.includes(name), schema: sch });
  }
  return out;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content' };

function operation(r: Route) {
  const responses: Record<string, object> = {};
  for (const [code, s] of Object.entries(r.responses))
    responses[code] = { description: STATUS_TEXT[+code] ?? '', ...(s ? { content: { 'application/json': { schema: schema(s) } } } : {}) };
  if (r.sse)
    responses['200'] = { description: 'text/event-stream; cada evento é `event: <type>` + `data: <JSON>`', content: { 'text/event-stream': { schema: schema(r.sse) } } };
  responses['default'] = { description: 'Erro', content: { 'application/json': { schema: schema(api.ApiError) } } };
  return {
    tags: [r.tag],
    summary: r.summary,
    ...(r.auth === false ? {} : { security: [{ bearerAuth: [] }] }),
    ...(parameters(r).length ? { parameters: parameters(r) } : {}),
    ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(r.body, 'input') } } } } : {}),
    ...(r.multipart
      ? { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } } }
      : {}),
    responses,
  };
}

export type OpenApiDocument = {
  openapi: '3.0.3';
  info: { title: string; version: string };
  paths: Record<string, Record<string, object>>;
  components: object;
};

/** Documento OpenAPI 3.0 de /api/v1 gerado dos schemas Zod. Paths ficam completos (`/api/v1/...`) com `{param}`. */
export function buildOpenApi(info: { title?: string; version?: string } = {}): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  for (const r of ROUTES) {
    const p = `${api.API_PREFIX}${r.path.replace(/:(\w+)/g, '{$1}')}`;
    (paths[p] ??= {})[r.method] = operation(r);
  }
  return {
    openapi: '3.0.3',
    info: { title: info.title ?? 'DocMind API', version: info.version ?? '0.0.0' },
    paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  };
}
