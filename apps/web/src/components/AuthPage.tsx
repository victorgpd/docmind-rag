'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { AuthForm } from './AuthForm';
import { DemoButton } from './DemoButton';
import { Logo } from './icons';

/** Layout dividido: painel de marca (gradiente) + formulário centralizado; uma coluna no mobile. Só HTML/CSS (sem antd). */
export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { status, login, register } = useAuth();
  const router = useRouter();
  const isRegister = mode === 'register';

  useEffect(() => {
    if (status === 'authed') router.replace('/collections');
  }, [status, router]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="bg-grad relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex">
        <div aria-hidden className="dots absolute inset-0 opacity-20 [mask-image:radial-gradient(circle_at_30%_20%,black,transparent_70%)]" />
        <Link href="/" className="relative inline-flex items-center gap-2.5 text-[15px] font-semibold !text-white">
          <span aria-hidden className="flex size-7 items-center justify-center rounded-lg bg-white/20 text-sm">
            ✦
          </span>
          DocMind
        </Link>
        <div className="relative max-w-sm">
          <p className="text-3xl font-semibold leading-tight tracking-tight text-balance">Pergunte aos seus documentos. Com fontes.</p>
          <p className="mt-3 text-sm text-white">Respostas em português, com citações que você confere em um clique.</p>
        </div>
        <p className="relative text-xs text-white">© {new Date().getFullYear()} DocMind</p>
      </aside>

      <main className="flex min-h-screen flex-col justify-center bg-bg px-6 py-10 lg:min-h-0">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
          <Link href="/" className="lg:hidden" aria-label="DocMind, página inicial">
            <Logo />
          </Link>
          <div>
            <h1 className="text-2xl">{isRegister ? 'Criar conta' : 'Entrar no DocMind'}</h1>
            <p className="mt-1 text-sm text-muted">{isRegister ? 'Crie sua organização e comece em minutos.' : 'Acesse suas coleções e conversas.'}</p>
          </div>
          <div className="card p-6">
            <AuthForm mode={mode} onSubmit={(v) => (isRegister ? register(v) : login({ email: v.email, password: v.password }))} />
          </div>
          {!isRegister && (
            <DemoButton className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-fg transition duration-150 hover:bg-subtle" />
          )}
          <p className="text-sm text-muted">
            {isRegister ? 'Já tem conta? ' : 'Ainda não tem conta? '}
            <Link href={isRegister ? '/login' : '/register'} className="font-medium !text-brand underline underline-offset-4">
              {isRegister ? 'Entrar' : 'Criar conta'}
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
