'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * "Experimentar a demonstração": só aparece se a API disser que a conta demo está ligada (GET /auth/demo).
 * Ao entrar, o redirecionamento de quem já está logado (landing/login) leva às coleções.
 */
export function DemoButton({ className = '' }: { className?: string }) {
  const { startDemo } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.demoEnabled().then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, []);
  if (!enabled) return null;

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
      <button type="button" onClick={enter} disabled={busy} aria-busy={busy} className={`disabled:cursor-not-allowed disabled:opacity-60 ${className}`}>
        Experimentar a demonstração
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
