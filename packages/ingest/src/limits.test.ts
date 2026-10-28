import { LocalProvider } from '@docmind/llm';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { errorCode, extract, ingest, userMessage, USER_MESSAGES, zipUncompressedSize } from './index';
import { PermanentError } from './types';

const enc = (s: string) => new TextEncoder().encode(s);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const llm = new LocalProvider();

function pdfPages(n: number): Uint8Array {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  objs.push(`<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < n; i++) {
    const stream = `BT /F1 12 Tf 50 700 Td (${['alfa bravo', 'charlie delta', 'echo foxtrot', 'golf hotel'][i % 4]} ${i}x) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  objs.forEach((o, i) => (pdf += `${i + 1} 0 obj\n${o}\nendobj\n`));
  return enc(`${pdf}trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\n%%EOF`);
}

/** DOCX valido cujo document.xml tem `fillerBytes` de texto repetido (comprime ~1000:1 = bomba). */
async function docx(fillerBytes: number): Promise<Uint8Array> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${'a'.repeat(fillerBytes)}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(PermanentError);
  expect(errorCode(e)).toBe(code);
};

describe('limites de expansao', () => {
  it('PDF com paginas demais', async () => {
    await rejects(ingest({ data: pdfPages(3), mimeType: 'application/pdf', filename: 'a.pdf' }, llm, { limits: { maxPages: 2 } }), 'too_large');
    const ok = await ingest({ data: pdfPages(3), mimeType: 'application/pdf', filename: 'a.pdf' }, llm, { limits: { maxPages: 3 } });
    expect(ok.pageCount).toBe(3);
  });

  it('DOCX bomba: bytes descomprimidos acima do teto', async () => {
    const bomb = await docx(5 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(50 * 1024); // pequeno em disco...
    expect(zipUncompressedSize(bomb)).toBeGreaterThan(5 * 1024 * 1024); // ...grande descomprimido
    await rejects(extract(bomb, DOCX, 'b.docx', { maxPages: 1, maxChunks: 1, maxDocxBytes: 2 * 1024 * 1024, maxDocxRatio: 1e9 }), 'unsafe_file');
  });

  it('DOCX bomba: razao de compressao acima do teto (com teto de bytes folgado)', async () => {
    const bomb = await docx(3 * 1024 * 1024);
    await rejects(ingest({ data: bomb, mimeType: DOCX, filename: 'b.docx' }, llm), 'unsafe_file'); // defaults: 100 MB e 100:1
  });

  it('DOCX pequeno e legitimo passa mesmo com razao alta (piso de 1 MB)', async () => {
    const r = await ingest({ data: await docx(20_000), mimeType: DOCX, filename: 'ok.docx' }, llm);
    expect(r.chunks.length).toBeGreaterThan(0);
  });

  it('ZIP invalido ou truncado vira corrupt_file', async () => {
    await rejects(extract(enc('isto nao e um zip'), DOCX, 'x.docx'), 'corrupt_file');
    const z = await docx(1000);
    await rejects(extract(z.slice(0, z.length - 30), DOCX, 'x.docx'), 'corrupt_file');
  });

  it('chunks por documento', async () => {
    const text = Array.from({ length: 200 }, (_, i) => `Paragrafo ${i} ${'palavra '.repeat(60)}`).join('\n\n');
    await rejects(ingest({ data: enc(text), mimeType: 'text/plain', filename: 'g.txt' }, llm, { limits: { maxChunks: 3 } }), 'too_large');
  });

  it('tempo por job: signal abortado interrompe com timeout', async () => {
    const ac = new AbortController();
    ac.abort();
    await rejects(ingest({ data: enc('algum texto'), mimeType: 'text/plain', filename: 't.txt' }, llm, { signal: ac.signal }), 'timeout');
  });
});

describe('mensagens ao usuario', () => {
  it('cada categoria tem texto controlado, sem vazar o detalhe tecnico', async () => {
    const cases: [Promise<unknown>, keyof typeof USER_MESSAGES][] = [
      [extract(enc('x'), 'image/png', 'segredo-interno.png'), 'unsupported_type'],
      [extract(enc('nao e pdf'), 'application/pdf', 'x.pdf'), 'corrupt_file'],
      [ingest({ data: enc(' '), mimeType: 'text/plain', filename: 'v.txt' }, llm), 'no_text'],
      [import('./safe-fetch').then((m) => m.safeFetchText('http://169.254.169.254/latest/meta-data/')), 'url_blocked'],
    ];
    for (const [p, code] of cases) {
      const e = await p.then(() => null, (x) => x);
      expect(errorCode(e)).toBe(code);
      expect(userMessage(e)).toBe(USER_MESSAGES[code]);
      expect(userMessage(e)).not.toMatch(/segredo-interno|169\.254|png|\.pdf/);
    }
    expect(userMessage(new Error('ENOENT: /srv/data/storage/org/doc.pdf'))).toBe(USER_MESSAGES.internal);
  });
});
