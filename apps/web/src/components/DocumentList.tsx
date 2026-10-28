import type { Document } from '@docmind/shared';
import { TrashIcon } from './icons';
import { StatusBadge } from './StatusBadge';
import { Button, Empty } from './ui';

const size = (b: number) =>
  b < 1024 * 1024
    ? `${Math.max(1, Math.round(b / 1024))} KB`
    : `${(b / 1024 / 1024).toFixed(1)} MB`;

const extension = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'DOC');

type Props = {
  documents: Document[];
  onDelete: (d: Document) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Exclusao desabilitada (ex.: conta de demonstracao); o texto vira o tooltip. */
  disabledReason?: string;
};

export function DocumentList({ documents, onDelete, hasMore, loadingMore, onLoadMore, disabledReason }: Props) {
  if (!documents.length) return <Empty hint="Envie arquivos ou importe por URL para começar.">Nenhum documento ainda.</Empty>;
  return (
    <>
      <ul className="card divide-y divide-line overflow-hidden">
        {documents.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-tint text-[11px] font-semibold tracking-wide text-brand">
              {extension(d.filename)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{d.filename}</p>
              <p className="text-xs text-muted tabular-nums">
                {size(d.sizeBytes)} · {new Date(d.createdAt).toLocaleDateString('pt-BR')}
              </p>
              {d.status === 'failed' && d.error && <p className="text-xs text-danger">{d.error}</p>}
              {(d.status === 'pending' || d.status === 'processing') && (
                <div aria-hidden className="mt-1.5 h-1 w-28 overflow-hidden rounded-full bg-subtle">
                  <div className={`bg-grad h-full rounded-full ${d.status === 'processing' ? 'w-2/3 animate-pulse' : 'w-1/6'}`} />
                </div>
              )}
            </div>
            <StatusBadge status={d.status} />
            <button
              type="button"
              onClick={() => onDelete(d)}
              aria-label={`Excluir ${d.filename}`}
              disabled={!!disabledReason}
              title={disabledReason}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-subtle hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
            >
              <TrashIcon size={16} />
            </button>
          </li>
        ))}
      </ul>
      {hasMore && onLoadMore && (
        <div>
          <Button onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Carregando…' : 'Carregar mais'}
          </Button>
        </div>
      )}
    </>
  );
}
