/**
 * `pnpm smoke`: sobe a API in-process (PGlite em memoria, LLM local, fila em memoria, worker no mesmo processo)
 * e percorre o fluxo principal via HTTP. Etapa ainda inexistente => PENDENTE (nao derruba as demais);
 * etapa que depende de outra que nao passou => PENDENTE "depende de".
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class Pending extends Error {}
const pending = (m: string): never => {
  throw new Pending(m);
};
const need = <T>(v: T | undefined, what: string): T => (v === undefined ? pending(`depende de: ${what}`) : v);
const assert = (c: unknown, m: string) => {
  if (!c) throw new Error(m);
};

const DOC = `# Busca híbrida

O DocMind combina busca vetorial e busca textual usando fusão RRF (Reciprocal Rank Fusion).
Cada trecho recuperado recebe uma citação numerada, para que a resposta aponte o documento de origem.
`;
const QUESTION = 'Como o DocMind combina busca vetorial e busca textual?';

async function main() {
  const storageDir = await mkdtemp(join(tmpdir(), 'docmind-smoke-'));
  let stop: () => Promise<void> = async () => {};
  let base = '';
  const ctx: { token?: string; collectionId?: string; docId?: string; ready?: boolean } = {};

  // SMOKE_URL=http://localhost:3001 => testa um stack ja rodando (ex.: docker compose) em vez de subir in-process
  // imports por caminho relativo: o scripts/ da raiz nao enxerga @docmind/*
  if (process.env.SMOKE_URL) base = process.env.SMOKE_URL.replace(/\/$/, '');
  else try {
    const [{ loadConfig }, { createDb }, { createLLM }, { createQueue }, { createStorage }, { buildApp }, { startWorker }] = await Promise.all([
      import('../packages/config/src/index.ts'),
      import('../packages/db/src/index.ts'),
      import('../packages/llm/src/index.ts'),
      import('../packages/queue/src/index.ts'),
      import('../packages/storage/src/index.ts'),
      import('../apps/api/src/app.ts'),
      import('../apps/worker/src/index.ts'),
    ]);
    const config = loadConfig({ NODE_ENV: 'test', LLM_PROVIDER: 'local', JWT_SECRET: 'smoke-secret', STORAGE_DIR: storageDir });
    const db = await createDb({ pgliteDir: ':memory:' });
    await db.migrate();
    const llm = createLLM({ provider: 'local' } as any);
    const queue = createQueue();
    const storage = createStorage({ dir: storageDir });
    const app = buildApp({ config, db, llm, queue, storage } as any);
    startWorker(queue, { db: db.db, storage, llm } as any);
    const server = app.listen(0, '127.0.0.1'); // Express: buildApp retorna o app, listen retorna http.Server
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    stop = async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await queue.close();
      await db.close();
    };
  } catch (e) {
    console.log(`FALHA     boot: ${e instanceof Error ? e.message : e}`);
    await rm(storageDir, { recursive: true, force: true });
    process.exit(1);
  }

  const call = async (path: string, init: RequestInit = {}) => {
    const headers = { ...(ctx.token && { authorization: `Bearer ${ctx.token}` }), ...(init.headers as object) };
    for (let i = 0; ; i++) {
      const res = await fetch(base + path, { ...init, headers });
      if (res.status === 429 && i < 5) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      // rota que ainda nao existe => etapa pendente
      if (res.status === 404) {
        const b: any = await res.clone().json().catch(() => ({}));
        // 404 generico do roteador (Express: error.code=not_found) = rota ainda nao portada
        if (b?.error?.code === 'not_found' || /^Route .* not found$/.test(b?.message ?? '')) pending(`rota ${path} ainda nao existe`);
      }
      return res;
    }
  };
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const email = `smoke-${Date.now()}@docmind.test`;
  const password = 'smoke-password-123';

  const steps: [string, () => Promise<string | void>][] = [
    ['health', async () => {
      const r = await call('/api/v1/health');
      const b: any = await r.json();
      assert(r.status === 200 && b.status === 'ok', `status ${r.status}`);
      return `db=${b.db} queue=${b.queue} llm=${b.llm}`;
    }],
    ['registro', async () => {
      const r = await call('/api/v1/auth/register', json({ email, password, name: 'Smoke', organizationName: 'Smoke Org' }));
      assert(r.status === 201, `status ${r.status} ${await r.clone().text()}`);
      ctx.token = ((await r.json()) as any).token;
    }],
    ['login', async () => {
      const r = await call('/api/v1/auth/login', json({ email, password }));
      assert(r.status === 200, `status ${r.status}`);
      ctx.token = ((await r.json()) as any).token;
      assert(ctx.token, 'sem token');
    }],
    ['criar colecao', async () => {
      need(ctx.token, 'login');
      const r = await call('/api/v1/collections', json({ name: 'Smoke' }));
      assert(r.status === 201, `status ${r.status} ${await r.clone().text()}`);
      ctx.collectionId = ((await r.json()) as any).id;
    }],
    ['upload .md', async () => {
      const col = need(ctx.collectionId, 'criar colecao');
      const form = new FormData();
      form.append('file', new Blob([DOC], { type: 'text/markdown' }), 'busca.md');
      const r = await call(`/api/v1/collections/${col}/documents`, { method: 'POST', body: form });
      assert(r.status === 201, `status ${r.status} ${await r.clone().text()}`);
      ctx.docId = ((await r.json()) as any).id;
    }],
    ['processar', async () => {
      const id = need(ctx.docId, 'upload .md');
      const r = await call(`/api/v1/documents/${id}/process`, { method: 'POST' });
      assert(r.status === 202 || r.status === 200, `status ${r.status} ${await r.clone().text()}`);
    }],
    ['aguardar pronto', async () => {
      const id = need(ctx.docId, 'upload .md');
      const end = Date.now() + 60_000;
      for (;;) {
        const d: any = await (await call(`/api/v1/documents/${id}`)).json();
        if (d.status === 'ready') {
          ctx.ready = true;
          return `${d.pageCount ?? '?'} pagina(s)`;
        }
        assert(d.status !== 'failed', `documento falhou: ${d.error}`);
        assert(Date.now() < end, `timeout em status=${d.status}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }],
    ['perguntar (SSE)', async () => {
      need(ctx.ready, 'aguardar pronto');
      const cr = await call('/api/v1/conversations', json({ collectionId: ctx.collectionId }));
      assert(cr.status === 201 || cr.status === 200, `criar conversa: status ${cr.status} ${await cr.clone().text()}`);
      const conv = ((await cr.json()) as any).id;
      const r = await call(`/api/v1/conversations/${conv}/messages`, json({ content: QUESTION }));
      assert(r.status === 200, `status ${r.status} ${await r.clone().text()}`);
      assert((r.headers.get('content-type') ?? '').includes('text/event-stream'), `content-type ${r.headers.get('content-type')}`);
      let answer = '';
      let citations: any[] = [];
      let done = false;
      for (const block of (await r.clone().text()).split('\n\n')) {
        const data = block.split('\n').find((l) => l.startsWith('data:'));
        if (!data) continue;
        const ev = JSON.parse(data.slice(5));
        if (ev.type === 'token') answer += ev.delta;
        else if (ev.type === 'citations') citations = ev.citations;
        else if (ev.type === 'done') done = true;
        else if (ev.type === 'error') throw new Error(`evento error: ${ev.message}`);
      }
      assert(done, 'stream terminou sem evento done');
      assert(/\[\d+\]/.test(answer), `resposta sem citacao [n]: "${answer.slice(0, 120)}"`);
      assert(citations.length > 0, 'sem evento citations');
      return `${answer.length} chars, ${citations.length} citacao(oes)`;
    }],
    ['/usage', async () => {
      need(ctx.token, 'login');
      const r = await call('/api/v1/usage');
      assert(r.status === 200, `status ${r.status}`);
      const b: any = await r.json();
      return `tokensIn=${b.tokensIn ?? '?'} tokensOut=${b.tokensOut ?? '?'}`;
    }],
    ['/metrics', async () => {
      const r = await call('/metrics');
      // fora do loopback (stack remoto/docker) o /metrics exige METRICS_TOKEN (403); pelo web (proxy so de /api/v1) nem existe (404)
      if (process.env.SMOKE_URL && (r.status === 403 || r.status === 404)) return `nao exposto (${r.status})`;
      assert(r.status === 200, `status ${r.status}`);
    }],
    ['openapi.json', async () => {
      const r = await call('/api/v1/openapi.json');
      assert(r.status === 200, `status ${r.status}`);
      const b: any = await r.json();
      assert(b.openapi && Object.keys(b.paths ?? {}).length > 0, 'spec vazia');
      return `${Object.keys(b.paths).length} paths`;
    }],
  ];

  let fail = 0;
  let pend = 0;
  for (const [name, fn] of steps) {
    try {
      const note = await fn();
      console.log(`OK        ${name}${note ? ` (${note})` : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Pending) {
        pend++;
        console.log(`PENDENTE  ${name}: ${msg}`);
      } else {
        fail++;
        console.log(`FALHA     ${name}: ${msg}`);
      }
    }
  }
  console.log(`\n${steps.length - fail - pend} OK, ${fail} FALHA, ${pend} PENDENTE`);
  await stop().catch(() => {});
  await rm(storageDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main();
