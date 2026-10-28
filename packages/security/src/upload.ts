export type UploadKind = 'pdf' | 'docx' | 'txt' | 'md';

export type UploadCheck = { ok: true; kind: UploadKind } | { ok: false; reason: string };

/** Quantos bytes do inicio do arquivo `validateUpload` precisa para decidir o tipo. */
export const HEAD_BYTES = 64 * 1024;

const EXT: Record<string, UploadKind> = { pdf: 'pdf', docx: 'docx', txt: 'txt', md: 'md', markdown: 'md' };

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

function detect(head: Uint8Array): 'pdf' | 'docx' | 'text' | undefined {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    // zip: DOCX tem entradas "word/..." nos cabecalhos locais (shortcut: xlsx/pptx sao rejeitados, zip generico tambem)
    return Buffer.from(head).includes('word/', 0, 'latin1') ? 'docx' : undefined;
  }
  if (head.subarray(0, 8192).includes(0)) return undefined; // binario
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
    return 'text';
  } catch {
    // o corte em HEAD_BYTES pode partir um caractere multibyte ao meio; tolera so no final
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 3));
      return 'text';
    } catch {
      return undefined;
    }
  }
}

/**
 * Valida o tipo REAL (magic bytes) e o tamanho. O MIME declarado pelo cliente nao e confiado.
 * `head` = primeiros HEAD_BYTES do objeto; `size` = tamanho total em bytes.
 */
export function validateUpload(
  file: { filename: string; size: number; head: Uint8Array },
  opts: { maxBytes: number },
): UploadCheck {
  if (file.size <= 0) return { ok: false, reason: 'Arquivo vazio.' };
  if (file.size > opts.maxBytes) return { ok: false, reason: `Arquivo maior que ${opts.maxBytes} bytes.` };

  const ext = EXT[file.filename.split('.').pop()?.toLowerCase() ?? ''];
  if (!ext) return { ok: false, reason: 'Extensao nao suportada (use pdf, docx, txt ou md).' };

  const real = detect(file.head);
  if (!real) return { ok: false, reason: 'Conteudo nao corresponde a PDF, DOCX, TXT ou Markdown.' };

  const matches = real === 'text' ? ext === 'txt' || ext === 'md' : real === ext;
  if (!matches) return { ok: false, reason: `Extensao .${ext} nao corresponde ao conteudo (${real}).` };
  return { ok: true, kind: ext };
}
