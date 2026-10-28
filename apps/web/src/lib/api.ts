// Somente `import type` de @docmind/shared: os schemas Zod nao entram no bundle do cliente (o servidor valida).
import type { AuthResponse, Collection, Document, LoginBody, Organization, RegisterBody } from '@docmind/shared';
import { createSseParser } from './sse';

export const DOCUMENTS_PAGE_SIZE = 20;
const API_PREFIX = '/api/v1'; // mesmo valor de shared.API_PREFIX

// Endpoints fora de packages/shared:
//   POST /auth/refresh (cookie httpOnly) -> AuthResponse     POST /auth/logout -> 204
//   GET /organizations -> {items: Organization[]}            POST /auth/switch-org {organizationId} -> AuthResponse
//   POST /collections/:id/documents/import {url} -> Document
//   GET /documents/events?collectionId= (SSE, event "document", data = Document)

const BASE = process.env.NEXT_PUBLIC_API_URL ?? ''; // vazio = mesma origem, via rewrite do Next

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'unknown',
  ) {
    super(message);
  }
}

// Access token so em memoria (nao em localStorage): o refresh vem do cookie httpOnly.
let accessToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export const getAccessToken = () => accessToken;
/** O AuthProvider registra aqui o que fazer quando o refresh falha. */
export const setSessionExpiredHandler = (fn: (() => void) | null) => (onSessionExpired = fn);

function url(path: string) {
  return `${BASE}${API_PREFIX}${path}`;
}

async function toError(res: Response) {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const e = body?.error;
  return e?.message ? new ApiRequestError(e.message, res.status, e.code) : new ApiRequestError(`Erro ${res.status}`, res.status);
}

let refreshing: Promise<AuthResponse | null> | null = null;

/** Troca o cookie de refresh por um novo access token. Uma chamada por vez (single-flight). */
export function refresh() {
  refreshing ??= (async () => {
    try {
      const res = await fetch(url('/auth/refresh'), { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error();
      const auth = (await res.json()) as AuthResponse;
      if (!auth.token) throw new Error();
      accessToken = auth.token;
      return auth;
    } catch {
      accessToken = null;
      return null;
    }
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function authFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const res = await fetch(url(path), { ...init, headers, credentials: 'include' });
  if (res.status !== 401 || !retry) return res;
  if (await refresh()) return authFetch(path, init, false);
  onSessionExpired?.();
  return res;
}

async function call<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  const res = await authFetch(path, init, retry);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

async function callVoid(path: string, init?: RequestInit) {
  const res = await authFetch(path, init);
  if (!res.ok) throw await toError(res);
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function authenticate(
  path: string,
  body: LoginBody | RegisterBody | { organizationId: string } | Record<string, never>,
  retry: boolean,
) {
  const auth = await call<AuthResponse>(path, send('POST', body), retry);
  accessToken = auth.token;
  return auth;
}

export const api = {
  // retry=false: 401 em login/registro e credencial invalida, nao token expirado
  register: (body: RegisterBody) => authenticate('/auth/register', body, false),
  login: (body: LoginBody) => authenticate('/auth/login', body, false),
  /** Conta de demonstracao (somente leitura), sem senha. */
  demo: () => authenticate('/auth/demo', {}, false),
  /** GET /auth/demo publico: o botao de demonstracao so aparece com enabled=true. */
  demoEnabled: () =>
    fetch(url('/auth/demo'))
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled?: boolean }>) : null))
      .then((b) => b?.enabled === true)
      .catch(() => false),
  logout: async () => {
    await callVoid('/auth/logout', { method: 'POST' }).catch(() => undefined);
    accessToken = null;
  },
  listOrganizations: () => call<{ items: Organization[] }>('/organizations').then((r) => r.items),
  switchOrganization: (organizationId: string) =>
    authenticate('/auth/switch-org', { organizationId }, true),

  listCollections: () => call<{ items: Collection[] }>('/collections').then((r) => r.items),
  getCollection: (id: string) => call<Collection>(`/collections/${id}`),
  createCollection: (body: { name: string; description?: string }) =>
    call<Collection>('/collections', send('POST', body)),
  updateCollection: (id: string, body: { name?: string; description?: string }) =>
    call<Collection>(`/collections/${id}`, send('PATCH', body)),
  deleteCollection: (id: string) => callVoid(`/collections/${id}`, { method: 'DELETE' }),

  /** Uma pagina (mais recentes primeiro); nextCursor null = ultima. */
  listDocuments: (collectionId: string, cursor?: string) =>
    call<{ items: Document[]; nextCursor?: string | null }>(
      `/documents?collectionId=${encodeURIComponent(collectionId)}&limit=${DOCUMENTS_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ).then((r) => ({ items: r.items, nextCursor: r.nextCursor ?? null })),
  // A API so cria o documento "pending"; POST /documents/:id/process enfileira a ingestao (202 + Document).
  processDocument: (id: string) => call<Document>(`/documents/${id}/process`, { method: 'POST' }),
  uploadDocument: async (collectionId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    const doc = await call<Document>(`/collections/${collectionId}/documents`, {
      method: 'POST',
      body: form,
    });
    return api.processDocument(doc.id);
  },
  importDocument: async (collectionId: string, importUrl: string) => {
    const doc = await call<Document>(
      `/collections/${collectionId}/documents/import`,
      send('POST', { url: importUrl }),
    );
    return api.processDocument(doc.id);
  },
  deleteDocument: (id: string) => callVoid(`/documents/${id}`, { method: 'DELETE' }),

  /** Le o SSE de status ate o servidor fechar ou o signal abortar. fetch (nao EventSource) para enviar o Bearer. */
  async streamDocuments(
    collectionId: string,
    onDocument: (d: Document) => void,
    signal: AbortSignal,
  ) {
    const res = await authFetch(
      `/documents/events?collectionId=${encodeURIComponent(collectionId)}`,
      {
        signal,
        headers: { accept: 'text/event-stream' },
      },
    );
    if (!res.ok || !res.body) throw await toError(res);
    const feed = createSseParser((m) => {
      if (m.event !== 'document') return;
      try {
        const doc = JSON.parse(m.data) as Document;
        if (doc?.id) onDocument(doc);
      } catch {
        // evento malformado: ignora e segue no stream
      }
    });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      feed(value);
    }
  },
};

export const DEMO_READ_ONLY = 'A conta de demonstração é somente leitura. Crie uma conta gratuita para enviar seus documentos.';

export const errorMessage = (e: unknown) =>
  e instanceof ApiRequestError && e.code === 'demo_read_only' ? DEMO_READ_ONLY : e instanceof Error ? e.message : 'Algo deu errado';
