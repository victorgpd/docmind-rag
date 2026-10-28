'use client';
import { useState } from 'react';
import { api } from './api';
import { CheckIcon, CopyIcon, ThumbDownIcon, ThumbUpIcon } from './icons';
import { ErrorAlert } from './states';

const action =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted transition-colors duration-150 hover:bg-subtle hover:text-fg aria-pressed:bg-tint aria-pressed:font-semibold aria-pressed:text-brand';

export function FeedbackButtons({ messageId, text }: { messageId: string; text?: string }) {
  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const send = async (r: 'up' | 'down') => {
    setError('');
    try {
      await api.feedback(messageId, r);
      setRating(r);
    } catch {
      setError('Não foi possível enviar a avaliação.');
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Não foi possível copiar.');
    }
  };
  return (
    <div role="group" aria-label="Avaliar resposta" className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-2">
      <button type="button" className={action} aria-pressed={rating === 'up'} onClick={() => send('up')}>
        <ThumbUpIcon size={14} /> Útil
      </button>
      <button type="button" className={action} aria-pressed={rating === 'down'} onClick={() => send('down')}>
        <ThumbDownIcon size={14} /> Não útil
      </button>
      {text && (
        <button type="button" className={`${action} ml-auto`} onClick={copy}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />} {copied ? 'Copiado' : 'Copiar'}
        </button>
      )}
      <ErrorAlert>{error}</ErrorAlert>
    </div>
  );
}
