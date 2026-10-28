'use client';

import { useRef, useState, type DragEvent } from 'react';
import { UploadIcon } from './icons';
import { Button } from './ui';

/** Drag&drop + botao/teclado (o input escondido e acionado pelo botao, que e focavel). Sem Upload do antd. */
export function UploadZone({ onFiles, disabled, hint }: { onFiles: (files: File[]) => void; disabled?: boolean; hint?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function drop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (!disabled && e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
  }

  return (
    <div
      data-testid="dropzone"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={`flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed p-10 text-center transition duration-150 ${over ? 'scale-[1.01] border-brand bg-tint' : 'border-line-strong bg-surface'}`}
    >
      <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-tint text-brand">
        <UploadIcon size={22} />
      </span>
      <p className="text-sm font-medium">Arraste arquivos aqui ou</p>
      <Button disabled={disabled} onClick={() => input.current?.click()}>
        Escolher arquivos
      </Button>
      <p className="text-xs text-muted">{hint ?? 'Cada arquivo é processado automaticamente depois do envio.'}</p>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        disabled={disabled}
        aria-label="Arquivos para enviar"
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files]);
          e.target.value = ''; // permite reenviar o mesmo arquivo
        }}
      />
    </div>
  );
}
