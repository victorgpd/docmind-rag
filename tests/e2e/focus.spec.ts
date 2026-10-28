import { expect, test } from './fixtures';

// DESIGN.md: foco global :focus-visible, outline 2px --brand com offset. Navegando so por teclado, o elemento focado
// precisa ter contorno visivel (nao "none") em cada tela.
async function tabAteFocarTudo(page: import('@playwright/test').Page, max = 12) {
  const semContorno: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el.tagName === 'NEXTJS-PORTAL') return null; // overlay de dev do Next, nao e do app
      const cs = getComputedStyle(el);
      const visivel = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 || cs.boxShadow !== 'none';
      return { nome: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`, visivel };
    });
    if (r && !r.visivel) semContorno.push(r.nome);
  }
  return semContorno;
}

test('foco visivel por teclado: login', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  expect(await tabAteFocarTudo(page), 'elementos sem contorno de foco').toEqual([]);
});
