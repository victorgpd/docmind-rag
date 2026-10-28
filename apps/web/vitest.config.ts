import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // globals: o cleanup automatico do Testing Library depende de afterEach global
  test: { environment: 'jsdom', globals: true, setupFiles: ['src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
});
