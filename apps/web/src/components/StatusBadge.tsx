import type { DocumentStatus } from '@docmind/shared';

const LABEL: Record<DocumentStatus, { text: string; tone: string }> = {
  pending: { text: 'Na fila', tone: 'bg-subtle text-muted' },
  processing: { text: 'Processando', tone: 'bg-warn/15 text-warn' },
  ready: { text: 'Pronto', tone: 'bg-ok/15 text-ok' },
  failed: { text: 'Erro', tone: 'bg-danger/15 text-danger' },
};

/** Pill colorida suave: o texto comunica o estado (a cor so reforca); role=status anuncia mudancas vindas do SSE. */
export function StatusBadge({ status }: { status: DocumentStatus }) {
  const { text, tone } = LABEL[status];
  return (
    <span role="status" className={`inline-flex min-w-24 items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      {status === 'processing' && (
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" className="animate-spin" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-6.2-8.6" />
        </svg>
      )}
      {text}
    </span>
  );
}
