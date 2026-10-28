import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Gravacao da demo (fora do gate: `pnpm --filter @docmind/tests demo`). Reaproveita os servidores isolados do E2E.
export default defineConfig({
  ...base,
  testDir: './demo',
  workers: 1,
  timeout: 180_000,
  outputDir: './test-results/demo',
  projects: [
    {
      name: 'demo',
      use: {
        baseURL: base.use?.baseURL,
        viewport: { width: 1280, height: 720 },
        video: { mode: 'on', size: { width: 1280, height: 720 } },
        colorScheme: 'light',
      },
    },
  ],
});
