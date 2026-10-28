'use client';
import type { Collection, Conversation } from '@docmind/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ChatIcon } from '../../../src/components/icons';
import { Button, Empty, PageHeader } from '../../../src/components/ui';
import { api } from '../../../src/features/chat/api';
import { ErrorAlert, LoadingLines } from '../../../src/features/chat/states';

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
/** "hoje", "ontem", "há 3 dias"...; acima de 30 dias, a data. */
function relative(iso: string) {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days > -30) return days === 0 ? 'hoje' : rtf.format(days, 'day');
  return new Date(iso).toLocaleDateString('pt-BR');
}

export default function ConversationsPage() {
  const [items, setItems] = useState<Conversation[]>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api.conversations().then(setItems).catch((e) => setError(e.message));
    api.collections().then((cs: Collection[]) => setNames(Object.fromEntries(cs.map((c) => [c.id, c.name])))).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const shown = items?.filter((c) => (c.title || 'Sem título').toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <section className="space-y-6">
      <PageHeader title="Conversas" subtitle="Retome qualquer conversa de onde parou." />
      <ErrorAlert>{error}</ErrorAlert>
      {error && <Button onClick={load}>Tentar de novo</Button>}
      {!items && !error && <LoadingLines rows={4} />}
      {items && items.length > 0 && (
        <input
          type="search"
          aria-label="Buscar conversas"
          placeholder="Buscar conversas…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-10 w-full rounded-xl border border-line-strong bg-surface px-4 text-sm placeholder:text-muted focus:border-brand"
        />
      )}
      {items?.length === 0 && (
        <Empty
          hint={
            <>
              <Link className="text-brand underline" href="/chat">Comece uma no chat</Link> e ela aparece aqui.
            </>
          }
        >
          Nenhuma conversa ainda.
        </Empty>
      )}
      {shown && items && items.length > 0 && shown.length === 0 && <p className="py-6 text-center text-sm text-muted">Nenhuma conversa encontrada.</p>}
      <ul className="space-y-2">
        {shown?.map((c) => (
          <li key={c.id}>
            <Link className="card card-hover flex items-center gap-3 px-4 py-3" href={`/chat?c=${c.id}`}>
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-tint text-brand">
                <ChatIcon size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.title || 'Sem título'}</span>
                <span className="block truncate text-xs text-muted">{c.collectionId ? (names[c.collectionId] ?? 'Coleção') : 'Todas as coleções'}</span>
              </span>
              <time dateTime={c.createdAt} className="shrink-0 text-xs text-muted">
                {relative(c.createdAt)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
