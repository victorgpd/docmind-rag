import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Document } from '@docmind/shared';
import { AuthForm } from './AuthForm';
import { DocumentList } from './DocumentList';
import { UploadZone } from './UploadZone';

const doc = (status: Document['status'], extra: Partial<Document> = {}): Document => ({
  id: crypto.randomUUID(),
  organizationId: crypto.randomUUID(),
  collectionId: crypto.randomUUID(),
  filename: `${status}.pdf`,
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  storageKey: 'k',
  status,
  error: null,
  pageCount: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('DocumentList', () => {
  it('mostra o rotulo em portugues de cada status e a mensagem de erro', () => {
    render(
      <DocumentList
        documents={[
          doc('pending'),
          doc('processing'),
          doc('ready'),
          doc('failed', { error: 'PDF corrompido' }),
        ]}
        onDelete={() => {}}
      />,
    );
    for (const t of ['Na fila', 'Processando', 'Pronto', 'Erro'])
      expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByText('PDF corrompido')).toBeTruthy();
  });
});

describe('UploadZone', () => {
  it('chama onFiles ao soltar arquivos', () => {
    const onFiles = vi.fn();
    render(<UploadZone onFiles={onFiles} />);
    const file = new File(['x'], 'a.txt');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('nao aceita arquivos quando desabilitado', () => {
    const onFiles = vi.fn();
    render(<UploadZone onFiles={onFiles} disabled />);
    fireEvent.drop(screen.getByTestId('dropzone'), {
      dataTransfer: { files: [new File(['x'], 'a.txt')] },
    });
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe('AuthForm', () => {
  it('envia os valores e mostra o erro da API em role=alert', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Senha incorreta'));
    render(<AuthForm mode="login" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo123' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Entrar' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Senha incorreta'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.co', password: 'segredo123' }),
    );
  });

  it('no cadastro exige nome e organizacao', () => {
    render(<AuthForm mode="register" onSubmit={async () => {}} />);
    expect(screen.getByLabelText('Nome')).toBeTruthy();
    expect(screen.getByLabelText('Nome da organização')).toBeTruthy();
  });
});

describe('DocumentList: paginacao', () => {
  it('mostra "Carregar mais" so com mais paginas e chama onLoadMore', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<DocumentList documents={[doc('ready')]} onDelete={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();

    rerender(
      <DocumentList
        documents={[doc('ready')]}
        onDelete={() => {}}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('desabilita o botao enquanto carrega', () => {
    render(
      <DocumentList
        documents={[doc('ready')]}
        onDelete={() => {}}
        hasMore
        loadingMore
        onLoadMore={() => {}}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Carregando…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
