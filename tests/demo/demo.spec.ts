import { expect, test } from '@playwright/test';
import { createCollectionWithDoc, goTo, newEmail, PERGUNTA, SENHA } from '../e2e/fixtures';

const pausa = (page: import('@playwright/test').Page, ms = 1200) => page.waitForTimeout(ms);

// Demo narrada pelo ritmo: landing -> cadastro -> colecao -> upload -> Pronto -> pergunta -> citacao -> fonte -> modo agente -> tema escuro.
test('demo do DocMind', async ({ page }) => {
  // esconde o selo do overlay de dev do Next (nao faz parte do produto)
  await page.addInitScript(() => {
    const st = document.createElement('style');
    st.textContent = 'nextjs-portal{display:none!important}';
    document.addEventListener('DOMContentLoaded', () => document.head.append(st));
  });
  await page.goto('/'); // landing publica
  await pausa(page, 2500);
  await page.getByRole('link', { name: 'Criar conta' }).first().click();
  await expect(page).toHaveURL(/\/register/);
  await pausa(page);
  await page.getByLabel('Nome', { exact: true }).pressSequentially('Ana Souza', { delay: 40 });
  await page.getByLabel('Nome da organização').pressSequentially('Acme', { delay: 40 });
  await page.getByLabel('E-mail').pressSequentially(newEmail(), { delay: 25 });
  await page.getByLabel('Senha (mínimo 8 caracteres)').pressSequentially(SENHA, { delay: 40 });
  await pausa(page, 600);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/collections$/, { timeout: 30_000 });
  await pausa(page);

  await createCollectionWithDoc(page, 'Políticas de RH'); // coleção, upload e espera pelo "Pronto"
  await pausa(page, 1800);

  await goTo(page, 'Chat');
  await pausa(page);
  await page.getByLabel('Mensagem').pressSequentially(PERGUNTA, { delay: 35 });
  await pausa(page, 500);
  await page.getByRole('button', { name: 'Enviar' }).click();
  const resposta = page.getByRole('log', { name: 'Conversa' }).getByRole('article', { name: 'Assistente' }).last();
  await expect(resposta).toContainText('30 dias', { timeout: 30_000 });
  await pausa(page, 1800);

  await page.getByRole('button', { name: 'Fonte 1' }).first().click();
  await expect(page.getByRole('complementary', { name: 'Fonte da citação' })).toBeVisible();
  await pausa(page, 2800);
  await page.keyboard.press('Escape');
  await pausa(page);

  // nova conversa em modo agente (POST /conversations/:id/messages {agent:true})
  await page.goto('/chat');
  await page.getByRole('checkbox', { name: 'Modo agente' }).check();
  await pausa(page, 800);
  const pergunta2 = 'Qual o prazo para pedir férias?';
  await page.getByLabel('Mensagem').pressSequentially(pergunta2, { delay: 35 });
  await page.getByRole('button', { name: 'Enviar' }).click();
  const passos = page.getByRole('list', { name: 'Passos do agente' });
  await expect(passos).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Fonte 1' }).first()).toBeVisible({ timeout: 30_000 });
  await pausa(page, 2800);

  const grupo = page.getByRole('group', { name: 'Avaliar resposta' });
  await grupo.getByRole('button', { name: 'Útil', exact: true }).click();
  await pausa(page, 1500);

  // tema escuro e historico: a conversa do agente aparece e reabre com a resposta
  await page.getByRole('button', { name: 'Tema escuro' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await pausa(page, 1800);
  await goTo(page, 'Conversas');
  await pausa(page, 1800);
  await page.getByRole('link', { name: new RegExp(pergunta2.slice(0, 20)) }).click();
  await expect(page.getByRole('log', { name: 'Conversa' }).getByRole('article', { name: 'Assistente' })).toContainText('30 dias');
  await pausa(page, 3500);
});
