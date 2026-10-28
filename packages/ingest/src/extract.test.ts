import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extract, extractHtml, extractMarkdown, fetchUrl } from './extract';
import { PermanentError } from './types';

const enc = (s: string) => new TextEncoder().encode(s);

/** PDF minimo com uma pagina por string (sem xref valido: o pdf.js reconstroi). */
function tinyPdf(pageTexts: string[]): Uint8Array {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pageTexts.forEach((t, i) => {
    const stream = `BT /F1 12 Tf 50 700 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let pdf = '%PDF-1.4\n';
  objs.forEach((o, i) => (pdf += `${i + 1} 0 obj\n${o}\nendobj\n`));
  return enc(`${pdf}trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\n%%EOF`);
}

async function tinyDocx(text: string): Promise<Uint8Array> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'uint8array' });
}

describe('extract', () => {
  it('PDF: uma entrada por pagina, com numero da pagina', async () => {
    const r = await extract(tinyPdf(['Primeira pagina', 'Segunda pagina']), 'application/pdf', 'a.pdf');
    expect(r.pageCount).toBe(2);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(r.pages[0]!.text).toContain('Primeira pagina');
    expect(r.pages[1]!.text).toContain('Segunda pagina');
  });

  it('PDF corrompido vira erro permanente', async () => {
    await expect(extract(enc('nao sou pdf'), 'application/pdf', 'x.pdf')).rejects.toBeInstanceOf(PermanentError);
  });

  it('DOCX', async () => {
    const r = await extract(await tinyDocx('Contrato de teste'), 'application/octet-stream', 'c.docx');
    expect(r.pages[0]!.text).toContain('Contrato de teste');
    expect(r.pages[0]!.page).toBeNull();
  });

  it('TXT e Markdown (mantem titulos, tira sintaxe inline)', async () => {
    const t = await extract(enc('﻿olá mundo'), 'text/plain', 'a.txt');
    expect(t.pages[0]!.text).toBe('olá mundo');
    const m = extractMarkdown(enc('---\na: 1\n---\n# Titulo\n\nVeja **isso** em [link](http://x.y) e `code`.\n\n```js\nignorado()\n```'));
    expect(m.pages[0]!.text).toContain('# Titulo');
    expect(m.pages[0]!.text).toContain('Veja isso em link e code.');
    expect(m.pages[0]!.text).not.toContain('ignorado');
  });

  it('HTML: Readability remove menu, script e rodape', () => {
    const body = '<p>Este e o conteudo principal do artigo, com texto suficiente para ser considerado relevante pelo algoritmo de leitura.</p>'.repeat(4);
    const html = `<html><head><title>Meu Artigo</title><script>var x=1</script></head><body><nav>MENU LATERAL</nav><article><h1>Meu Artigo</h1>${body}</article><footer>RODAPE LEGAL</footer></body></html>`;
    const r = extractHtml(html, 'https://exemplo.com/a');
    const text = r.pages[0]!.text;
    expect(text).toContain('conteudo principal');
    expect(text).not.toContain('MENU LATERAL');
    expect(text).not.toContain('var x=1');
  });

  it('tipo desconhecido e URL privada sao erros permanentes', async () => {
    await expect(extract(enc('x'), 'image/png', 'a.png')).rejects.toBeInstanceOf(PermanentError);
    await expect(fetchUrl('http://127.0.0.1:8080/x')).rejects.toBeInstanceOf(PermanentError);
    await expect(fetchUrl('file:///etc/passwd')).rejects.toBeInstanceOf(PermanentError);
  });
});
