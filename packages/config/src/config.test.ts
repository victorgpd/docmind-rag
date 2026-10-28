import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { findRepoRoot, loadConfig, redactConfig } from './index';

it('defaults the ollama embed model to a 384d one and treats empty strings as unset', () => {
  const c = loadConfig({ OLLAMA_EMBED_MODEL: '', LLM_PROVIDER: '' });
  expect(c.OLLAMA_EMBED_MODEL).toBe('all-minilm');
  expect(c.LLM_PROVIDER).toBe('local');
});

it('has usage limit/price defaults and coerces env strings', () => {
  expect(loadConfig({})).toMatchObject({ MONTHLY_TOKEN_LIMIT: 10_000_000, USAGE_PRICE_IN_PER_1M: 0, USAGE_PRICE_OUT_PER_1M: 0 });
  expect(loadConfig({ MONTHLY_TOKEN_LIMIT: '200', USAGE_PRICE_IN_PER_1M: '1.5' })).toMatchObject({
    MONTHLY_TOKEN_LIMIT: 200,
    USAGE_PRICE_IN_PER_1M: 1.5,
  });
});

it('cost guards: global cap and registration switches', () => {
  expect(loadConfig({})).toMatchObject({ GLOBAL_MONTHLY_TOKEN_LIMIT: 2_000_000, REGISTRATION_ENABLED: true });
  expect(loadConfig({}).REGISTRATION_LIMIT_PER_IP_PER_DAY).toBeUndefined(); // a API resolve: 5, ou 0 em NODE_ENV=test
  expect(loadConfig({ GLOBAL_MONTHLY_TOKEN_LIMIT: '0', REGISTRATION_LIMIT_PER_IP_PER_DAY: '0', REGISTRATION_ENABLED: 'false' })).toMatchObject({
    GLOBAL_MONTHLY_TOKEN_LIMIT: 0,
    REGISTRATION_LIMIT_PER_IP_PER_DAY: 0,
    REGISTRATION_ENABLED: false,
  });
  expect(() => loadConfig({ REGISTRATION_ENABLED: 'no' })).toThrow();
});

it('demo login: off by default, needs DEMO_USER_EMAIL when on, email lowercased', () => {
  expect(loadConfig({}).DEMO_LOGIN_ENABLED).toBe(false);
  expect(loadConfig({}).DEMO_USER_EMAIL).toBeUndefined();
  expect(() => loadConfig({ DEMO_LOGIN_ENABLED: 'true' })).toThrow(/DEMO_USER_EMAIL/);
  expect(() => loadConfig({ DEMO_LOGIN_ENABLED: 'yes', DEMO_USER_EMAIL: 'demo@docmind.app' })).toThrow();
  expect(() => loadConfig({ DEMO_LOGIN_ENABLED: 'true', DEMO_USER_EMAIL: 'nao-e-email' })).toThrow();
  expect(loadConfig({ DEMO_LOGIN_ENABLED: 'true', DEMO_USER_EMAIL: 'Demo@DocMind.app' })).toMatchObject({ DEMO_LOGIN_ENABLED: true, DEMO_USER_EMAIL: 'demo@docmind.app' });
});

it('has calibrated RAG defaults, coerces env strings and validates ranges', () => {
  expect(loadConfig({})).toMatchObject({ RAG_MIN_RELEVANCE: 0.17, RAG_W_RERANK: 0.8, RAG_W_SIM: 0.1, RAG_W_RRF: 0.1, RAG_TOP_K: 6 });
  expect(loadConfig({ RAG_MIN_RELEVANCE: '0', RAG_TOP_K: '8' })).toMatchObject({ RAG_MIN_RELEVANCE: 0, RAG_TOP_K: 8 });
  expect(() => loadConfig({ RAG_MIN_RELEVANCE: '2' })).toThrow();
  expect(() => loadConfig({ RAG_W_SIM: '-1' })).toThrow();
  expect(() => loadConfig({ RAG_TOP_K: '2.5' })).toThrow();
});

it('openai: key is required, validated and redacted', () => {
  expect(() => loadConfig({ LLM_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
  expect(() => loadConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: '' })).toThrow(/OPENAI_API_KEY/);
  expect(() => loadConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-a b' })).toThrow(/spaces/);
  const c = loadConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-123456' });
  expect(c).toMatchObject({ OPENAI_EMBED_MODEL: 'text-embedding-3-small', OPENAI_CHAT_MODEL: 'gpt-4o-mini', OPENAI_BASE_URL: 'https://api.openai.com/v1' });
  expect(JSON.stringify(redactConfig(c))).not.toContain('sk-test-123456');
  expect(redactConfig(c).OPENAI_API_KEY).toBe('[set]');
  expect(loadConfig({}).OPENAI_API_KEY).toBeUndefined(); // padrão local: sem chave
});

it('ollama needs OLLAMA_URL at boot', () => {
  expect(() => loadConfig({ LLM_PROVIDER: 'ollama' })).toThrow(/OLLAMA_URL/);
});

it('resolves relative PGLITE_DIR/STORAGE_DIR against the repo root, keeping absolute and :memory:', () => {
  const root = findRepoRoot();
  expect(existsSync(resolve(root, 'pnpm-workspace.yaml'))).toBe(true);
  const c = loadConfig({});
  expect(c.PGLITE_DIR).toBe(resolve(root, 'data/pglite'));
  expect(c.STORAGE_DIR).toBe(resolve(root, 'data/storage'));
  const abs = resolve(root, '..', 'x');
  expect(loadConfig({ PGLITE_DIR: abs, STORAGE_DIR: abs })).toMatchObject({ PGLITE_DIR: abs, STORAGE_DIR: abs });
  expect(loadConfig({ PGLITE_DIR: ':memory:' }).PGLITE_DIR).toBe(':memory:');
});
