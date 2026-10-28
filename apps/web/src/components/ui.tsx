'use client';

import { useCallback, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

// Controles nativos com os tokens do tema (raio 8, altura 36, foco global em globals.css): zero JS de biblioteca.
// O antd so entra, sob demanda, nas sobreposicoes (Modal/Drawer): ver ThemedModal/ThemedDrawer.

const buttonBase =
  'inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition duration-150 disabled:cursor-not-allowed disabled:opacity-60';
const variants = {
  primary: 'bg-grad text-primary-fg hover:brightness-110',
  default: 'border border-line-strong bg-surface text-fg hover:bg-subtle',
  text: 'text-fg hover:bg-subtle',
  danger: 'border border-danger text-danger hover:bg-subtle',
};

export function Button({
  variant = 'default',
  block,
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants; block?: boolean }) {
  return <button type={type} className={`${buttonBase} ${variants[variant]} ${block ? 'w-full' : ''} ${className}`} {...props} />;
}

export const controlClass =
  'h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-brand disabled:opacity-60';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${controlClass} ${className}`} {...props} />;
}

/** Carregando: linhas cinzas pulsando (animate-pulse e desligado por prefers-reduced-motion). */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">Carregando…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="shimmer h-4 rounded-md" style={{ width: `${95 - i * 15}%` }} />
      ))}
    </div>
  );
}

export function Empty({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <svg width="88" height="64" viewBox="0 0 88 64" fill="none" aria-hidden="true" focusable="false">
        <rect x="14" y="14" width="44" height="40" rx="8" className="fill-subtle stroke-line" strokeWidth="1.5" />
        <rect x="30" y="8" width="44" height="40" rx="8" className="fill-surface stroke-line-strong" strokeWidth="1.5" />
        <path d="M40 22h24M40 30h24M40 38h14" className="stroke-brand" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium">{children}</p>
      {hint && <p className="max-w-xs text-sm text-muted">{hint}</p>}
    </div>
  );
}

/** Cabeçalho de página: título 26px + subtítulo + ações à direita. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Aviso passageiro (3 s) em regiao viva: `notify` + `holder` (renderize o holder uma vez na tela). */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const holder = toast && (
    <div
      role={toast.error ? 'alert' : 'status'}
      className={`card fixed inset-x-0 top-4 z-50 mx-auto w-fit max-w-[90vw] px-4 py-2.5 text-sm shadow-[var(--shadow-lift)] ${toast.error ? '!border-danger text-danger' : 'text-fg'}`}
    >
      {toast.text}
    </div>
  );
  return [notify, holder] as const;
}
