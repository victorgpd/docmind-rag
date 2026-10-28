import { defineConfig } from 'vitest/config';

// PGlite (WASM) + 7 migrations + RLS leva ~1-3 s por banco; sob carga (verify em paralelo) ja passou de 17 s.
// 60 s cobre isso com folga e ainda derruba um travamento real.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
