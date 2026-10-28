'use client';
import type { Citation } from '@docmind/shared';
import type { AgentStep, Table } from './api';
import { AssistantAvatar, CheckIcon, CrossIcon, ToolIcon, UserIcon } from './icons';

/** Linha do tempo do agente: um item por ferramenta, com estado (rodando, ok, falhou) e tempo. */
function Steps({ steps, intent }: { steps: AgentStep[]; intent?: string }) {
  return (
    <ol aria-label="Passos do agente" className="mb-3 space-y-1.5 border-l border-line pl-3 text-xs text-muted">
      {intent && <li className="font-medium text-fg">Plano: {intent}</li>}
      {steps.map((s) => (
        <li key={s.n} className="flex items-center gap-1.5">
          <span className={s.ok === false ? 'text-danger' : s.ok ? 'text-ok' : 'animate-pulse text-brand'}>
            {s.ok === false ? <CrossIcon size={13} /> : s.ok ? <CheckIcon size={13} /> : <ToolIcon size={13} />}
          </span>
          <span>
            Ferramenta <strong className="text-fg">{s.tool}</strong>
            {s.ok === undefined && ' …'}
            {s.ok === true && (s.ms === undefined ? ' · ok' : ` · ${s.ms} ms`)}
            {s.ok === false && <span className="text-danger"> · falhou{s.error ? `: ${s.error}` : ''}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function DataTable({ table }: { table: Table }) {
  return (
    <div role="region" aria-label="Tabela extraída" tabIndex={0} className="mt-3 overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-subtle">
          <tr>
            {table.headers.map((h, i) => (
              <th key={i} className="px-3 py-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2">{String(c ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Troca marcadores [n] por chips clicáveis (foco e teclado nativos) quando houver citação correspondente. */
export function MessageBubble({
  role,
  content,
  citations,
  steps = [],
  intent,
  table,
  reindex,
  pending = false,
  onCite,
  footer,
}: {
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations: Citation[];
  steps?: AgentStep[];
  intent?: string;
  table?: Table;
  reindex?: boolean;
  pending?: boolean;
  onCite: (c: Citation, opener: HTMLElement) => void;
  footer?: React.ReactNode;
}) {
  const parts = content.split(/(\[\d+\])/g);
  const mine = role === 'user';
  const text = (
    <p className="whitespace-pre-wrap leading-relaxed">
      {parts.map((p, i) => {
        const n = /^\[(\d+)\]$/.exec(p)?.[1];
        const c = n ? citations.find((x) => x.n === Number(n)) : undefined;
        return c ? (
          <button
            key={i}
            aria-label={`Fonte ${c.n}`}
            className="mx-0.5 inline-block min-w-5 rounded-full bg-tint px-1.5 text-center align-baseline text-xs font-semibold leading-5 text-brand transition-colors duration-150 hover:bg-primary hover:text-primary-fg"
            onClick={(e) => onCite(c, e.currentTarget)}
          >
            {p}
          </button>
        ) : (
          p
        );
      })}
      {pending && <span aria-hidden className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-brand" />}
    </p>
  );
  if (mine)
    return (
      <article aria-label="Você" className="flex items-end justify-end gap-2">
        <div className="max-w-[85%] bg-tint px-4 py-2.5" style={{ borderRadius: '16px 16px 6px 16px' }}>{text}</div>
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-subtle text-muted">
          <UserIcon />
        </span>
      </article>
    );
  return (
    <article aria-label="Assistente" className="flex items-start gap-3">
      <AssistantAvatar />
      <div className="card min-w-0 flex-1 px-4 py-3" style={{ borderRadius: '6px 16px 16px 16px' }}>
        {steps.length > 0 && <Steps steps={steps} intent={intent} />}
        {pending && !content ? <p className="animate-pulse text-muted">Pensando…</p> : text}
        {table && <DataTable table={table} />}
        {reindex && (
          <p className="mt-3 rounded-lg border border-warn px-3 py-2 text-xs text-warn">
            Alguns documentos foram indexados com outro modelo de embedding; a busca semântica os ignora. Reindexe para melhorar os resultados.
          </p>
        )}
        {footer}
      </div>
    </article>
  );
}
