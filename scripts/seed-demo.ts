/**
 * Popula uma API ja rodando (`pnpm dev`) com org, admin, colecao e documentos de exemplo.
 * Idempotente: se o admin ja existe, faz login; documentos com o mesmo nome sao pulados.
 * SO PARA DEV: as credenciais abaixo sao publicas.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = (process.env.DEMO_API_URL ?? 'http://localhost:3001') + '/api/v1';
const DEMO = { email: 'demo@docmind.dev', password: 'demo-docmind-123', name: 'Demo Admin', organizationName: 'Acme Demo' };
const COLLECTION = 'Documentos de exemplo';
const DOCS_DIR = join(import.meta.dirname, 'demo-docs');
const MIME: Record<string, string> = { md: 'text/markdown', txt: 'text/plain' };

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(API + path, { ...init, headers: { ...(token && { authorization: `Bearer ${token}` }), ...init.headers } });
  return { status: res.status, body: (res.status === 204 ? null : await res.json().catch(() => null)) as T };
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function authenticate(): Promise<string> {
  const login = await call<{ token: string }>('/auth/login', json({ email: DEMO.email, password: DEMO.password }));
  if (login.status === 200) return login.body.token;
  const reg = await call<{ token: string }>('/auth/register', json(DEMO));
  if (reg.status !== 201) throw new Error(`register falhou (${reg.status}): ${JSON.stringify(reg.body)}`);
  return reg.body.token;
}

type Doc = { id: string; filename: string; status: string; error: string | null };

async function waitReady(id: string, token: string, timeoutMs = Number(process.env.DEMO_WAIT_MS ?? 60_000)): Promise<Doc> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call<Doc>(`/documents/${id}`, {}, token);
    if (['ready', 'failed'].includes(body.status) || Date.now() > end) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`API fora do ar em ${API}. Rode "pnpm dev" em outro terminal.`);

  const token = await authenticate();

  const cols = await call<{ items: { id: string; name: string }[] }>('/collections', {}, token);
  let collectionId = cols.body.items.find((c) => c.name === COLLECTION)?.id;
  collectionId ??= (await call<{ id: string }>('/collections', json({ name: COLLECTION, description: 'Documentos curtos para a demo' }), token)).body.id;
  if (!collectionId) throw new Error('nao foi possivel criar a colecao');

  const existing = await call<{ items: Doc[] }>(`/documents?collectionId=${collectionId}`, {}, token);
  const have = new Set(existing.body.items.map((d) => d.filename));

  let failures = 0;
  for (const file of (await readdir(DOCS_DIR)).sort()) {
    if (have.has(file)) {
      console.log(`= ${file} (ja existe)`);
      continue;
    }
    const form = new FormData();
    form.append('file', new Blob([await readFile(join(DOCS_DIR, file))], { type: MIME[file.split('.').pop()!] }), file);
    const up = await call<Doc>(`/collections/${collectionId}/documents`, { method: 'POST', body: form }, token);
    if (up.status !== 201) throw new Error(`upload de ${file} falhou (${up.status}): ${JSON.stringify(up.body)}`);
    await call(`/documents/${up.body.id}/process`, { method: 'POST' }, token);
    const doc = await waitReady(up.body.id, token);
    console.log(`${doc.status === 'ready' ? '+' : '!'} ${file}: ${doc.status}${doc.error ? ` (${doc.error})` : ''}`);
    if (doc.status !== 'ready') failures++;
  }

  console.log(`\nLogin de demo (so dev): ${DEMO.email} / ${DEMO.password}`);
  if (failures) {
    console.log(`${failures} documento(s) nao ficaram prontos. Sem REDIS_URL a fila e em memoria: o worker precisa rodar no mesmo processo da API.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
