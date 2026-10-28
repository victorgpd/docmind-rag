import { expect, register, test } from './fixtures';

test('colecoes: criar, editar e excluir pelos dialogs', async ({ page }) => {
  await register(page);

  await page.getByRole('button', { name: 'Nova coleção' }).click();
  const novo = page.getByRole('dialog', { name: 'Nova coleção' });
  await novo.getByLabel('Nome da coleção').fill('RH');
  await novo.getByLabel('Descrição (opcional)').fill('Politicas internas');
  await novo.getByRole('button', { name: 'Criar coleção' }).click();
  await expect(page.getByRole('link', { name: 'RH' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Coleção criada' })).toBeVisible();

  await page.getByRole('button', { name: 'Editar RH' }).click();
  const edit = page.getByRole('dialog', { name: 'Editar RH' });
  await edit.getByLabel('Nome', { exact: true }).fill('RH 2');
  await edit.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByRole('link', { name: 'RH 2' })).toBeVisible();

  // cancelar nao exclui
  await page.getByRole('button', { name: 'Excluir RH 2' }).click();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('link', { name: 'RH 2' })).toBeVisible();

  await page.getByRole('button', { name: 'Excluir RH 2' }).click();
  await expect(page.getByRole('dialog')).toContainText('RH 2');
  await page.getByRole('button', { name: 'Confirmar exclusão' }).click();
  await expect(page.getByRole('link', { name: 'RH 2' })).toHaveCount(0);
});
