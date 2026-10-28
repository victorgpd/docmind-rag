'use client';
import type { Citation } from '@docmind/shared';
import { useEffect, useRef, useState } from 'react';
import { FileIcon } from '../../components/icons';
import { api } from './api';
import { CrossIcon } from './icons';

/** Cartão lateral da fonte. Recebe o foco ao abrir; Esc ou Fechar o dispensam (o pai devolve o foco). */
export function CitationPanel({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const [filename, setFilename] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [citation]);
  useEffect(() => {
    setFilename(undefined);
    api.document(citation.documentId).then((d) => setFilename(d.filename)).catch(() => setFilename('Documento indisponível'));
  }, [citation.documentId]);
  return (
    <aside
      aria-label="Fonte da citação"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="card fixed inset-x-3 bottom-3 z-20 max-h-[60dvh] overflow-y-auto p-4 md:static md:z-auto md:ml-4 md:max-h-none md:w-72 md:shrink-0 md:self-start"
    >
      <div className="flex items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-tint text-brand">
          <FileIcon size={16} />
        </span>
        <h2 ref={heading} tabIndex={-1} className="min-w-0 flex-1 break-words pt-1 text-sm font-semibold">
          [{citation.n}] {filename ?? 'Carregando…'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted transition-colors duration-150 hover:bg-subtle hover:text-fg"
        >
          <CrossIcon size={14} /> Fechar
        </button>
      </div>
      <p className="mt-2 text-xs font-medium text-muted">{citation.page != null ? `Página ${citation.page}` : 'Página não informada'}</p>
      <blockquote className="mt-3 rounded-lg border-l-2 border-brand bg-tint px-3 py-2 text-sm leading-relaxed">{citation.snippet}</blockquote>
    </aside>
  );
}
