import { LocalProvider } from '@docmind/llm';
import JSZip from 'jszip';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract, ingest } from './index';

// PDF real: a propria spec do projeto, na raiz do monorepo (10 paginas, gerado pelo Notion).
const root = join(__dirname, '../../..');
const pdfName = existsSync(root) ? readdirSync(root).find((f) => f.toLowerCase().endsWith('.pdf')) : undefined;

describe.skipIf(!pdfName)('PDF real (spec do projeto)', () => {
  const data = () => new Uint8Array(readFileSync(join(root, pdfName!)));

  it('extrai todas as paginas e remove cabecalho/rodape repetidos dos chunks', async () => {
    const r = await ingest({ data: data(), mimeType: 'application/pdf', filename: 'spec.pdf' }, new LocalProvider());
    expect(r.pageCount).toBe(10);
    expect(r.chunks.length).toBeGreaterThan(3);
    const all = r.chunks.map((c) => c.content).join('\n');
    expect(all).not.toMatch(/Page \d+ of 10/);
    expect(all).not.toContain('Assistente de Documentos com IA -- Escopo do Projeto');
    expect(r.chunks.map((c) => c.ordinal)).toEqual(r.chunks.map((_, i) => i));
    for (const c of r.chunks) {
      expect(c.page).toBeGreaterThanOrEqual(1);
      expect(c.page).toBeLessThanOrEqual(10);
      expect(c.embedding).toHaveLength(384);
    }
  });

  it('a pagina do chunk e a pagina onde o trecho comeca (ou a anterior, se o chunk atravessa)', async () => {
    const ex = await extract(data(), 'application/pdf', 'spec.pdf');
    const pageOf = (needle: string) => ex.pages.find((p) => p.text.includes(needle))!.page!;
    const r = await ingest({ data: data(), mimeType: 'application/pdf', filename: 'spec.pdf' }, new LocalProvider());
    for (const needle of ['Cronograma de 10 dias', 'Pipeline de RAG avan', 'Modelo de dados']) {
      const real = pageOf(needle);
      const chunk = r.chunks.find((c) => c.content.includes(needle));
      expect(chunk, needle).toBeDefined();
      expect(chunk!.page!, needle).toBeLessThanOrEqual(real);
      expect(chunk!.page!, needle).toBeGreaterThanOrEqual(real - 2);
    }
    expect(Math.max(...r.chunks.map((c) => c.page!))).toBeGreaterThanOrEqual(8); // chunks cobrem o fim do documento
  });
});

async function docx(paragraphs: string[]): Promise<Uint8Array> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return z.generateAsync({ type: 'uint8array' });
}

describe('DOCX gerado no teste', () => {
  it('vira varios chunks; DOCX nao tem paginacao, entao page e null; texto e ordem preservados', async () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Clausula ${i + 1}: o contratante pagara o valor acordado em ate ${i + 5} dias uteis apos a emissao da nota fiscal correspondente.`);
    const r = await ingest({ data: await docx(paras), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'contrato.docx' }, new LocalProvider());
    expect(r.pageCount).toBeNull();
    expect(r.chunks.length).toBeGreaterThan(1);
    for (const c of r.chunks) expect(c.page).toBeNull();
    const text = r.chunks.map((c) => c.content).join('\n');
    expect(text.indexOf('Clausula 1:')).toBeLessThan(text.indexOf('Clausula 30:'));
    expect(r.chunks[0]!.context).toContain('contrato.docx');
  });
});
