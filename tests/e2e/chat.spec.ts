import { ask, createCollectionWithDoc, expect, goTo, login, openChat, PERGUNTA, register, test } from './fixtures';

test('fluxo feliz: cadastro -> upload -> pergunta -> citacao (sem violacao de CSP)', async ({ page }) => {
  await register(page);
  await createCollectionWithDoc(page);
  await openChat(page);
  await ask(page);

  await page.getByRole('button', { name: 'Fonte 1' }).first().click();
  const fonte = page.getByRole('complementary', { name: 'Fonte da citação' });
  await expect(fonte).toContainText('ferias.txt');
  await expect(fonte.getByRole('blockquote')).toContainText('30 dias');
});

test('credenciais invalidas mostram alerta', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill('nao-existe@example.com');
  await page.getByLabel('Senha').fill('qualquer-senha');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('modo agente: passos, resposta com citacao, feedback e historico', async ({ page }) => {
  await register(page);
  await createCollectionWithDoc(page);
  await openChat(page);
  await page.getByRole('checkbox', { name: 'Modo agente' }).check();
  await ask(page);

  const passos = page.getByRole('list', { name: 'Passos do agente' });
  await expect(passos.getByRole('listitem').first()).toBeVisible();
  await expect(passos).toContainText('Plano:');
  await expect(passos).toContainText('Ferramenta');
  await expect(page.getByRole('button', { name: 'Fonte 1' }).first()).toBeVisible();

  // Util/Nao util so aparecem depois do evento done
  const grupo = page.getByRole('group', { name: 'Avaliar resposta' });
  await grupo.getByRole('button', { name: 'Útil', exact: true }).click();
  await expect(grupo.getByRole('button', { name: 'Útil', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // a conversa entra no historico e reabrir mostra a resposta persistida
  await goTo(page, 'Conversas');
  await page.getByRole('link', { name: new RegExp(PERGUNTA.slice(0, 30)) }).click();
  await expect(page.getByRole('log', { name: 'Conversa' }).getByRole('article', { name: 'Assistente' })).toContainText('30 dias');
});

test('feedback util / nao util fica marcado (aria-pressed)', async ({ page }) => {
  await register(page);
  await createCollectionWithDoc(page);
  await openChat(page);
  await ask(page);
  const grupo = page.getByRole('group', { name: 'Avaliar resposta' });
  await grupo.getByRole('button', { name: 'Útil', exact: true }).click();
  await expect(grupo.getByRole('button', { name: 'Útil', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await grupo.getByRole('button', { name: 'Não útil' }).click();
  await expect(grupo.getByRole('button', { name: 'Não útil' })).toHaveAttribute('aria-pressed', 'true');
});

test('logout, novo login e historico de conversas persistido', async ({ page }) => {
  const email = await register(page);
  await createCollectionWithDoc(page);
  await openChat(page);
  await ask(page);

  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/collections');
  await expect(page).toHaveURL(/\/login/); // sessao encerrada: rota protegida redireciona

  await login(page, email);
  await goTo(page, 'Conversas');
  await page.getByRole('link', { name: new RegExp(PERGUNTA.slice(0, 30)) }).click();
  const log = page.getByRole('log', { name: 'Conversa' });
  await expect(log.getByRole('article', { name: 'Você' })).toContainText('ferias');
  await expect(log.getByRole('article', { name: 'Assistente' })).toContainText('30 dias');
});
