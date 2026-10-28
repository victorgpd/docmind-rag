'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button, PageHeader } from '../../../src/components/ui';
import { api, type Usage } from '../../../src/features/chat/api';
import { ErrorAlert, LoadingLines } from '../../../src/features/chat/states';
import { UsageView } from '../../../src/features/chat/UsageView';

export default function UsagePage() {
  const [usage, setUsage] = useState<Usage>();
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api.usage().then(setUsage).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  return (
    <section className="space-y-6">
      <PageHeader title="Uso" subtitle="Consultas, tokens e custo do seu espaço no mês." />
      <ErrorAlert>{error}</ErrorAlert>
      {error && (
        <Button onClick={load}>
          Tentar de novo
        </Button>
      )}
      {!usage && !error && (
        <LoadingLines />
      )}
      {usage && <UsageView usage={usage} />}
    </section>
  );
}
