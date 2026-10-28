import { describe, expect, it } from 'vitest';
import { createSseParser, type SseMessage } from './sse';

describe('createSseParser', () => {
  it('junta chunks cortados, ignora comentarios e suporta CRLF', () => {
    const got: SseMessage[] = [];
    const feed = createSseParser((m) => got.push(m));
    feed(': ping\n\nevent: docu');
    feed('ment\r\ndata: {"a":1}\r\n');
    feed('\r\ndata: solto\n\n');
    expect(got).toEqual([
      { event: 'document', data: '{"a":1}' },
      { event: 'message', data: 'solto' },
    ]);
  });

  it('une multiplas linhas data com \\n', () => {
    const got: SseMessage[] = [];
    createSseParser((m) => got.push(m))('data: a\ndata: b\n\n');
    expect(got[0]?.data).toBe('a\nb');
  });
});
