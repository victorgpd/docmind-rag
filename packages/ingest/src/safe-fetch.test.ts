import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedIp, safeFetchText } from './safe-fetch';
import { PermanentError } from './types';

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '[::1]', 'fe80::1%eth0', 'nao-e-ip',
  ])('bloqueia %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('permite %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );
});

describe('safeFetchText: hosts maliciosos', () => {
  const bad = [
    'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/',
    'http://2130706433/', 'http://0x7f.1/', 'http://0/', 'http://10.0.0.1:8080/',
  ];
  it.each(bad)('rejeita %s como erro permanente', async (u) => {
    await expect(safeFetchText(u, { timeoutMs: 3000 })).rejects.toBeInstanceOf(PermanentError);
  });

  it.each(['file:///etc/passwd', 'ftp://exemplo.com/a', 'gopher://x/', 'javascript:alert(1)', 'nao e url', 'http://user:pw@exemplo.com/'])(
    'rejeita esquema/forma invalida %s',
    async (u) => {
      await expect(safeFetchText(u)).rejects.toBeInstanceOf(PermanentError);
    },
  );

  it('anti-rebinding: host publico que resolve para IP privado e barrado no lookup', async () => {
    const lookup = ((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => cb(null, [{ address: '10.0.0.5', family: 4 }])) as never;
    await expect(safeFetchText('http://evil.example/x', { lookup })).rejects.toBeInstanceOf(PermanentError);
  });

  it('um registro privado entre varios tambem barra', async () => {
    const lookup = ((_h: string, _o: unknown, cb: (...a: unknown[]) => void) =>
      cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }])) as never;
    await expect(safeFetchText('http://evil.example/x', { lookup })).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('safeFetchText: servidor local (loopback liberado so nos testes)', () => {
  let server: http.Server;
  let base: string;
  const allowLoop = (ip: string) => ip !== '127.0.0.1' && isBlockedIp(ip);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') return void res.end('olá mundo');
      if (req.url === '/to-meta') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      if (req.url === '/to-loop6') return void res.writeHead(302, { location: 'http://[::ffff:7f00:1]:1/' }).end();
      if (req.url === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
      if (req.url === '/hop') return void res.writeHead(302, { location: '/ok' }).end();
      if (req.url === '/big') return void res.end('x'.repeat(2000));
      if (req.url === '/chunked-big') {
        res.write('x'.repeat(600));
        return void setTimeout(() => res.end('y'.repeat(600)), 20);
      }
      if (req.url === '/slow') return; // nunca responde
      if (req.url === '/404') return void res.writeHead(404).end();
      if (req.url === '/503') return void res.writeHead(503).end();
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const get = (path: string, o: Parameters<typeof safeFetchText>[1] = {}) => safeFetchText(base + path, { isBlocked: allowLoop, ...o });

  it('baixa o corpo e segue redirect legitimo', async () => {
    expect(await get('/ok')).toBe('olá mundo');
    expect(await get('/hop')).toBe('olá mundo');
  });

  it('revalida cada salto: redirect para metadata ou loopback IPv6 mapeado e barrado', async () => {
    await expect(get('/to-meta')).rejects.toBeInstanceOf(PermanentError);
    await expect(get('/to-loop6')).rejects.toBeInstanceOf(PermanentError);
  });

  it('limita redirects (loop infinito)', async () => {
    await expect(get('/loop')).rejects.toThrow(/redirects demais/);
  });

  it('teto de tamanho: por content-length e por stream sem content-length', async () => {
    await expect(get('/big', { maxBytes: 1000 })).rejects.toBeInstanceOf(PermanentError);
    await expect(get('/chunked-big', { maxBytes: 1000 })).rejects.toBeInstanceOf(PermanentError);
  });

  it('timeout em servidor que nao responde e transitorio (retry permitido)', async () => {
    const err = await get('/slow', { timeoutMs: 150 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentError);
  });

  it('4xx e permanente, 5xx e transitorio', async () => {
    await expect(get('/404')).rejects.toBeInstanceOf(PermanentError);
    const e = await get('/503').catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(PermanentError);
  });
});
