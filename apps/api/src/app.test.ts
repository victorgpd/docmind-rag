import request from 'supertest';
import { expect, it } from 'vitest';
import { loadConfig } from '@docmind/config';
import { createDb } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { buildApp } from './app';

it('GET /api/v1/health', async () => {
  const db = await createDb({ pgliteDir: ':memory:' });
  const app = buildApp({ config: loadConfig({ NODE_ENV: 'test' }), db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });
  const r = await request(app).get('/api/v1/health');
  expect(r.body).toMatchObject({ status: 'ok', db: 'pglite', llm: 'local' });
  await db.close();
}, 60000);
