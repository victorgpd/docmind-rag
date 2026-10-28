import type { ReactNode } from 'react';

// Estados nativos com os tokens v2 (E2E depende do role=status com "Carregando…").

export function ErrorAlert({ children }: { children: string }) {
  return children ? (
    <div role="alert" className="card border-danger px-3 py-2 text-sm text-danger">
      {children}
    </div>
  ) : null;
}

/** Carregando: texto para leitor de tela + linhas com shimmer (desligado por prefers-reduced-motion). */
export function LoadingLines({ rows = 3, label = 'Carregando…' }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="shimmer h-4 rounded-md" style={{ width: i === rows - 1 ? '60%' : '100%' }} />
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted">{children}</p>;
}
