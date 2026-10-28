import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts', 'docs/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // PGlite sobe WASM por teste; arquivos em paralelo estouram memoria no CI
    fileParallelism: false,
  },
});
