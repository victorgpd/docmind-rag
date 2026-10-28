import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../lib/api';
import { AuthForm, passwordProblem } from './AuthForm';

const fill = (password: string) => {
  fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana' } });
  fireEvent.change(screen.getByLabelText('Nome da organização'), { target: { value: 'Acme' } });
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@acme.co' } });
  fireEvent.change(screen.getByLabelText(/^Senha/), { target: { value: password } });
  fireEvent.submit(screen.getByRole('form', { name: 'Criar conta' }));
};

describe('passwordProblem (politica de senha de shared.Password)', () => {
  it.each([
    ['curta1', 'A senha precisa ter pelo menos 8 caracteres.'],
    ['somenteletras', 'A senha precisa ter letras e números.'],
    ['123456789', 'A senha precisa ter letras e números.'],
    ['a1'.repeat(70), 'A senha pode ter no máximo 128 caracteres.'],
  ])('%s -> mensagem em portugues', (pw, msg) => expect(passwordProblem(pw)).toBe(msg));

  it('aceita senha valida', () => expect(passwordProblem('senha-forte-123')).toBeUndefined());
});

describe('AuthForm: senha no cadastro', () => {
  it('mostra a ajuda ligada ao campo, mantem o label do E2E e limita o tamanho', () => {
    render(<AuthForm mode="register" onSubmit={async () => {}} />);
    const input = screen.getByLabelText('Senha (mínimo 8 caracteres)');
    expect(input.getAttribute('maxlength')).toBe('128');
    const help = input.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(help).toContain('Use letras e números.');
  });

  it('senha fraca: mostra o erro em portugues no role=alert e nao envia', async () => {
    const onSubmit = vi.fn();
    render(<AuthForm mode="register" onSubmit={onSubmit} />);
    fill('somenteletras');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A senha precisa ter letras e números.'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('cadastro fechado (403 registration_closed): aviso visivel, sem erro no campo de senha', async () => {
    render(<AuthForm mode="register" onSubmit={() => Promise.reject(new ApiRequestError('closed', 403, 'registration_closed'))} />);
    fill('senha-forte-123');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Cadastro fechado no momento.'));
    expect(screen.getByRole('alert').className).not.toContain('sr-only');
    expect(screen.getByLabelText('Senha (mínimo 8 caracteres)').getAttribute('aria-invalid')).not.toBe('true');
  });

  it('senha valida: envia os valores', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AuthForm mode="register" onSubmit={onSubmit} />);
    fill('senha-forte-123');
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ email: 'ana@acme.co', password: 'senha-forte-123', name: 'Ana', organizationName: 'Acme' }));
  });
});

describe('AuthForm: login', () => {
  it('sem ajuda de senha e sem validar a politica (contas antigas entram)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AuthForm mode="login" onSubmit={onSubmit} />);
    expect(screen.queryByText('Use letras e números.')).toBeNull();
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'x' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Entrar' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });
});
