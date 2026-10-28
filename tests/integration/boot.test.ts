import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// O vitest carrega os modulos pelo Vite; o processo real (tsx + main.ts) resolve dependencias diferente e ja quebrou no boot
// (ex.: zod misto). Este teste sobe o main.ts de verdade num processo filho.
const root = fileURLToPath(new URL('../../', import.meta.url));

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    }).on('error', rej);
  });

it('apps/api/src/main.ts sobe via tsx, responde /ready e serve /openapi.json', async () => {
  const port = await freePort();
  const storage = mkdtempSync(join(tmpdir(), 'docmind-boot-'));
  let out = '';
  const child = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/main.ts'], {
    cwd: join(root, 'apps/api'),
    env: { ...process.env, NODE_ENV: 'test', API_PORT: String(port), PGLITE_DIR: ':memory:', STORAGE_DIR: storage, REDIS_URL: '', DATABASE_URL: '', LLM_PROVIDER: 'local' },
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let exited: number | null | undefined;
  child.on('exit', (c) => (exited = c));

  try {
    const base = `http://127.0.0.1:${port}/api/v1`;
    let ready = false;
    for (let i = 0; i < 160 && exited === undefined && !ready; i++) {
      ready = await fetch(`${base}/ready`).then((r) => r.status === 200, () => false);
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    expect(exited, `processo encerrou no boot (codigo ${exited}):\n${out.slice(-2000)}`).toBeUndefined();
    expect(ready, `/ready nao respondeu 200:\n${out.slice(-2000)}`).toBe(true);

    const doc = await fetch(`${base}/openapi.json`);
    expect(doc.status).toBe(200);
    const spec = (await doc.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths ?? {})).toContain('/api/v1/auth/login');
  } finally {
    child.kill();
    await new Promise((r) => (exited !== undefined ? r(null) : child.once('exit', r)));
    rmSync(storage, { recursive: true, force: true });
  }
}, 120_000);
