import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConversationsPage from '../../../app/(app)/conversations/page';
import UsagePage from '../../../app/(app)/usage/page';
import type { SseEvent } from '@docmind/shared';
import { api, parseSse } from './api';
import { ChatView } from './ChatView';
import { CitationPanel } from './CitationPanel';
import { FeedbackButtons } from './FeedbackButtons';
import { MessageBubble } from './MessageBubble';
import { UsageView } from './UsageView';

const DOC = '11111111-1111-4111-8111-111111111111';
const cit = { documentId: DOC, page: 3, snippet: 'trecho citado', n: 1 };

beforeEach(() => vi.restoreAllMocks());

describe('MessageBubble', () => {
  it('torna [n] clicável e chama onCite; [n] sem citação fica texto', () => {
    const onCite = vi.fn();
    render(<MessageBubble role="assistant" content="Veja [1] e [2]" citations={[cit]} onCite={onCite} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fonte 1' }));
    expect(onCite.mock.calls[0]![0]).toEqual(cit);
    expect(screen.queryByRole('button', { name: 'Fonte 2' })).toBeNull();
  });

  it('mostra os passos do agente', () => {
    render(<MessageBubble role="assistant" content="ok" citations={[]} steps={[{ n: 1, tool: 'search', ok: true, ms: 4 }, { n: 2, tool: 'x', ok: false, ms: 1, error: 'boom' }]} onCite={vi.fn()} />);
    const t = screen.getByLabelText('Passos do agente').textContent;
    expect(t).toContain('search · 4 ms');
    expect(t).toContain('falhou: boom');
  });

  it('mostra "Pensando…" enquanto não há texto', () => {
    render(<MessageBubble role="assistant" content="" citations={[]} pending onCite={vi.fn()} />);
    expect(screen.getByText('Pensando…')).toBeTruthy();
  });
});

describe('CitationPanel', () => {
  it('mostra documento, página e trecho, foca o título e fecha com Esc', async () => {
    vi.spyOn(api, 'document').mockResolvedValue({ filename: 'contrato.pdf' } as never);
    const onClose = vi.fn();
    render(<CitationPanel citation={cit} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/contrato\.pdf/)).toBeTruthy());
    expect(screen.getByText('Página 3')).toBeTruthy();
    expect(screen.getByText('trecho citado')).toBeTruthy();
    expect(document.activeElement?.tagName).toBe('H2');
    fireEvent.keyDown(screen.getByLabelText('Fonte da citação'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('FeedbackButtons', () => {
  it('envia a avaliação e marca o botão', async () => {
    const fb = vi.spyOn(api, 'feedback').mockResolvedValue();
    render(<FeedbackButtons messageId="m1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Não útil' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Não útil' }).getAttribute('aria-pressed')).toBe('true'));
    expect(fb).toHaveBeenCalledWith('m1', 'down');
  });

  it('avisa quando falha', async () => {
    vi.spyOn(api, 'feedback').mockRejectedValue(new Error('x'));
    render(<FeedbackButtons messageId="m1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Útil' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});

describe('UsageView', () => {
  it('mostra tokens, custo e progresso do limite', () => {
    render(<UsageView usage={{ queries: 2, documents: 1, tokensIn: 400, tokensOut: 100, costUsd: 0.5, monthlyTokenLimit: 1000 }} />);
    expect(screen.getByText(/US\$ 0\.50/)).toBeTruthy();
    expect(screen.getByLabelText('Uso do limite mensal').getAttribute('value')).toBe('500');
  });

  it('mostra estado vazio sem uso', () => {
    render(<UsageView usage={{ queries: 0, documents: 0, tokensIn: 0, tokensOut: 0 }} />);
    expect(screen.getByText(/Sem uso registrado/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('avisa quando o limite do serviço foi atingido, mesmo sem uso próprio', () => {
    render(<UsageView usage={{ queries: 0, documents: 0, tokensIn: 0, tokensOut: 0, serviceLimitReached: true }} />);
    expect(screen.getByRole('alert').textContent).toBe('O limite de uso do serviço foi atingido este mês. Tente novamente mais tarde.');
    expect(screen.getByText(/Sem uso registrado/)).toBeTruthy();
  });
});

describe('páginas: carregando / erro / vazio', () => {
  it('uso: erro com "Tentar de novo"', async () => {
    const usage = vi.spyOn(api, 'usage').mockRejectedValueOnce(new Error('falhou'));
    render(<UsagePage />);
    expect((await screen.findByRole('alert')).textContent).toBe('falhou');
    usage.mockResolvedValue({ queries: 1, documents: 1, tokensIn: 1, tokensOut: 1 });
    fireEvent.click(screen.getByText('Tentar de novo'));
    expect(await screen.findByText('Consultas')).toBeTruthy();
  });

  it('histórico: carregando, depois vazio com link para o chat', async () => {
    vi.spyOn(api, 'conversations').mockResolvedValue([]);
    render(<ConversationsPage />);
    expect(screen.getByRole('status').textContent).toBe('Carregando…');
    expect(await screen.findByText(/Nenhuma conversa ainda/)).toBeTruthy();
  });

  it('histórico: lista com link para /chat?c=id', async () => {
    vi.spyOn(api, 'conversations').mockResolvedValue([{ id: 'c1', title: 'Contrato', createdAt: '2026-01-01T00:00:00.000Z' } as never]);
    render(<ConversationsPage />);
    expect(((await screen.findByRole('link', { name: /Contrato/ })) as HTMLAnchorElement).getAttribute('href')).toBe('/chat?c=c1');
  });
});

describe('ChatView', () => {
  const stream = async function* (): AsyncGenerator<SseEvent> {
    yield { type: 'token', delta: 'Prazo de 30 dias [1]' };
    yield { type: 'citations', citations: [cit] };
    yield { type: 'done', messageId: 'm1', tokensIn: 1, tokensOut: 1 };
  };

  it('estado vazio sem coleções leva a /collections', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([]);
    render(<ChatView />);
    expect(await screen.findByRole('link', { name: 'Crie uma coleção' })).toBeTruthy();
  });

  it('envia, faz streaming, mostra citação clicável e devolve o foco ao fechar', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([{ id: 'col', name: 'Contratos' } as never]);
    vi.spyOn(api, 'createConversation').mockResolvedValue({ id: 'c1' } as never);
    const send = vi.spyOn(api, 'send').mockResolvedValue(stream());
    vi.spyOn(api, 'document').mockResolvedValue({ filename: 'contrato.pdf' } as never);
    render(<ChatView />);
    expect(screen.getByRole('log', { name: 'Conversa' }).getAttribute('aria-live')).toBe('polite');

    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Qual o prazo?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const fonte = await screen.findByRole('button', { name: 'Fonte 1' });
    expect(send).toHaveBeenCalledWith('c1', 'Qual o prazo?', false, expect.any(AbortSignal));
    expect(screen.getByRole('group', { name: 'Avaliar resposta' })).toBeTruthy();

    fonte.focus();
    fireEvent.click(fonte);
    await screen.findByText(/contrato\.pdf/);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(document.activeElement).toBe(fonte);
  });

  it('modo agente: plano, passos, resposta, tabela, conversa persistida e feedback', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([]);
    const create = vi.spyOn(api, 'createConversation').mockResolvedValue({ id: 'c1' } as never);
    const send = vi.spyOn(api, 'send').mockResolvedValue(
      (async function* (): AsyncGenerator<SseEvent> {
        yield { type: 'plan', intent: 'extract_table' };
        yield { type: 'step', n: 1, tool: 'extract_table' };
        yield { type: 'step_result', n: 1, tool: 'extract_table', ok: true, ms: 7 };
        yield {
          type: 'result',
          result: { answer: 'Tabela [1]', citations: [cit], truncated: false, data: { table: { page: 1, headers: ['Item'], rows: [['A']] } } },
        };
        yield { type: 'done', messageId: 'm1', tokensIn: 1, tokensOut: 1 };
      })(),
    );
    render(<ChatView />);
    fireEvent.click(screen.getByLabelText('Modo agente'));
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'extraia a tabela' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByRole('region', { name: 'Tabela extraída' })).toBeTruthy();
    const passos = screen.getByLabelText('Passos do agente').textContent;
    expect(passos).toContain('Plano: extract_table');
    expect(passos).toContain('extract_table · 7 ms');
    expect(send).toHaveBeenCalledWith('c1', 'extraia a tabela', true, expect.any(AbortSignal));
    expect(create).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fonte 1' })).toBeTruthy();
    expect(await screen.findByRole('group', { name: 'Avaliar resposta' })).toBeTruthy();
  });

  it('histórico: reabre resposta do agente com plano, passos e tabela', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([]);
    vi.spyOn(api, 'conversation').mockResolvedValue({
      id: 'c1',
      collectionId: null,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Tabela [1]',
          citations: [cit],
          data: { intent: 'extract_table', steps: [{ tool: 'extract_table', ok: true, ms: 7 }], data: { table: { page: 1, headers: ['Item'], rows: [['A']] } } },
        },
      ],
    } as never);
    render(<ChatView conversationId="c1" />);
    expect(await screen.findByRole('region', { name: 'Tabela extraída' })).toBeTruthy();
    const passos = screen.getByLabelText('Passos do agente').textContent;
    expect(passos).toContain('Plano: extract_table');
    expect(passos).toContain('extract_table · 7 ms');
  });

  it('mostra aviso discreto quando o done traz reindex_needed', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([]);
    vi.spyOn(api, 'createConversation').mockResolvedValue({ id: 'c1' } as never);
    vi.spyOn(api, 'send').mockResolvedValue(
      (async function* (): AsyncGenerator<SseEvent> {
        yield { type: 'token', delta: 'ok' };
        yield { type: 'done', messageId: 'm1', tokensIn: 1, tokensOut: 1, warnings: ['reindex_needed'] };
      })(),
    );
    render(<ChatView />);
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(/outro modelo de embedding/)).toBeTruthy();
  });

  it('histórico: mostra o aviso de reindexação sob a última resposta', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([]);
    vi.spyOn(api, 'conversation').mockResolvedValue({
      id: 'c1',
      collectionId: null,
      warnings: ['reindex_needed'],
      messages: [
        { id: 'm0', role: 'user', content: 'oi', citations: [] },
        { id: 'm1', role: 'assistant', content: 'olá', citations: [] },
      ],
    } as never);
    render(<ChatView conversationId="c1" />);
    expect(await screen.findAllByText(/outro modelo de embedding/)).toHaveLength(1);
  });

  it('sair da tela aborta o stream em andamento', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([]);
    vi.spyOn(api, 'createConversation').mockResolvedValue({ id: 'c1' } as never);
    let signal: AbortSignal | undefined;
    vi.spyOn(api, 'send').mockImplementation(async (_i, _c, _a, s) => {
      signal = s;
      return (async function* (): AsyncGenerator<SseEvent> {
        await new Promise((r) => s?.addEventListener('abort', r));
        yield { type: 'error', message: 'abortado' };
      })();
    });
    const { unmount } = render(<ChatView />);
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await screen.findByRole('button', { name: 'Parar' });
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('402 global_limit_exceeded: alerta do limite do serviço', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([]);
    vi.spyOn(api, 'createConversation').mockResolvedValue({ id: 'c1' } as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'global_limit_exceeded', message: 'x' } }), { status: 402 }));
    render(<ChatView />);
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('O limite de uso do serviço foi atingido este mês. Tente novamente mais tarde.');
  });

  it('mostra erro do stream', async () => {
    vi.spyOn(api, 'collections').mockResolvedValue([]);
    vi.spyOn(api, 'createConversation').mockResolvedValue({ id: 'c1' } as never);
    vi.spyOn(api, 'send').mockRejectedValue(new Error('sem rede'));
    render(<ChatView />);
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('sem rede');
  });
});

describe('parseSse', () => {
  it('junta frames cortados entre chunks e valida com SseEvent', async () => {
    const enc = new TextEncoder();
    // inclui evento desconhecido, JSON inválido e token malformado: todos ignorados
    const chunks = [
      'data: {"type":"token","del',
      'ta":"oi"}\n\ndata: {"type":"futuro","x":1}\n\ndata: nao-json\n\ndata: {"type":"token"}\n\ndata: {"type":"error","message":"x"}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((s) => c.enqueue(enc.encode(s)));
        c.close();
      },
    });
    const out = [];
    for await (const ev of parseSse(body)) out.push(ev);
    expect(out).toEqual([{ type: 'token', delta: 'oi' }, { type: 'error', message: 'x' }]);
  });
});
