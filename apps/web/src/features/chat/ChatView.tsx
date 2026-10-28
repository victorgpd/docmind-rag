'use client';
import type { Citation, Collection, Message } from '@docmind/shared';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { AssistantAvatar, SendIcon, StopIcon } from './icons';
import { agentView, api, parseAgentResult, tableOf, type AgentStep, type Table } from './api';
import { CitationPanel } from './CitationPanel';
import { FeedbackButtons } from './FeedbackButtons';
import { MessageBubble } from './MessageBubble';
import { ErrorAlert, LoadingLines } from './states';

type View = { id: string; role: Message['role']; content: string; citations: Citation[]; steps: AgentStep[]; intent?: string; table?: Table; reindex?: boolean; done: boolean };

const SUGGESTIONS = ['Resuma os pontos principais dos documentos.', 'Quais prazos e datas aparecem nos documentos?', 'Extraia as tabelas dos documentos.'];
const chip = 'rounded-full border border-line-strong px-3 py-1.5 text-sm text-muted transition-colors duration-150 hover:border-brand hover:text-brand';

export function ChatView({ conversationId }: { conversationId?: string }) {
  const [convId, setConvId] = useState(conversationId);
  const [collections, setCollections] = useState<Collection[]>();
  const [collectionId, setCollectionId] = useState('');
  const [agent, setAgent] = useState(false);
  const [msgs, setMsgs] = useState<View[]>([]);
  const [loading, setLoading] = useState(!!conversationId);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cited, setCited] = useState<Citation | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // autoSize nativo: Input.TextArea custa ~35 kB gzip (resize-observer); cresce até max-h e volta a 1 linha
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight) el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  useEffect(() => () => ctl.current?.abort(), []); // sair da tela interrompe o stream
  useEffect(() => {
    api.collections().then(setCollections).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!conversationId) return;
    api.conversation(conversationId).then((c) => {
      setCollectionId(c.collectionId ?? '');
      const last = c.messages.findLastIndex((m) => m.role === 'assistant');
      const reindex = c.warnings?.includes('reindex_needed');
      setMsgs(c.messages.map((m, i) => ({ ...m, steps: [], ...agentView(m.data), reindex: reindex && i === last, done: true })));
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [conversationId]);

  const patchLast = (f: (m: View) => Partial<View>) =>
    setMsgs((all) => all.map((m, i) => (i === all.length - 1 ? { ...m, ...f(m) } : m)));

  const closeCitation = () => {
    setCited(null);
    opener.current?.focus();
  };

  async function submit(e?: React.SyntheticEvent) {
    e?.preventDefault();
    const content = input.trim();
    if (!content || busy) return;
    setInput('');
    setError('');
    setBusy(true);
    ctl.current = new AbortController();
    try {
      const id = convId ?? (await api.createConversation(collectionId || undefined)).id;
      setConvId(id);
      setMsgs((a) => [
        ...a,
        { id: crypto.randomUUID(), role: 'user', content, citations: [], steps: [], done: true },
        { id: '', role: 'assistant', content: '', citations: [], steps: [], done: false },
      ]);
      for await (const ev of await api.send(id, content, agent, ctl.current.signal)) {
        if (ev.type === 'token') patchLast((m) => ({ content: m.content + ev.delta }));
        else if (ev.type === 'citations') patchLast(() => ({ citations: ev.citations }));
        else if (ev.type === 'plan') patchLast(() => ({ intent: ev.intent }));
        else if (ev.type === 'step')
          patchLast((m) => ({ steps: [...m.steps, { n: ev.n ?? m.steps.length + 1, tool: ev.tool, input: ev.input }] }));
        else if (ev.type === 'step_result')
          patchLast((m) => ({ steps: m.steps.map((s) => (s.n === ev.n ? { ...s, ok: ev.ok, ms: ev.ms, error: ev.error } : s)) }));
        else if (ev.type === 'result') {
          const r = parseAgentResult(ev.result);
          if (r) patchLast(() => ({ content: r.answer, citations: r.citations, table: tableOf(r.data) }));
        } else if (ev.type === 'done')
          patchLast(() => ({ id: ev.messageId, done: true, reindex: ev.warnings?.includes('reindex_needed') }));
        else setError(ev.message);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      patchLast(() => ({ done: true }));
      setBusy(false);
    }
  }

  const ask = (q: string) => {
    setInput(q);
    box.current?.focus();
  };

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-96 flex-col md:flex-row">
      <div className="mx-auto flex min-h-0 w-full max-w-[44rem] min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 pb-3 text-sm">
          <label className="flex items-center gap-2 text-muted">
            Coleção
            <select
              className="h-8 rounded-full border border-line-strong bg-surface px-3 text-sm text-fg transition-colors duration-150 hover:border-brand disabled:opacity-60"
              value={collectionId}
              disabled={!!convId || !collections}
              onChange={(e) => setCollectionId(e.target.value)}
            >
              <option value="">Todas as coleções</option>
              {collections?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-8 cursor-pointer items-center gap-2 rounded-full border border-line-strong px-3 transition-colors duration-150 hover:border-brand has-[:checked]:border-brand has-[:checked]:bg-tint has-[:checked]:text-brand">
            <input type="checkbox" className="size-4 accent-brand" checked={agent} onChange={(e) => setAgent(e.target.checked)} /> Modo agente
          </label>
        </div>
        {/* aria-busy: leitores de tela leem a resposta inteira ao fim do streaming, sem narrar cada token */}
        <div
          role="log"
          aria-label="Conversa"
          aria-live="polite"
          aria-busy={busy}
          className="flex-1 space-y-5 overflow-y-auto py-2 pr-1"
        >
          {loading && <LoadingLines rows={2} label="Carregando conversa…" />}
          {!loading && msgs.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <div className="scale-150 pb-3">
                <AssistantAvatar />
              </div>
              <h2 className="text-xl">Olá! Como posso ajudar?</h2>
              {collections?.length === 0 ? (
                <p className="text-sm text-muted">
                  Você ainda não tem documentos. <Link className="text-brand underline" href="/collections">Crie uma coleção</Link> e envie arquivos para começar.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted">Faça uma pergunta sobre os seus documentos.</p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map((q) => (
                      <button key={q} type="button" className={chip} onClick={() => ask(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {msgs.map((m, i) => (
            <MessageBubble
              key={i}
              {...m}
              pending={!m.done}
              onCite={(c, el) => {
                opener.current = el;
                setCited(c);
              }}
              footer={m.role === 'assistant' && m.done && m.id ? <FeedbackButtons messageId={m.id} text={m.content} /> : null}
            />
          ))}
        </div>
        <p role="status" className="sr-only">
          {busy ? 'Gerando resposta…' : ''}
        </p>
        <ErrorAlert>{error}</ErrorAlert>
        <form
          onSubmit={submit}
          className="card mt-2 flex items-end gap-2 p-2 transition-colors duration-150 focus-within:border-brand"
          style={{ borderRadius: 16, boxShadow: 'var(--shadow-lift)' }}
        >
          <textarea
            ref={box}
            aria-label="Mensagem"
            rows={1}
            placeholder="Pergunte algo sobre os seus documentos…"
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); // Shift+Enter quebra linha
            }}
          />
          {busy && (
            <Button variant="text" onClick={() => ctl.current?.abort()}>
              <StopIcon /> Parar
            </Button>
          )}
          <Button variant="primary" type="submit" disabled={busy || !input.trim()}>
            Enviar <SendIcon />
          </Button>
        </form>
      </div>
      {cited && <CitationPanel citation={cited} onClose={closeCitation} />}
    </div>
  );
}
