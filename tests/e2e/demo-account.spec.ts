import { ask, expect, goTo, test } from './fixtures';

// A API do E2E sobe com DEMO_LOGIN_ENABLED=true (playwright.config.ts): com PGlite ela mesma prepara a conta e ingere os documentos no boot.
test('conta de demonstracao: um clique -> pergunta -> resposta com citacao; escritas desabilitadas', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Experimentar a demonstração' })).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: 'Experimentar a demonstração' }).click();
  await expect(page).toHaveURL(/\/collections$/, { timeout: 30_000 });
  await expect(page.getByText('Você está na conta de demonstração (somente leitura)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nova coleção' })).toBeDisabled();

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
