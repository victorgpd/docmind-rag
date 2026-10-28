import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Video de ~2 min (fora do gate: `pnpm --filter @docmind/tests video`). Mesmo isolamento do E2E (portas livres, PGlite em
// memoria, storage temporario), mas na configuracao de producao: web com next build/start e API com NODE_ENV=production e
// LLM_PROVIDER=openai. A chave nunca passa por aqui: a propria API a le do .env (--env-file) so no ambiente do processo.
type Server = { command: string; url: string; env: Record<string, string>; timeout: number; reuseExistingServer: boolean };
const [api, web] = base.webServer as Server[];
const DIST = '.next-video';
// dados temporarios (uploads) e o build isolado somem ao fim; o banco ja era em memoria. So no processo principal:
// os workers tambem carregam este arquivo e sairiam antes de os servidores pararem.
if (!process.env.TEST_WORKER_INDEX) process.on('exit', () => {
  for (const dir of [process.env.E2E_STORAGE!, resolve(import.meta.dirname, '../apps/web', DIST)]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // Windows solta os arquivos com atraso
    } catch {
      // arquivo ainda preso pelo processo recem-encerrado (Windows): fica para o proximo build
    }
  }
});

export default defineConfig({
  ...base,
  testMatch: /video-2min\.spec\.ts/,
  workers: 1,
  timeout: 600_000,
  outputDir: './test-results/video',
  projects: [
    {
      name: 'video',
      use: {
        baseURL: base.use?.baseURL,
        viewport: { width: 1280, height: 720 },
        video: { mode: 'on', size: { width: 1280, height: 720 } },
        colorScheme: 'light',
      },
    },
  ],
  webServer: [
    {
      ...api!,
      env: {
        ...api!.env,
        NODE_ENV: 'production',
        LLM_PROVIDER: 'openai',
        // calibracao do ranking para a OpenAI (evals/results/openai-calibrated.md)
        RAG_MIN_RELEVANCE: '0.10',
        RAG_W_RERANK: '0.5',
        RAG_W_SIM: '0.4',
        RAG_W_RRF: '0.1',
        GLOBAL_MONTHLY_TOKEN_LIMIT: '0', // so neste processo local de gravacao
      },
    },
    {
      ...web!,
      command: `pnpm --filter @docmind/web exec next build && pnpm --filter @docmind/web exec next start -p ${process.env.E2E_WEB_PORT}`,
      env: { ...web!.env, NEXT_DIST_DIR: DIST },
      timeout: 600_000,
    },
  ],
});
