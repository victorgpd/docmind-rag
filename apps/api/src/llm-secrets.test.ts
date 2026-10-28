import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '@docmind/config';
import { createDb, type DbHandle } from '@docmind/db';
import { createLLMFromConfig } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { buildApp } from './app';

const KEY = 'sk-test-SECRET';
let db: DbHandle;
let fake: http.Server;
const seen: { path: string; auth?: string }[] = [];
let logs = '';

beforeAll(async () => {
  // "OpenAI" local que recusa a chave e, como a real, a repete na mensagem de erro
  fake = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: req.headers.authorization });
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`, type: 'invalid_request_error', code: 'invalid_api_key' } }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
}, 60000);
afterAll(async () => {
  await db.close();
  fake.close();
});

it('a chave do provider openai nao aparece em respostas, SSE, erros nem logs (inclusive no 401 do provider)', async () => {
  const config = loadConfig({
    NODE_ENV: 'production', // logs ligados (info) e demais protecoes de producao
    JWT_SECRET: 'x'.repeat(40),
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
  });
  const llm = createLLMFromConfig(config);
  const app = buildApp({ config, db, llm, queue: createQueue(), storage: createStorage({ dir: './data/test' }), logStream: { write: (m) => void (logs += m) } });

  const bodies: string[] = [];
  const keep = (r: request.Response) => (bodies.push(`${r.status} ${JSON.stringify(r.headers)} ${r.text}`), r);

  const reg = keep(await request(app).post('/api/v1/auth/register').send({ email: 'k@x.com', password: 'senha-forte-1', name: 'K', organizationName: 'K' }));
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  const col = keep(await request(app).post('/api/v1/collections').set(auth).send({ name: 'c' }));
  const conv = keep(await request(app).post('/api/v1/conversations').set(auth).send({ collectionId: col.body.id }));
  expect(conv.status).toBe(201);

  // pergunta: o provider recebe a chave, responde 401 com a chave no corpo, e nada disso chega ao cliente
  const chat = keep(await request(app).post(`/api/v1/conversations/${conv.body.id}/messages`).set(auth).send({ content: 'Qual o prazo de ferias?' }));
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true); // o provider usou a chave (o teste nao e vazio)
  expect(chat.text).toContain('event: error');
  expect(chat.text).toContain('Falha ao gerar a resposta.');

  keep(await request(app).post('/api/v1/auth/login').send({ email: 'k@x.com', password: 'errada-123' }));
  keep(await request(app).get('/api/v1/health'));
  keep(await request(app).get('/api/v1/ready'));
  keep(await request(app).get('/metrics'));
  keep(await request(app).get('/api/v1/openapi.json'));
  keep(await request(app).get('/api/v1/usage').set(auth));
  keep(await request(app).get('/api/v1/rota-inexistente'));

  await new Promise((r) => setTimeout(r, 100)); // logs assincronos
  expect(logs).toContain('chat stream failed'); // o erro foi logado...
  for (const [where, text] of [['respostas', bodies.join('\n')], ['logs', logs], ['redactConfig', JSON.stringify(redactConfig(config))]] as const)
    expect(text, where).not.toContain(KEY);
  expect(JSON.stringify(redactConfig(config))).toContain('[set]');
});

it('boot via createLLMFromConfig: local por padrao; openai so com chave e sem rede para subir', async () => {
  const mk = (env: Record<string, string>) => {
    const config = loadConfig({ NODE_ENV: 'test', ...env });
    return buildApp({ config, db, llm: createLLMFromConfig(config), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });
  };
  const local = await request(mk({})).get('/api/v1/health');
  expect(local.body.llm).toBe('local');

  const openai = await request(mk({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: KEY })).get('/api/v1/health'); // nenhuma chamada de rede no boot
  expect(openai.status).toBe(200);
  expect(openai.body.llm).toMatch(/openai/);
  expect(JSON.stringify(openai.body)).not.toContain(KEY);

  expect(() => loadConfig({ NODE_ENV: 'test', LLM_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/); // sem chave nao sobe
});
