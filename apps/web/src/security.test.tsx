import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentList } from './components/DocumentList';
import { CitationPanel } from './features/chat/CitationPanel';
import { MessageBubble } from './features/chat/MessageBubble';

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
const ID = '11111111-1111-4111-8111-111111111111';

/** Conteudo vindo de documentos/modelo deve virar texto: nenhum elemento perigoso no DOM. */
function expectInert(container: HTMLElement) {
  expect(container.querySelector('img, script, iframe')).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.textContent).toContain('<script>alert(2)</script>');
}

describe('conteudo nao confiavel e renderizado como texto', () => {
  it('nome e erro de documento', () => {
    const { container } = render(
      <DocumentList
        documents={[
          {
            id: ID,
            organizationId: ID,
            collectionId: ID,
            filename: HOSTILE,
            mimeType: 'text/plain',
            sizeBytes: 1,
            storageKey: 'k',
            status: 'failed',
            error: HOSTILE,
            pageCount: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        onDelete={() => {}}
      />,
    );
    expectInert(container);
  });

  it('resposta do modelo', () => {
    const { container } = render(<MessageBubble role="assistant" content={HOSTILE} citations={[]} onCite={vi.fn()} />);
    expectInert(container);
  });

  it('trecho citado', () => {
    const { container } = render(
      <CitationPanel citation={{ documentId: ID, page: 1, snippet: HOSTILE, n: 1 }} onClose={() => {}} />,
    );
    expectInert(container);
  });
});
