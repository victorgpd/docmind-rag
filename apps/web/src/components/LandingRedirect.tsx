'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';

/** Usuário já logado em "/" vai direto para as coleções; a landing continua estática para os demais. */
export function LandingRedirect() {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === 'authed') router.replace('/collections');
  }, [status, router]);
  return null;
}
