import { expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { API_PREFIX } from '@docmind/shared';
import { ROUTES } from '@docmind/shared/openapi';
import { createStorage } from '@docmind/storage';
import { buildApp } from '../app';

// Fora do contrato /api/v1 de propósito: endpoint operacional restrito a loopback/token, não é API pública.
const OUT_OF_CONTRACT = new Set(['GET /metrics']);

type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] }; matchers?: ((p: string) => unknown)[] };

/** Express 5 não guarda o prefixo de um router montado: descobre-o testando os matchers da layer. */
function mountPrefix(layer: Layer, parent: string): string {
  const m = layer.matchers?.[0];
  if (!m) throw new Error('layer without matcher');
  if (m('/')) return parent; // app.use(router) sem caminho
  if (m(API_PREFIX)) return parent + API_PREFIX;
  throw new Error('router mounted at an unknown prefix; extend mountPrefix()');
}

function collect(stack: Layer[], prefix: string, out: Set<string>) {
  for (const l of stack) {
    if (l.route) {
      for (const method of Object.keys(l.route.methods)) out.add(`${method.toUpperCase()} ${prefix}${l.route.path}`);
    } else if (l.handle?.stack) {
      collect(l.handle.stack, mountPrefix(l, prefix), out);
    }
  }
}

it('ROUTES (OpenAPI) matches the routes actually mounted by buildApp()', async () => {
  const db = await createDb({ pgliteDir: ':memory:' });
  try {
    const app = buildApp({ config: loadConfig({ NODE_ENV: 'test' }), db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });
    const mounted = new Set<string>();
    collect((app as unknown as { router: { stack: Layer[] } }).router.stack, '', mounted);
    for (const k of OUT_OF_CONTRACT) mounted.delete(k);

    const documented = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${API_PREFIX}${r.path}`));
    const missing = [...documented].filter((k) => !mounted.has(k)).sort(); // documentada, mas não montada
    const extra = [...mounted].filter((k) => !documented.has(k)).sort(); // montada, mas sem documentação
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  } finally {
    await db.close();
  }
}, 60000);
