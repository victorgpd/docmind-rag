import type { ReactNode } from 'react';
import { BoltIcon, ChartIcon, FileIcon, SparkIcon } from '../../components/icons';
import { SERVICE_LIMIT_MESSAGE, type Usage } from './api';
import { ErrorAlert } from './states';

const fmt = (n: number) => n.toLocaleString('pt-BR');

function Stat({ title, value, icon, children }: { title: string; value: string; icon: ReactNode; children?: ReactNode }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="grid size-7 place-items-center rounded-lg bg-tint text-brand">{icon}</span>
        {title}
      </div>
      <div className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      {children}
    </div>
  );
}

export function UsageView({ usage }: { usage: Usage }) {
  return (
    <div className="space-y-4">
      {usage.serviceLimitReached && <ErrorAlert>{SERVICE_LIMIT_MESSAGE}</ErrorAlert>}
      <UsageStats usage={usage} />
    </div>
  );
}

function UsageStats({ usage }: { usage: Usage }) {
  const total = usage.tokensIn + usage.tokensOut;
  const limit = usage.monthlyTokenLimit;
  const pct = limit ? Math.min(100, Math.round((total / limit) * 100)) : 0;
  if (total === 0 && usage.queries === 0 && usage.documents === 0) {
    return <p className="card p-6 text-sm text-muted">Sem uso registrado ainda. Envie documentos e faça perguntas no chat.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Stat title="Consultas" value={fmt(usage.queries)} icon={<SparkIcon size={15} />} />
      <Stat title="Documentos" value={fmt(usage.documents)} icon={<FileIcon size={15} />} />
      <Stat title="Tokens (entrada / saída)" value={`${fmt(usage.tokensIn)} / ${fmt(usage.tokensOut)}`} icon={<BoltIcon size={15} />}>
        {/* barra empilhada em CSS puro: proporção entrada x saída */}
        <div aria-hidden className="mt-4 flex h-2 overflow-hidden rounded-full bg-subtle">
          <div className="bg-grad" style={{ width: `${total ? (usage.tokensIn / total) * 100 : 0}%` }} />
          <div className="bg-brand opacity-40" style={{ width: `${total ? (usage.tokensOut / total) * 100 : 0}%` }} />
        </div>
        <p className="mt-2 flex gap-4 text-xs text-muted">
          <span><span className="text-brand">●</span> Entrada</span>
          <span><span className="text-brand opacity-40">●</span> Saída</span>
        </p>
      </Stat>
      <Stat title="Custo" value={`US$ ${(usage.costUsd ?? 0).toFixed(2)}`} icon={<ChartIcon size={15} />} />
      {limit ? (
        <div className="card p-5 sm:col-span-2">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm text-muted">
              Limite mensal: {fmt(total)} de {fmt(limit)} tokens
            </p>
            <p className="text-sm font-semibold tabular-nums">{pct}%</p>
          </div>
          {/* progress nativo: acessível (rótulo do E2E); trilho e preenchimento só com CSS */}
          <progress
            aria-label="Uso do limite mensal"
            className={`mt-3 block h-2 w-full appearance-none overflow-hidden rounded-full bg-subtle [&::-moz-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-subtle [&::-webkit-progress-value]:rounded-full ${
              pct >= 80
                ? '[&::-moz-progress-bar]:bg-danger [&::-webkit-progress-value]:bg-danger'
                : '[&::-moz-progress-bar]:bg-brand [&::-webkit-progress-value]:bg-brand'
            }`}
            value={Math.min(total, limit)}
            max={limit}
          />
          {pct >= 80 && (
            <p className="mt-3 text-sm text-danger">
              {pct >= 100 ? 'Você atingiu o limite mensal; novas consultas ficam bloqueadas.' : 'Você está perto do limite mensal de tokens.'}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
