import { EventEmitter } from 'node:events';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { loadConfig } from '@docmind/config';
import { createDb, type DbHandle } from '@docmind/db';
import { createLLM } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { buildApp } from './app';
import { openSse } from './http/sse';

let db: DbHandle;
const build = (env: Record<string, string> = {}) =>
  buildApp({ config: loadConfig({ NODE_ENV: 'test', AUTH_RATE_LIMIT: '2', ...env }), db, llm: createLLM(), queue: createQueue(), storage: createStorage({ dir: './data/test' }) });

beforeAll(async () => {
  db = await createDb({ pgliteDir: ':memory:' });
  await db.migrate();
}, 60000);
afterAll(() => db.close());

let seq = 0; // e-mail distinto por tentativa: o limite por IP+e-mail (metade do limite) nao mascara o limite por IP
const login = (app: ReturnType<typeof build>, headers: Record<string, string>, n = 1) =>
  Promise.all(Array.from({ length: n }, (_, i) => request(app).post('/api/v1/auth/login').set(headers).send({ email: `d${seq++}-${i}@x.com`, password: 'errada-123' }))).then((r) => r.map((x) => x.status).sort());

// supertest conecta de loopback = o "web" (salto 1); o X-Forwarded-For simula o que o Next entrega: "<cliente>, <cloudflared>"
const chain = (...ips: string[]) => ({ 'X-Forwarded-For': ips.join(', ') });

it('TRUST_PROXY=2 (Cloudflare -> cloudflared -> web -> api): limite por cliente real, nao global, e forjar X-Forwarded-For nao escapa', async () => {
  const app = build({ TRUST_PROXY: '2' });
  // a Cloudflare ANEXA o IP real a um XFF forjado: "forjado, real" -> web acrescenta cloudflared
  expect(await login(app, chain('203.0.113.1', '172.18.0.5'), 3)).toEqual([401, 401, 429]);
  expect(await login(app, chain('198.51.100.2', '172.18.0.5'))).toEqual([401]); // outro cliente, mesmo cloudflared: nao e bloqueado
  expect(await login(app, chain('6.6.6.6', '203.0.113.1', '172.18.0.5'))).toEqual([429]); // forja a esquerda nao troca o balde
});

it('TRUST_PROXY por CIDR da rede privada: mesmo resultado sem depender do numero de saltos', async () => {
  const app = build({ TRUST_PROXY: 'loopback, uniquelocal' });
  expect(await login(app, chain('203.0.113.1', '172.18.0.5'), 3)).toEqual([401, 401, 429]);
  expect(await login(app, chain('198.51.100.2', '172.18.0.5'))).toEqual([401]);
  expect(await login(app, chain('6.6.6.6', '203.0.113.1', '172.18.0.5'))).toEqual([429]);
});

it('CLIENT_IP_HEADER: usa cf-connecting-ip so quando o salto direto e confiavel', async () => {
  const trusted = build({ TRUST_PROXY: 'loopback', CLIENT_IP_HEADER: 'CF-Connecting-IP' });
  const cf = (ip: string) => ({ 'CF-Connecting-IP': ip, 'X-Forwarded-For': '9.9.9.9' });
  expect(await login(trusted, cf('203.0.113.1'), 3)).toEqual([401, 401, 429]);
  expect(await login(trusted, cf('198.51.100.2'))).toEqual([401]);
  expect(await login(trusted, { 'CF-Connecting-IP': 'lixo' })).toEqual([401]); // valor invalido cai no IP da conexao

  // salto direto fora do CIDR confiavel (exposto na internet): o header e ignorado, todos caem no IP da conexao
  const untrusted = build({ TRUST_PROXY: '10.0.0.0/8', CLIENT_IP_HEADER: 'cf-connecting-ip' });
  expect(await login(untrusted, cf('203.0.113.1'))).toEqual([401]);
  expect(await login(untrusted, cf('203.0.113.2'))).toEqual([401]);
  expect(await login(untrusted, cf('203.0.113.3'))).toEqual([429]);
});

