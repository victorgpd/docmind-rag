'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * "Testar sem cadastro": só aparece se a API disser que a conta demo está ligada (GET /auth/demo).
 * Ao entrar, o redirecionamento de quem já está logado (landing/login) leva às coleções.
 */
export function DemoButton({ className = '', hint, before, fallback, initialEnabled }: { className?: string; hint?: string; before?: ReactNode; fallback?: ReactNode; initialEnabled?: boolean }) {
  const { startDemo } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(initialEnabled ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialEnabled !== undefined) return; // o servidor já respondeu
    let alive = true;
    api.demoEnabled().then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, [initialEnabled]);
  if (enabled === null) return null;
  if (!enabled) return <>{fallback}</>;

  async function enter() {
    setBusy(true);
    setError('');
    try {
      await startDemo();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      {before}
      <button type="button" onClick={enter} disabled={busy} aria-busy={busy} className={`disabled:cursor-not-allowed disabled:opacity-60 ${className}`}>
        Testar sem cadastro
      </button>
      {hint && <p className="order-last w-full text-sm text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
