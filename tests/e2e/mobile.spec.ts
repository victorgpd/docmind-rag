import { audit } from './a11y';
import { ask, createCollectionWithDoc, expect, login, newEmail, openChat, register, test } from './fixtures';

// Roda so no projeto "mobile" (390x844).
test('mobile: menu utilizavel, login -> documentos -> chat, com axe', async ({ page }, testInfo) => {
  await page.goto('/login');
  await audit(page, 'login', testInfo);

  const email = newEmail();
  await register(page, email);
  await page.getByRole('button', { name: 'Menu', exact: true }).click(); // "Sair" fica no cartao do usuario, dentro do Drawer
  await page.getByRole('button', { name: 'Sair' }).click();
  await login(page, email);

  // menu: fechado por padrao, abre com aria-expanded, links acessiveis e visiveis dentro do viewport
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  const nav = page.getByRole('navigation', { name: 'Principal' });
  for (const nome of ['Coleções', 'Chat', 'Conversas', 'Uso']) {
    // o Drawer desliza para dentro: espera a transicao terminar antes de medir
    const link = nav.getByRole('link', { name: nome });
    await expect.poll(async () => (await link.boundingBox())?.x ?? -1, { message: `link ${nome} dentro do viewport` }).toBeGreaterThanOrEqual(0);
    const box = (await link.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }

  // o menu e um Drawer modal: precisa fechar com Esc (devolvendo o foco ao botao) antes de usar a pagina
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  await createCollectionWithDoc(page);
  // sem scroll horizontal
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await audit(page, 'documentos', testInfo);

  await openChat(page);
  await ask(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await audit(page, 'chat', testInfo);
});
