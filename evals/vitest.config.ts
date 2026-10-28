import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`../packages/${p}/src/index.ts`, import.meta.url));

// evals/ fica fora do pnpm-workspace: resolve @docmind/* direto do codigo-fonte (igual ao paths do tsconfig).
export default defineConfig({
  resolve: { alias: { '@docmind/db': src('db'), '@docmind/llm': src('llm'), '@docmind/ingest': src('ingest'), '@docmind/retrieval': src('retrieval'), '@docmind/agent': src('agent') } },
  test: { testTimeout: 120_000, include: ['src/**/*.test.ts'] },
});
