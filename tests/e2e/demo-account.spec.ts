import { ask, expect, goTo, test } from './fixtures';

// A API do E2E sobe com DEMO_LOGIN_ENABLED=true (playwright.config.ts): com PGlite ela mesma prepara a conta e ingere os documentos no boot.
test('conta de demonstracao: um clique -> pergunta -> resposta com citacao; escritas desabilitadas', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Testar sem cadastro' })).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'GitHub' }).first()).toBeVisible();
  await expect(page.locator('a[href="https://github.com/victorgpd/docmind-rag"]').first()).toBeAttached(); // rodape (e topo no desktop)

  const medidos = page.getByRole('region', { name: 'Resultados medidos' });
  await expect(medidos.getByRole('heading', { name: 'Resultados medidos', level: 2 })).toBeVisible();
  for (const t of ['89%', '61%', '0,74', 'recall@5']) await expect(medidos).toContainText(t);
  await expect(medidos.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', /\/tree\/main\/evals/);

  await expect(page.getByText('Feito por')).toBeVisible();
  const linkedin = page.getByRole('link', { name: 'LinkedIn de Victor Guilherme' });
  await expect(linkedin).toHaveAttribute('href', 'https://www.linkedin.com/in/victorgpd/');
  await expect(linkedin).toHaveAttribute('target', '_blank');
  await expect(linkedin).toHaveAttribute('rel', /noopener/);

  // 2 CTAs no desktop (cabecalho + hero), so o do hero no mobile: o primeiro serve nos dois
  await page.getByRole('button', { name: 'Testar sem cadastro' }).first().click();
  await expect(page).toHaveURL(/\/collections$/, { timeout: 30_000 });
  await expect(page.getByText('Você está na conta de demonstração (somente leitura)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nova coleção' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Código no GitHub' })).toBeVisible();

  await page.getByRole('link', { name: 'Políticas da empresa (exemplo)' }).click();
  const ferias = page.getByRole('listitem').filter({ hasText: 'politica-ferias.md' });
  await expect(ferias.getByRole('status')).toHaveText('Pronto', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Escolher arquivos' })).toBeDisabled();
  await expect(ferias.getByRole('button', { name: 'Excluir politica-ferias.md' })).toBeDisabled();

  await goTo(page, 'Chat');
  await ask(page, 'Quantos dias de férias o colaborador tem direito?');
  await page.getByRole('button', { name: 'Fonte 1' }).first().click();
  const fonte = page.getByRole('complementary', { name: 'Fonte da citação' });
  await expect(fonte).toContainText('politica-ferias.md');
  await expect(fonte.getByRole('blockquote')).toContainText('30 dias');
});
