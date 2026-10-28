'use client';

import { useState, type FormEvent } from 'react';
import { ApiRequestError, errorMessage } from '../lib/api';
import { collectErrors, FormField } from './FormField';
import { EyeIcon } from './icons';
import { Button, Input } from './ui';

/** Espelha shared.Password (8-128 caracteres, ao menos uma letra e um numero) sem importar o Zod no cliente. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (password.length > 128) return 'A senha pode ter no máximo 128 caracteres.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'A senha precisa ter letras e números.';
  return undefined;
}

export type AuthValues = { email: string; password: string; name: string; organizationName: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Porta de entrada publica: so elementos nativos (sem antd), para carregar leve. */
export function AuthForm({ mode, onSubmit }: { mode: 'login' | 'register'; onSubmit: (v: AuthValues) => Promise<void> }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  // resumo role=alert (so leitor de tela) anuncia o erro de envio; o texto visivel fica sob o campo
  const [alert, setAlert] = useState('');
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const register = mode === 'register';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '');
    const v: AuthValues = { email: get('email').trim(), password: get('password'), name: get('name').trim(), organizationName: get('organizationName').trim() };

    const found = collectErrors([
      ['name', register && !v.name ? 'Informe seu nome.' : undefined],
      ['organizationName', register && !v.organizationName ? 'Informe o nome da organização.' : undefined],
      ['email', !v.email ? 'Informe seu e-mail.' : !EMAIL.test(v.email) ? 'Informe um e-mail válido.' : undefined],
      ['password', register ? passwordProblem(v.password) : !v.password ? 'Informe sua senha.' : undefined],
    ]);
    setErrors(found);
    setClosed(false);
    const first = Object.values(found)[0];
    setAlert(first ?? '');
    if (first) return;

    setBusy(true);
    try {
      await onSubmit(v);
    } catch (err) {
      // cadastro fechado nao e erro de campo: aviso discreto e visivel no lugar do resumo sr-only
      const isClosed = err instanceof ApiRequestError && err.code === 'registration_closed';
      setClosed(isClosed);
      setErrors(isClosed ? {} : { password: errorMessage(err) });
      setAlert(isClosed ? 'Cadastro fechado no momento.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label={register ? 'Criar conta' : 'Entrar'} className="flex flex-col gap-4">
      {register && (
        <FormField id="name" label="Nome" error={errors.name}>
          {(c) => <Input name="name" autoComplete="name" {...c} />}
        </FormField>
      )}
      {register && (
        <FormField id="organizationName" label="Nome da organização" error={errors.organizationName}>
          {(c) => <Input name="organizationName" {...c} />}
        </FormField>
      )}
      <FormField id="email" label="E-mail" error={errors.email}>
        {(c) => <Input name="email" type="email" autoComplete="email" {...c} />}
      </FormField>
      <FormField
        id="password"
        label={register ? 'Senha (mínimo 8 caracteres)' : 'Senha'}
        hint={register ? 'Use letras e números.' : undefined}
        error={errors.password}
      >
        {(c) => (
          <div className="relative">
            <Input name="password" type={showPw ? 'text' : 'password'} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} className="pr-10" {...c} />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              aria-pressed={showPw}
              aria-label="Mostrar caracteres"
              className="absolute right-1 top-1 inline-flex size-7 items-center justify-center rounded-md text-muted hover:text-fg"
            >
              <EyeIcon size={16} off={showPw} />
            </button>
          </div>
        )}
      </FormField>
      {alert && (
        <div role="alert" className={closed ? 'text-sm text-muted' : 'sr-only'}>
          {alert}
        </div>
      )}
      <Button variant="primary" type="submit" block disabled={busy} aria-busy={busy} className="h-10">
        {register ? 'Criar conta' : 'Entrar'}
      </Button>
    </form>
  );
}
