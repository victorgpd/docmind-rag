'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Document } from '@docmind/shared';
import { api, errorMessage } from './api';

export type DocPage = { items: Document[]; nextCursor: string | null };

/**
 * Atualiza a lista com um documento vindo do SSE ou de uma acao local.
 * Item ja carregado: so troca. Item novo: entra no topo, EXCETO se for mais antigo que o ultimo carregado
 * e ainda houver paginas (o SSE reenvia a colecao inteira ao conectar; esses entram via "Carregar mais").
 */
const RANK: Record<Document['status'], number> = { pending: 0, processing: 1, ready: 2, failed: 2 };

/**
 * Resposta de uma acao local (upload, /process) descreve o documento no instante da chamada. Se o SSE ja trouxe um
 * estado mais adiantado (ingestao de arquivo pequeno leva ~100 ms e a resposta pode demorar mais que isso sob carga),
 * a resposta e velha: nao regride. `failed` fica de fora porque reprocessar volta legitimamente para `pending`.
 */
const isStale = (current: Document, incoming: Document) =>
  current.status !== 'failed' && RANK[current.status] > RANK[incoming.status];

export function upsertDoc(page: DocPage, d: Document, opts: { keepNewer?: boolean } = {}): DocPage {
  const current = page.items.find((x) => x.id === d.id);
  if (current) {
    if (opts.keepNewer && isStale(current, d)) return page;
    return { ...page, items: page.items.map((x) => (x.id === d.id ? d : x)) };
  }
  const oldest = page.items.at(-1);
  if (page.nextCursor && oldest && d.createdAt <= oldest.createdAt) return page;
  return { ...page, items: [d, ...page.items] };
}

/** Acrescenta uma pagina ao fim, sem duplicar o que o SSE ja trouxe. */
export const appendPage = (page: DocPage, next: DocPage): DocPage => ({
  items: [...page.items, ...next.items.filter((n) => !page.items.some((x) => x.id === n.id))],
  nextCursor: next.nextCursor,
});

/** Primeira pagina chegou depois de eventos do SSE: junta, sem trazer itens de paginas ainda nao carregadas. */
export function mergeFirstPage(first: DocPage, live: DocPage): DocPage {
  const oldest = first.items.at(-1);
  const extra = live.items.filter(
    (d) =>
      !first.items.some((x) => x.id === d.id) &&
      (!first.nextCursor || !oldest || d.createdAt > oldest.createdAt),
  );
  const items = [...first.items, ...extra].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  return { items, nextCursor: first.nextCursor };
}

/** Lista paginada de documentos da colecao, mantida ao vivo pelo SSE (reconecta com backoff). */
export function useDocuments(collectionId: string) {
  const [page, setPage] = useState<DocPage | null>(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setPage(null);
    api
      .listDocuments(collectionId)
      .then((p) => !ctrl.signal.aborted && setPage((cur) => (cur ? mergeFirstPage(p, cur) : p)))
      .catch((e) => setError(errorMessage(e)));

    (async () => {
      let delay = 1000;
      while (!ctrl.signal.aborted) {
        try {
          await api.streamDocuments(
            collectionId,
            (d) => setPage((p) => upsertDoc(p ?? { items: [], nextCursor: null }, d)),
            ctrl.signal,
          );
          delay = 1000;
        } catch {
          if (ctrl.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15000);
      }
    })();

    return () => ctrl.abort();
  }, [collectionId]);

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.listDocuments(collectionId, cursor);
      setPage((p) => (p ? appendPage(p, next) : next));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [collectionId, page?.nextCursor, loadingMore]);

  const add = useCallback(
    (d: Document) => setPage((p) => upsertDoc(p ?? { items: [], nextCursor: null }, d, { keepNewer: true })),
    [],
  );
  const remove = useCallback(
    (id: string) => setPage((p) => (p ? { ...p, items: p.items.filter((d) => d.id !== id) } : p)),
    [],
  );
  return {
    documents: page?.items ?? null,
    hasMore: !!page?.nextCursor,
    loadingMore,
    loadMore,
    error,
    add,
    remove,
  };
}
