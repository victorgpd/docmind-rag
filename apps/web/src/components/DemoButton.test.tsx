import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, errorMessage } from '../lib/api';
import { AuthProvider, useAuth } from '../lib/auth';
import { DemoButton } from './DemoButton';
import { DocumentList } from './DocumentList';

const user = { id: crypto.randomUUID(), organizationId: crypto.randomUUID(), email: 'demo@docmind.app', name: 'Visitante', createdAt: '2026-01-01T00:00:00.000Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** fetch falso por rota: sem sessao no refresh; GET /auth/demo diz `enabled`; POST /auth/demo entra como demo. */
const stubApi = (enabled: boolean) => {
  const f = vi.fn(async (u: string, init?: RequestInit) => {
    if (u.endsWith('/auth/refresh')) return json({ error: { code: 'unauthorized', message: 'x' } }, 401);
    if (u.endsWith('/auth/demo') && init?.method === 'POST') return json({ token: 't', user, demo: true });
    if (u.endsWith('/auth/demo')) return json({ enabled });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', f);
  return f;
};
function Probe() {
  const { status, demo } = useAuth();
  return <p data-testid="probe">{`${status}:${demo}`}</p>;
}

afterEach(() => vi.unstubAllGlobals());

describe('DemoButton', () => {
  it('fica oculto quando a API diz que a demonstracao esta desligada', async () => {
    const f = stubApi(false);
    render(<AuthProvider><DemoButton /></AuthProvider>);
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u).endsWith('/auth/demo') && !i?.method)).toBe(true));
    expect(screen.queryByRole('button', { name: 'Testar sem cadastro' })).toBeNull();
  });

  it('ligada: o clique chama POST /auth/demo e a sessao fica marcada como demo', async () => {
    const f = stubApi(true);
    render(<AuthProvider><DemoButton /><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('anon:false'));
    fireEvent.click(await screen.findByRole('button', { name: 'Testar sem cadastro' }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('authed:true'));
    expect(f.mock.calls.some(([u, i]) => String(u).endsWith('/auth/demo') && i?.method === 'POST')).toBe(true);
  });
});

it('403 demo_read_only vira mensagem amigavel; outros erros seguem com a mensagem da API', () => {
  expect(errorMessage(new ApiRequestError('x', 403, 'demo_read_only'))).toMatch(/^A conta de demonstração é somente leitura/);
  expect(errorMessage(new ApiRequestError('Coleção não encontrada', 404, 'not_found'))).toBe('Coleção não encontrada');
});

it('DocumentList com disabledReason: excluir fica desabilitado com o motivo no tooltip', () => {
  const doc = { id: crypto.randomUUID(), organizationId: user.organizationId, collectionId: crypto.randomUUID(), filename: 'a.md', mimeType: 'text/markdown', sizeBytes: 10, storageKey: 'k', status: 'ready' as const, error: null, pageCount: null, createdAt: user.createdAt };
  render(<DocumentList documents={[doc]} onDelete={() => {}} disabledReason="Somente leitura" />);
  const del = screen.getByRole('button', { name: 'Excluir a.md' }) as HTMLButtonElement;
  expect(del.disabled).toBe(true);
  expect(del.title).toBe('Somente leitura');
});
