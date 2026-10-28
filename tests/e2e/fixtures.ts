import { expect, test as base, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export const FERIAS = fileURLToPath(new URL('../fixtures/ferias.txt', import.meta.url));
export const SENHA = 'senha-forte-123';
export const PERGUNTA = 'Quantos dias de ferias o colaborador tem direito?';

/** Toda pagina coleta violacoes de CSP (evento securitypolicyviolation e erros de console); o teste falha se houver. */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const found: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' && /content security policy/i.test(m.text())) found.push(`console: ${m.text()}`);
      });
      await page.exposeFunction('__reportCsp', (s: string) => found.push(s));
      await page.addInitScript(() =>
        document.addEventListener('securitypolicyviolation', (e) =>
          void (window as unknown as { __reportCsp: (s: string) => void }).__reportCsp(`${e.violatedDirective} bloqueou ${e.blockedURI || 'inline'} em ${e.documentURI}`),
        ),
      );
      await use(found);
      expect(found, 'violacoes de CSP').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export const newEmail = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

export async function register(page: Page, email = newEmail()) {
  await page.goto('/register');
  await page.getByLabel('Nome', { exact: true }).fill('Ana');
  await page.getByLabel('Nome da organização').fill('Acme');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha (mínimo 8 caracteres)').fill(SENHA);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/collections$/, { timeout: 30_000 }); // 1a visita compila a rota antd no next dev
  return email;
}

export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(SENHA);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/collections$/);
}

/** Cria a colecao, envia ferias.txt e espera "Pronto". Termina na pagina de detalhe da colecao. */
export async function createCollectionWithDoc(page: Page, name = 'RH') {
  // redesign: "Nova coleção" passou de formulário inline para botão que abre um dialog (mesmos campos e botão final)
  const novo = page.getByRole('button', { name: 'Nova coleção' });
  if (await novo.isVisible()) await novo.click();
  await page.getByLabel('Nome da coleção').fill(name);
  await page.getByRole('button', { name: 'Criar coleção' }).click();
  await page.getByRole('link', { name }).click();
  await page.getByLabel('Arquivos para enviar').setInputFiles(FERIAS);
  const doc = page.getByRole('listitem').filter({ hasText: 'ferias.txt' });
  try {
    await expect(doc.getByRole('status')).toHaveText('Pronto', { timeout: 60_000 });
  } catch (e) {
    throw new Error(`documento nao ficou "Pronto". ${await estadoDoDocumento(page)}
${e instanceof Error ? e.message : e}`);
  }
}

/** Diagnostico de flake: status mostrado na UI x status real na API (via refresh token do cookie). */
async function estadoDoDocumento(page: Page) {
  const ui = await page.getByRole('listitem').filter({ hasText: 'ferias.txt' }).getByRole('status').textContent().catch(() => '(indisponivel)');
  try {
    const { token } = (await (await page.request.post('/api/v1/auth/refresh')).json()) as { token: string };
    const lista = (await (await page.request.get('/api/v1/documents', { headers: { authorization: `Bearer ${token}` } })).json()) as { items: { filename: string; status: string; error?: string | null }[] };
    return `UI="${ui}" API=${JSON.stringify(lista.items.map((d) => ({ f: d.filename, status: d.status, error: d.error })))}`;
  } catch (err) {
    return `UI="${ui}" API=(falha ao consultar: ${err})`;
  }
}

/** Navega pelo menu principal; no mobile o menu fica atras do botao "Menu". */
export async function goTo(page: Page, link: 'Coleções' | 'Chat' | 'Conversas' | 'Uso') {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) {
    if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
  }
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: link }).click();
}

export const openChat = (page: Page) => goTo(page, 'Chat');

export async function ask(page: Page, question = PERGUNTA) {
  await page.getByLabel('Mensagem').fill(question);
  await page.getByRole('button', { name: 'Enviar' }).click();
  const resposta = page.getByRole('log', { name: 'Conversa' }).getByRole('article', { name: 'Assistente' }).last();
  await expect(resposta).toContainText('30 dias', { timeout: 30_000 });
  return resposta;
}
