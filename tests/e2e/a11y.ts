import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from './fixtures';

/** Dono por tela, para o relatorio (quem corrige). */
const DONO: Record<string, string> = {
  landing: 'frontend (apps/web: landing)',
  login: 'frontend (apps/web: login/shell)',
  'chat-vazio': 'frontend (apps/web: chat, estado vazio e Enviar desabilitado)',
  documentos: 'frontend (apps/web: colecoes/documentos)',
  chat: 'frontend (apps/web: chat)',
  conversas: 'frontend (apps/web: conversas)',
  uso: 'frontend (apps/web: uso)',
};

/**
 * serious/critical (WCAG 2 A/AA) falham o teste; moderate/minor so entram no relatorio
 * test-results/a11y/<projeto>-<tela>.txt (e como anexo), com a tela e o dono.
 */
export async function audit(page: Page, tela: string, testInfo: TestInfo) {
  // a pagina pode navegar/re-renderizar durante a analise ("Execution context was destroyed"): tenta de novo
  const analisar = async (n = 3): Promise<Awaited<ReturnType<AxeBuilder['analyze']>>> => {
    await page.waitForLoadState('load');
    try {
      return await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    } catch (e) {
      if (n > 1 && /context was destroyed/i.test(String(e))) return analisar(n - 1);
      throw e;
    }
  };
  const { violations } = await analisar();
  const fmt = (v: (typeof violations)[number]) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}x) ${v.nodes[0]?.target.join(' ')} | ${v.nodes[0]?.html.slice(0, 160)} | ${(v.nodes[0]?.any[0]?.message ?? '').slice(0, 200)}`;
  const graves = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map(fmt);
  const leves = violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical').map(fmt);

  const relatorio = [`tela: ${tela} | projeto: ${testInfo.project.name} | dono: ${DONO[tela] ?? '?'}`, ...graves.map((g) => `GRAVE ${g}`), ...leves.map((l) => `LEVE ${l}`)].join('\n');
  const dir = join(testInfo.config.rootDir, '..', 'test-results', 'a11y');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${testInfo.project.name}-${tela}.txt`), relatorio);
  await testInfo.attach(`axe-${tela}.txt`, { body: relatorio, contentType: 'text/plain' });
  expect(graves, `acessibilidade (graves) em ${tela} [${testInfo.project.name}]`).toEqual([]);
}
