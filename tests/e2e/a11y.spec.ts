import { audit } from './a11y';
import { ask, createCollectionWithDoc, expect, goTo, openChat, register, test } from './fixtures';

test('a11y: landing em /', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Criar conta' }).first()).toBeVisible();
  await audit(page, 'landing', testInfo);
});

test('a11y: login', async ({ page }, testInfo) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await audit(page, 'login', testInfo);
});

test('a11y: documentos, chat, conversas e uso', async ({ page }, testInfo) => {
  await register(page);
  await createCollectionWithDoc(page);
  await audit(page, 'documentos', testInfo);

  await openChat(page);
  await audit(page, 'chat-vazio', testInfo); // Enviar desabilitado + perguntas sugeridas
  await ask(page);
  await page.getByRole('button', { name: 'Fonte 1' }).first().click();
  await expect(page.getByRole('complementary', { name: 'Fonte da citação' })).toBeVisible();
  await audit(page, 'chat', testInfo);

  await goTo(page, 'Conversas');
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0); // sem "Carregando…"
  await audit(page, 'conversas', testInfo);

  await goTo(page, 'Uso');
  await expect(page.getByRole('heading', { name: 'Uso' })).toBeVisible();
  await expect(page.getByText('Consultas', { exact: true })).toBeVisible();
  await audit(page, 'uso', testInfo);
});
