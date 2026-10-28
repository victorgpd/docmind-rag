// Só `import type` de @docmind/shared: os schemas Zod não entram no bundle do cliente (o servidor valida).
import type { Citation, Collection, Conversation, Document, Message, SseEvent } from '@docmind/shared';
import { getAccessToken, refresh } from '../../lib/api';
import { createSseParser } from '../../lib/sse';

const API_PREFIX = '/api/v1'; // mesmo valor de shared.API_PREFIX
const BASE = process.env.NEXT_PUBLIC_API_URL ?? ''; // vazio = mesma origem, via rewrite do Next

/** Passo de ferramenta do modo agente; ok/ms/error chegam no step_result. */
export type AgentStep = { n: number; tool: string; input?: unknown; ok?: boolean; ms?: number; error?: string };
export type Table = { headers: string[]; rows: unknown[][] };
// costUsd/monthlyTokenLimit/serviceLimitReached: campos aditivos de /usage.
export type Usage = { queries: number; tokensIn: number; tokensOut: number; documents: number; costUsd?: number; monthlyTokenLimit?: number; serviceLimitReached?: boolean };
/** 402 global_limit_exceeded: teto do serviço (todas as organizações) atingido. */
export const SERVICE_LIMIT_MESSAGE = 'O limite de uso do serviço foi atingido este mês. Tente novamente mais tarde.';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStr = (v: unknown) => typeof v === 'string';
const isNum = (v: unknown) => typeof v === 'number';

/** data.table do extract_table (null quando o documento não tem tabela). */
export const tableOf = (data: unknown): Table | undefined => {
  const t = isObj(data) ? data.table : undefined;
  if (!isObj(t) || !Array.isArray(t.headers) || !Array.isArray(t.rows)) return undefined;
  return { headers: t.headers.map(String), rows: t.rows.filter(Array.isArray) };
};

/** `result` do SSE (AgentResult de @docmind/agent): só answer, citations e data interessam à tela. */
export const parseAgentResult = (r: unknown) =>
  isObj(r) && isStr(r.answer) ? { answer: r.answer, citations: Array.isArray(r.citations) ? (r.citations as Citation[]) : [], data: r.data } : undefined;

/** Message.data de uma resposta do agente no histórico -> o que o ChatView exibe. */
export const agentView = (data: unknown) => {
  if (!isObj(data)) return {};
  const steps = Array.isArray(data.steps) ? data.steps.filter(isObj) : [];
  return {
    intent: isStr(data.intent) ? (data.intent as string) : undefined,
    steps: steps.map((s, i) => ({ n: i + 1, tool: String(s.tool), ok: s.ok === true, ms: isNum(s.ms) ? (s.ms as number) : undefined })),
    table: tableOf(data.data),
  };
};

/** fetch com Bearer do auth do frontend; 401 tenta um refresh e repete uma vez. */
async function authFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getAccessToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${BASE}${API_PREFIX}${path}`, { ...init, headers, credentials: 'include' });
  if (res.status === 401 && retry && (await refresh())) return authFetch(path, init, false);
  return res;
}

async function fail(res: Response): Promise<never> {
  const body = await res.json().catch(() => null);
  const err = isObj(body) && isObj(body.error) ? body.error : {};
  const message = err.code === 'global_limit_exceeded' ? SERVICE_LIMIT_MESSAGE : isStr(err.message) ? (err.message as string) : `Erro ${res.status}`;
  throw new Error(message);
}

// cast tipado: o servidor é a fonte de verdade das respostas
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Campos mínimos por tipo de evento; tipos desconhecidos ou malformados são ignorados. */
const GUARDS: Record<string, (e: Record<string, unknown>) => boolean> = {
  token: (e) => isStr(e.delta),
  citations: (e) => Array.isArray(e.citations),
  plan: (e) => isStr(e.intent),
  step: (e) => isStr(e.tool),
  step_result: (e) => isNum(e.n) && typeof e.ok === 'boolean',
  result: (e) => 'result' in e,
  done: (e) => isStr(e.messageId),
  error: (e) => isStr(e.message),
};

/** Extrai eventos de um corpo SSE; aceita chunks cortados em qualquer ponto. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const pending: string[] = [];
  const feed = createSseParser((m) => pending.push(m.data));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    feed(dec.decode(value, { stream: true }));
    for (let data = pending.shift(); data !== undefined; data = pending.shift()) {
      let ev: unknown;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (isObj(ev) && isStr(ev.type) && GUARDS[ev.type as string]?.(ev)) yield ev as SseEvent;
    }
  }
}

export const api = {
  collections: () => call<{ items: Collection[] }>('/collections').then((r) => r.items),
  conversations: () => call<{ items: Conversation[] }>('/conversations').then((r) => r.items),
  conversation: (id: string) => call<Conversation & { messages: Message[]; warnings?: string[] }>(`/conversations/${id}`),
  createConversation: (collectionId?: string) => call<Conversation>('/conversations', json('POST', { collectionId })),
  document: (id: string) => call<Document>(`/documents/${id}`),
  async feedback(messageId: string, rating: 'up' | 'down') {
    const res = await authFetch(`/messages/${messageId}/feedback`, json('POST', { rating }));
    if (!res.ok) await fail(res);
  },
  usage: () => call<Usage>('/usage'),
  async send(conversationId: string, content: string, agent: boolean, signal?: AbortSignal): Promise<AsyncGenerator<SseEvent>> {
    const res = await authFetch(`/conversations/${conversationId}/messages`, {
      ...json('POST', { content, agent }),
      signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) return fail(res); // 401/400/402 chegam como JSON, não SSE
    return parseSse(res.body);
  },
};
export type { Collection };
