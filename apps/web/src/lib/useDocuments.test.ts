import { describe, expect, it } from 'vitest';
import type { Document } from '@docmind/shared';
import { appendPage, mergeFirstPage, upsertDoc, type DocPage } from './useDocuments';

const doc = (n: number, extra: Partial<Document> = {}): Document => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  organizationId: '00000000-0000-4000-8000-0000000000aa',
  collectionId: '00000000-0000-4000-8000-0000000000bb',
  filename: `d${n}.txt`,
  mimeType: 'text/plain',
  sizeBytes: 1,
  storageKey: 'k',
  status: 'pending',
  error: null,
  pageCount: null,
  createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(), // n maior = mais novo
  ...extra,
});
const ids = (p: DocPage) => p.items.map((d) => d.filename);

describe('upsertDoc', () => {
  it('troca o item ja carregado sem mudar a ordem', () => {
    const page: DocPage = { items: [doc(3), doc(2)], nextCursor: 'c' };
    const out = upsertDoc(page, doc(2, { status: 'ready' }));
    expect(ids(out)).toEqual(['d3.txt', 'd2.txt']);
    expect(out.items[1]!.status).toBe('ready');
  });

  it('keepNewer: resposta velha de uma acao local nao regride o estado que o SSE ja trouxe', () => {
    const page: DocPage = { items: [doc(2, { status: 'ready', pageCount: 1 })], nextCursor: null };
    expect(upsertDoc(page, doc(2, { status: 'pending' }), { keepNewer: true })).toBe(page);
    const processing: DocPage = { items: [doc(2, { status: 'processing' })], nextCursor: null };
    expect(upsertDoc(processing, doc(2, { status: 'pending' }), { keepNewer: true })).toBe(processing);
  });

  it('keepNewer: avanca normalmente e reprocessar um failed volta para pending', () => {
    const pending: DocPage = { items: [doc(2)], nextCursor: null };
    expect(upsertDoc(pending, doc(2, { status: 'ready' }), { keepNewer: true }).items[0]!.status).toBe('ready');
    const failed: DocPage = { items: [doc(2, { status: 'failed', error: 'x' })], nextCursor: null };
    expect(upsertDoc(failed, doc(2, { status: 'pending' }), { keepNewer: true }).items[0]!.status).toBe('pending');
  });

  it('sem keepNewer (SSE), o estado recebido sempre vence', () => {
    const page: DocPage = { items: [doc(2, { status: 'ready' })], nextCursor: null };
    expect(upsertDoc(page, doc(2, { status: 'pending' })).items[0]!.status).toBe('pending');
  });

  it('documento novo entra no topo', () => {
    expect(ids(upsertDoc({ items: [doc(3), doc(2)], nextCursor: 'c' }, doc(9)))).toEqual([
      'd9.txt',
      'd3.txt',
      'd2.txt',
    ]);
  });

  it('com mais paginas, ignora item mais antigo que o ultimo carregado (snapshot do SSE)', () => {
    const page: DocPage = { items: [doc(3), doc(2)], nextCursor: 'c' };
    expect(upsertDoc(page, doc(1))).toBe(page);
  });

  it('na ultima pagina, aceita qualquer item novo', () => {
    expect(ids(upsertDoc({ items: [doc(3)], nextCursor: null }, doc(1)))).toEqual([
      'd1.txt',
      'd3.txt',
    ]);
  });
});

describe('appendPage / mergeFirstPage', () => {
  it('appendPage nao duplica o que o SSE ja trouxe e adota o novo cursor', () => {
    const out = appendPage(
      { items: [doc(3), doc(2)], nextCursor: 'a' },
      { items: [doc(2), doc(1)], nextCursor: null },
    );
    expect(ids(out)).toEqual(['d3.txt', 'd2.txt', 'd1.txt']);
    expect(out.nextCursor).toBeNull();
  });

  it('mergeFirstPage: primeira pagina chega depois do SSE, mantem cursor e descarta paginas nao carregadas', () => {
    const first: DocPage = { items: [doc(5), doc(4)], nextCursor: 'c' };
    const live: DocPage = {
      items: [doc(9), doc(4, { status: 'ready' }), doc(2)],
      nextCursor: null,
    }; // 9 e novo; 2 e de outra pagina
    const out = mergeFirstPage(first, live);
    expect(ids(out)).toEqual(['d9.txt', 'd5.txt', 'd4.txt']);
    expect(out.nextCursor).toBe('c');
  });
});
