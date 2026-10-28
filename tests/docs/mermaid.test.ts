import { chromium } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mermaidJs = fileURLToPath(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url));

function mdFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? mdFiles(p) : p.endsWith('.md') ? [p] : [];
  });
}

type Block = { file: string; line: number; code: string };

/** Blocos ```mermaid de README.md e docs/**; `line` e a linha da cerca de abertura (1-based). */
function blocks(): Block[] {
  const files = [join(root, 'README.md'), ...mdFiles(join(root, 'docs'))].filter(existsSync);
  const out: Block[] = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*```mermaid\s*$/.test(lines[i]!)) continue;
      const end = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
      out.push({ file: relative(root, f).split('\\').join('/'), line: i + 1, code: lines.slice(i + 1, end === -1 ? undefined : end).join('\n') });
    }
  }
  return out;
}

it('todos os blocos mermaid de README.md e docs/ parseiam e renderizam', async () => {
  const all = blocks();
  expect(all.length, 'nenhum bloco mermaid encontrado').toBeGreaterThan(0);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="out"></div>');
    await page.addScriptTag({ path: mermaidJs }); // local, sem CDN
    await page.evaluate(() => (window as any).mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }));

    const invalidos: string[] = [];
    for (const [i, b] of all.entries()) {
      const erro = await page.evaluate(
        async ({ code, id }) => {
          const m = (window as any).mermaid;
          try {
            await m.parse(code);
            await m.render(`m${id}`, code);
            return null;
          } catch (e) {
            return String((e as Error).message ?? e);
          }
        },
        { code: b.code, id: i },
      );
      if (erro) {
        // "Parse error on line N" e relativo ao bloco: soma a linha da cerca para apontar no arquivo
        const rel = /line (\d+)/i.exec(erro)?.[1];
        const onde = rel ? `${b.file}:${b.line + Number(rel)}` : `${b.file}:${b.line}`;
        invalidos.push(`${onde} (bloco em ${b.file}:${b.line}): ${erro.split('\n').slice(0, 3).join(' | ')}`);
      }
    }
    expect(invalidos, `blocos mermaid invalidos:\n${invalidos.join('\n')}`).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
