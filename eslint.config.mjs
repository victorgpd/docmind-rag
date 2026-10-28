import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Node globals para scripts/configs .mjs/.js (sem dependir do pacote `globals`)
const nodeGlobals = Object.fromEntries(
  ['URL', 'URLSearchParams', 'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'fetch', 'AbortController', 'TextEncoder', 'TextDecoder', 'structuredClone', 'performance'].map((n) => [n, 'readonly']),
);

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/.next-*/**', '**/node_modules/**', '**/next-env.d.ts', '.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{mjs,cjs,js}'], languageOptions: { globals: nodeGlobals } },
  { rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
