import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRateLimiter, memoryLimiter, rateLimit, validateUpload } from './index.js';

const bytes = (...s: (string | number[])[]) =>
  new Uint8Array(s.flatMap((x) => (typeof x === 'string' ? [...Buffer.from(x, 'latin1')] : x)));
const opts = { maxBytes: 1000 };
const file = (filename: string, head: Uint8Array, size = head.length) => ({ filename, size, head });

describe('validateUpload', () => {
  it('aceita pdf, docx, txt e md pelo conteudo', () => {
    expect(validateUpload(file('a.pdf', bytes('%PDF-1.7\n')), opts)).toEqual({ ok: true, kind: 'pdf' });
    expect(validateUpload(file('a.docx', bytes([0x50, 0x4b, 3, 4], '....word/document.xml')), opts)).toEqual({ ok: true, kind: 'docx' });
    expect(validateUpload(file('a.txt', new TextEncoder().encode('olá mundo')), opts)).toEqual({ ok: true, kind: 'txt' });
    expect(validateUpload(file('a.md', new TextEncoder().encode('# olá')), opts)).toEqual({ ok: true, kind: 'md' });
  });

  it('rejeita extensao que mente, binario, zip generico, vazio e grande', () => {
    expect(validateUpload(file('a.pdf', bytes([0x4d, 0x5a, 0, 0])), opts).ok).toBe(false); // exe
    expect(validateUpload(file('a.txt', bytes('%PDF-1.7')), opts).ok).toBe(false); // pdf como txt
    expect(validateUpload(file('a.docx', bytes([0x50, 0x4b, 3, 4], 'xl/sheet.xml')), opts).ok).toBe(false);
    expect(validateUpload(file('a.exe', bytes('texto')), opts).ok).toBe(false);
    expect(validateUpload(file('a.txt', bytes('x'), 0), opts).ok).toBe(false);
    expect(validateUpload(file('a.txt', bytes('x'), 1001), opts)).toMatchObject({ ok: false });
  });
});

describe('rate limit', () => {
  it('memoryLimiter conta por janela e reinicia depois dela', async () => {
    let t = 0;
    const l = memoryLimiter(() => t);
    expect((await l.hit('k', 2, 1000)).allowed).toBe(true);
    expect((await l.hit('k', 2, 1000)).remaining).toBe(0);
    expect((await l.hit('k', 2, 1000)).allowed).toBe(false);
    t = 1000;
    expect((await l.hit('k', 2, 1000)).allowed).toBe(true);
  });

  it('createRateLimiter sem REDIS_URL usa memoria', async () => {
    expect((await createRateLimiter().hit('x', 1, 1000)).allowed).toBe(true);
  });

  it('middleware responde 429 por usuario e por org', async () => {
    const app = express();
    app.use(
      rateLimit({
        limiter: memoryLimiter(),
        identify: (req) => ({ userId: req.get('x-user'), orgId: 'org1' }),
        user: { limit: 2, windowMs: 60_000 },
        org: { limit: 3, windowMs: 60_000 },
      }),
    );
    app.get('/x', (_req, res) => void res.send('ok'));
    const get = (u: string) => request(app).get('/x').set('x-user', u);
    expect((await get('a')).status).toBe(200);
    expect((await get('a')).status).toBe(200);
    const blocked = await get('a');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.error.code).toBe('rate_limited');
    expect((await get('b')).status).toBe(200); // b ainda tem cota propria...
    expect((await get('c')).status).toBe(429); // ...mas a org1 estourou (4a chamada contando a bloqueada de a)
  });
});