it('CLIENT_IP_HEADER exige TRUST_PROXY com CIDRs ou saltos', () => {
  expect(() => build({ CLIENT_IP_HEADER: 'cf-connecting-ip' })).toThrow(/TRUST_PROXY/);
  expect(() => build({ CLIENT_IP_HEADER: 'cf-connecting-ip', TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
});

it('cookie de refresh em producao atras de TLS externo: Secure, HttpOnly, SameSite=Lax, path /api/v1/auth, sem Domain', async () => {
  const app = build({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), TRUST_PROXY: '2', CORS_ORIGINS: 'https://docmind.example.com' });
  // o Next entrega x-forwarded-proto "https,http" (http-proxy acrescenta o proprio salto)
  const proxied = { ...chain('203.0.113.1', '172.18.0.5'), 'X-Forwarded-Proto': 'https,http', 'X-Forwarded-Host': 'docmind.example.com' };
  const body = { email: 'tls@x.com', password: 'senha-forte-1', name: 'T', organizationName: 'T' };
  const reg = await request(app).post('/api/v1/auth/register').set(proxied).send(body);
  expect(reg.status).toBe(201);
  const set = (reg.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!;
  expect(set).toMatch(/; Path=\/api\/v1\/auth/);
  expect(set).toMatch(/; HttpOnly/);
  expect(set).toMatch(/; Secure/);
  expect(set).toMatch(/; SameSite=Lax/);
  expect(set).not.toMatch(/Domain=/i);
  // logout limpa com os mesmos atributos (senao o navegador nao remove o cookie)
  const out = await request(app).post('/api/v1/auth/logout').set(proxied).set('Cookie', set.split(';')[0]!);
  const cleared = (out.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!;
  expect(cleared).toMatch(/Path=\/api\/v1\/auth.*HttpOnly.*Secure.*SameSite=Lax|Path=\/api\/v1\/auth/);
  expect(cleared).toMatch(/Secure/);
  // CORS coerente com o hostname publico; helmet manda HSTS (o TLS e do tunel, o navegador so ve https)
  const cors = await request(app).get('/api/v1/health').set('Origin', 'https://docmind.example.com');
  expect(cors.headers['access-control-allow-origin']).toBe('https://docmind.example.com');
  expect(cors.headers['access-control-allow-credentials']).toBe('true');
  expect((await request(app).get('/api/v1/health').set('Origin', 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
});

it('rewrite do Next so alcanca /api/v1/*: /ready some quando proxied, /metrics nao existe sob /api/v1', async () => {
  const app = build({ TRUST_PROXY: '2' });
  expect((await request(app).get('/api/v1/ready')).status).toBe(200); // sonda interna do compose (sem XFF)
  expect((await request(app).get('/api/v1/ready').set(chain('203.0.113.1', '172.18.0.5'))).status).toBe(404); // via Next/tunel
  expect((await request(app).get('/api/v1/metrics').set(chain('203.0.113.1', '172.18.0.5'))).status).toBe(404);
  expect((await request(app).get('/metrics').set(chain('203.0.113.1', '172.18.0.5'))).status).toBe(403); // e /metrics barra o cliente externo
});

it('SSE: headers anti-buffering/transform e heartbeat em comentario ate o fim ou a desconexao', () => {
  vi.useFakeTimers();
  try {
    const mk = () => {
      const res = Object.assign(new EventEmitter(), {
        headers: {} as Record<string, string>,
        writableEnded: false,
        destroyed: false,
        written: [] as string[],
        status() { return res; },
        set(h: Record<string, string>) { Object.assign(res.headers, h); return res; },
        flushHeaders() {},
        write(s: string) { res.written.push(s); return true; },
        end() { res.writableEnded = true; res.emit('close'); },
      });
      return res;
    };
    const pings = (r: ReturnType<typeof mk>) => r.written.filter((w) => w === ': ping\n\n').length;

    const a = mk();
    const s = openSse(a as unknown as Response, 15_000);
    expect(a.headers['cache-control']).toContain('no-transform');
    expect(a.headers['x-accel-buffering']).toBe('no');
    vi.advanceTimersByTime(14_999);
    expect(pings(a)).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pings(a)).toBe(1);
    s.send('tick', { i: 1 });
    vi.advanceTimersByTime(45_000);
    expect(pings(a)).toBe(4); // < 100 s entre escritas: o tunel nao derruba
    expect(a.written).toContain('event: tick\ndata: {"i":1}\n\n');
    s.end();
    vi.advanceTimersByTime(60_000);
    expect(pings(a)).toBe(4); // depois do fim, nada mais e escrito

    const b = mk();
    openSse(b as unknown as Response, 15_000);
    b.destroyed = true;
    b.emit('close'); // cliente foi embora
    vi.advanceTimersByTime(60_000);
    expect(pings(b)).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // nenhum timer vazado
  } finally {
    vi.useRealTimers();
  }
});
