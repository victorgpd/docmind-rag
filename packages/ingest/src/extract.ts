import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { safeFetchText } from './safe-fetch';
import { DEFAULT_LIMITS, PermanentError, type Extracted, type IngestLimits } from './types';

export type SourceKind = 'pdf' | 'docx' | 'md' | 'txt' | 'html' | 'url';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** mimeType 'text/x-url': o objeto no storage contem a URL (texto); o worker baixa e extrai. */
export function detectKind(mimeType: string, filename: string): SourceKind {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const m = mimeType.toLowerCase();
  if (m === 'text/x-url') return 'url';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m === DOCX_MIME || ext === 'docx') return 'docx';
  if (m === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'md';
  if (m === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (m === 'text/plain' || ext === 'txt') return 'txt';
  throw new PermanentError(`Tipo de arquivo nao suportado: ${mimeType || ext}`, 'unsupported_type');
}

const decode = (b: Uint8Array) => new TextDecoder('utf-8').decode(b).replace(new RegExp('^﻿'), '');

export async function extractPdf(data: Uint8Array, limits: Pick<IngestLimits, 'maxPages'> = DEFAULT_LIMITS): Promise<Extracted> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (e) {
    throw new PermanentError(`PDF invalido: ${e instanceof Error ? e.message : e}`, 'corrupt_file');
  }
  if (pdf.numPages > limits.maxPages) throw new PermanentError(`PDF com ${pdf.numPages} paginas (limite ${limits.maxPages})`, 'too_large');
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { pageCount: totalPages, pages: text.map((t, i) => ({ page: i + 1, text: t })) };
}

/**
 * Soma os tamanhos descomprimidos declarados no diretorio central do ZIP, sem descomprimir nada.
 * shortcut: confia no tamanho declarado; o JSZip (usado pelo mammoth) falha se o fluxo real divergir dele, mas ja pode ter inflado ate la.
 */
export function zipUncompressedSize(data: Uint8Array): number {
  const bad = () => new PermanentError('DOCX/ZIP invalido', 'corrupt_file');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const entries = v.getUint16(eocd + 10, true);
  let pos = v.getUint32(eocd + 16, true);
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > data.length || v.getUint32(pos, true) !== 0x02014b50) throw bad();
    const size = v.getUint32(pos + 24, true);
    if (size === 0xffffffff) throw new PermanentError('ZIP64 nao suportado', 'unsafe_file');
    total += size;
    pos += 46 + v.getUint16(pos + 28, true) + v.getUint16(pos + 30, true) + v.getUint16(pos + 32, true);
  }
  return total;
}

export async function extractDocx(data: Uint8Array, limits: Pick<IngestLimits, 'maxDocxBytes' | 'maxDocxRatio'> = DEFAULT_LIMITS): Promise<Extracted> {
  const total = zipUncompressedSize(data);
  if (total > limits.maxDocxBytes) throw new PermanentError(`DOCX descomprime para ${total} bytes (limite ${limits.maxDocxBytes})`, 'unsafe_file');
  if (total > 1024 * 1024 && total / data.length > limits.maxDocxRatio) {
    throw new PermanentError(`DOCX com razao de compressao ${Math.round(total / data.length)}:1 (limite ${limits.maxDocxRatio})`, 'unsafe_file');
  }
  try {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { pageCount: null, pages: [{ page: null, text: value }] };
  } catch (e) {
    throw new PermanentError(`DOCX invalido: ${e instanceof Error ? e.message : e}`, 'corrupt_file');
  }
}

export const extractTxt = (data: Uint8Array): Extracted => ({ pageCount: null, pages: [{ page: null, text: decode(data) }] });

/** Mantem os titulos (#) que o chunker usa; remove sintaxe inline, front matter e blocos de codigo cercados. */
export function extractMarkdown(data: Uint8Array): Extracted {
  const text = decode(data)
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '');
  return { pageCount: null, pages: [{ page: null, text }] };
}

/** HTML -> texto principal via Readability (remove menus, scripts, rodapes). */
export function extractHtml(html: string, url?: string): Extracted {
  const { document } = parseHTML(html);
  if (url) Object.defineProperty(document, 'documentURI', { value: url }); // linkedom nao define; Readability le
  const article = new Readability(document as never).parse();
  const body = article?.textContent?.trim();
  if (!body) throw new PermanentError('Nao foi possivel extrair o conteudo principal da pagina', 'no_text');
  const title = article?.title?.trim();
  return { pageCount: null, title, pages: [{ page: null, text: title ? `# ${title}\n\n${body}` : body }] };
}

export { safeFetchText as fetchUrl, isBlockedIp } from './safe-fetch';

/** Ponto unico: bytes do storage + metadados do documento -> texto por pagina. */
export async function extract(data: Uint8Array, mimeType: string, filename: string, limits: IngestLimits = DEFAULT_LIMITS): Promise<Extracted> {
  switch (detectKind(mimeType, filename)) {
    case 'pdf':
      return extractPdf(data, limits);
    case 'docx':
      return extractDocx(data, limits);
    case 'md':
      return extractMarkdown(data);
    case 'txt':
      return extractTxt(data);
    case 'html':
      return extractHtml(decode(data));
    case 'url': {
      const url = decode(data).trim();
      return extractHtml(await safeFetchText(url), url);
    }
  }
}
