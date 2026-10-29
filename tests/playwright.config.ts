import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const livre = () =>
  new Promise<number>((res, rej) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    }).on('error', rej);
  });

// Isolado dos servidores de dev: portas livres escolhidas na hora, .next proprio, storage temporario e PGlite em memoria.
// As escolhas vao para o ambiente (workers herdam; E2E_*_PORT/E2E_STORAGE fixam manualmente) e reuseExistingServer:false
// garante que nunca se testa contra um servidor alheio.
process.env.E2E_API_PORT ??= String(await livre());
process.env.E2E_WEB_PORT ??= String(await livre());
process.env.E2E_STORAGE ??= mkdtempSync(join(tmpdir(), 'docmind-e2e-'));
const API = Number(process.env.E2E_API_PORT);
const WEB = Number(process.env.E2E_WEB_PORT);
const storage = process.env.E2E_STORAGE;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: 0,
  workers: Number(process.env.E2E_WORKERS ?? 4), // API unica (PGlite + fila em memoria): paralelismo alto pode deixar a ingestao lenta
  use: { baseURL: `http://localhost:${WEB}`, trace: 'retain-on-failure' },
  // desktop e mobile (390x844), cada um nos temas claro e escuro (o tema segue prefers-color-scheme)
  projects: (['light', 'dark'] as const).flatMap((colorScheme) => [
    { name: `desktop-${colorScheme}`, use: { ...devices['Desktop Chrome'], colorScheme }, testIgnore: /(mobile|video-2min).spec.ts/ }, // video: so via playwright.video.config.ts
    {
      name: `mobile-${colorScheme}`,
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme },
      testMatch: /(mobile|demo-account|a11y).spec.ts/,
    },
  ]),
  webServer: [
    {
      command: 'pnpm --filter @docmind/api start',
      url: `http://localhost:${API}/api/v1/health`,
      env: {
        NODE_ENV: 'test',
        API_PORT: String(API),
        WEB_ORIGIN: `http://localhost:${WEB}`,
        PGLITE_DIR: ':memory:',
        STORAGE_DIR: storage,
        LLM_PROVIDER: 'local',
        REDIS_URL: '',
        DATABASE_URL: '',
        AUTH_RATE_LIMIT: '1000', // todos os testes compartilham o mesmo IP
        DEMO_LOGIN_ENABLED: 'true', // demo-account.spec.ts; com PGlite a API prepara a conta demo no boot
        DEMO_USER_EMAIL: 'demo@docmind.app',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @docmind/web exec next dev -p ${WEB}`,
      url: `http://localhost:${WEB}/login`,
      env: { API_URL: `http://localhost:${API}`, NEXT_DIST_DIR: '.next-e2e' },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
