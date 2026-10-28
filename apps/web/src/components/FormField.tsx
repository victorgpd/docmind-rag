import type { ReactNode } from 'react';

type ControlProps = { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string };

/**
 * Rotulo + controle + dica + erro, ligados por id/aria-describedby. Substitui o antd Form
 * (rc-field-form + async-validator, ~40 kB gzip) mantendo o visual dos controles antd.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: (control: ControlProps) => ReactNode;
}) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {hint && (
        <div id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </div>
      )}
      {error && (
        <div id={`${id}-error`} className="text-sm text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

/** Valida campos em ordem e devolve so os com erro: { campo: mensagem }. */
export function collectErrors(checks: [field: string, message: string | undefined][]) {
  const errors: Record<string, string> = {};
  for (const [field, message] of checks) if (message) errors[field] = message;
  return errors;
}
