import { spawnSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SENHA } from './fixtures';

// Video de ~2 min para README/LinkedIn: so roda via `pnpm --filter @docmind/tests video` (playwright.video.config.ts).
// Sem narracao: legendas curtas (1 frase por cena) e um cursor desenhado na pagina, porque o video do Playwright nao mostra o mouse.

const arq = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DOCS = ['../../scripts/demo-docs/politica-ferias.md', '../../scripts/demo-docs/contrato-servicos.md', '../../evals/agent/corpus/tabela-precos.md'].map(arq);
const OUT = { webm: arq('../../docs/demo/docmind-2min.webm'), mp4: arq('../../docs/demo/docmind-2min.mp4'), gif: arq('../../docs/demo/docmind-demo.gif') };
const PERGUNTA = 'Quantos dias de férias o colaborador tem direito?';

/** Roda em todo documento: legenda fixa (texto em sessionStorage, sobrevive a recarregar) e cursor que segue o mouse. */
function overlay() {
  const css = `nextjs-portal{display:none!important}
#dm-legenda{position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:2147483646;max-width:calc(100vw - 32px);padding:6px 16px;border-radius:10px;
background:rgba(15,23,42,.84);border:1px solid rgba(255,255,255,.14);color:#fff;font:500 17px/22px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
white-space:nowrap;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.25);transition:opacity .3s}
#dm-legenda:empty{opacity:0}
#dm-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
.dm-clique{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #7c3aed;pointer-events:none;z-index:2147483646;animation:dm-clique .5s ease-out forwards}
@keyframes dm-clique{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}`;
  const pos = () => (sessionStorage.getItem('dm-xy') ?? '640,360').split(',').map(Number) as [number, number];
  const mover = (el: HTMLElement, [x, y]: [number, number]) => (el.style.transform = `translate(${x}px,${y}px)`);
  const garantir = () => {
    if (!document.body) return;
    if (!document.getElementById('dm-estilo')) document.head.append(Object.assign(document.createElement('style'), { id: 'dm-estilo', textContent: css }));
    const legenda = document.getElementById('dm-legenda') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'dm-legenda' }));
    const texto = sessionStorage.getItem('dm-legenda') ?? '';
    if (legenda.textContent !== texto) legenda.textContent = texto;
    if (!document.getElementById('dm-cursor')) {
      const c = Object.assign(document.createElement('div'), { id: 'dm-cursor' });
      c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#111827" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      mover(c, pos());
      document.body.appendChild(c);
    }
  };
  setInterval(garantir, 100); // a hidratacao do React ou uma navegacao podem remover os elementos
  document.addEventListener('mousemove', (e) => {
    sessionStorage.setItem('dm-xy', `${e.clientX},${e.clientY}`);
    const c = document.getElementById('dm-cursor');
    if (c) mover(c, [e.clientX, e.clientY]);
  }, true);
  document.addEventListener('mousedown', (e) => {
    const r = Object.assign(document.createElement('div'), { className: 'dm-clique' });
    r.style.left = `${e.clientX}px`;
    r.style.top = `${e.clientY}px`;
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 600);
  }, true);
}

const CARTELA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>DocMind</title><style>
#dm-cursor,#dm-legenda{display:none!important}
body{margin:0;height:100vh;display:grid;place-items:center;text-align:center;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background:radial-gradient(ellipse 70% 60% at 50% 0%,#4f46e5 0%,#1e1b4b 55%,#0b0d14 100%)}
h1{margin:0;font-size:96px;letter-spacing:-3px}
.sub{margin:10px 0 40px;font-size:30px;opacity:.92}
.url{display:inline-block;padding:10px 22px;border-radius:12px;background:rgba(255,255,255,.1);font-size:30px;font-weight:600;color:#c7d2fe}
.stack{margin-top:34px;font-size:22px;opacity:.75}
</style></head><body><main><h1>DocMind</h1><p class="sub">Pergunte aos seus documentos. Com fontes.</p>
<p class="url">https://docmind.nexuscrmm.com</p><p class="stack">Next.js · Express · Postgres/pgvector · OpenAI</p></main></body></html>`;

const pausa = (page: Page, ms = 1500) => page.waitForTimeout(ms);
const legenda = (page: Page, texto: string) =>
  page.evaluate((t) => {
    sessionStorage.setItem('dm-legenda', t);
    const l = document.getElementById('dm-legenda');
    if (l) l.textContent = t;
  }, texto);

let mouse = { x: 640, y: 360 };
/** Leva o mouse ate o centro do alvo em ~0,5 s (o cursor desenhado acompanha). */
async function apontar(page: Page, alvo: Locator) {
  await alvo.scrollIntoViewIfNeeded();
  const b = (await alvo.boundingBox())!;
  const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  for (let i = 1; i <= 22; i++) {
    const k = 1 - (1 - i / 22) ** 3; // ease-out
    await page.mouse.move(mouse.x + (to.x - mouse.x) * k, mouse.y + (to.y - mouse.y) * k);
    await page.waitForTimeout(12);
  }
  mouse = to;
  await page.waitForTimeout(150);
}
async function clicar(page: Page, alvo: Locator) {
  await apontar(page, alvo);
  await alvo.click();
}
async function digitar(page: Page, campo: Locator, texto: string, delay = 45) {
  await clicar(page, campo);
  await campo.pressSequentially(texto, { delay });
}
const menu = (page: Page, link: 'Chat' | 'Conversas' | 'Uso') => clicar(page, page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: link }));

async function perguntar(page: Page, texto: string) {
  await digitar(page, page.getByLabel('Mensagem'), texto, 38);
  await pausa(page, 400);
  await clicar(page, page.getByRole('button', { name: 'Enviar' }));
}
/** Espera a n-esima resposta terminar (botoes de avaliacao aparecem) rolando a conversa junto com o streaming. */
async function resposta(page: Page, n: number) {
  const log = page.getByRole('log', { name: 'Conversa' });
  const rolar = () => log.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
  await expect(async () => {
    await rolar();
    expect(await page.getByRole('group', { name: 'Avaliar resposta' }).count()).toBeGreaterThanOrEqual(n);
  }).toPass({ timeout: 60_000, intervals: [250] });
  await rolar();
  return log.getByRole('article', { name: 'Assistente' }).nth(n - 1);
}

test('video de 2 minutos', async ({ page }) => {
  const t0 = Date.now();
  const marcas: Record<string, number> = {};
  const marca = (k: string) => (marcas[k] = Math.round((Date.now() - t0) / 100) / 10);
  await page.addInitScript(overlay);

  // 1. landing publica
  await page.goto('/');
  await legenda(page, 'DocMind: pergunte aos seus documentos e receba respostas com fontes.');
  await pausa(page, 4500);
  await page.evaluate(() => window.scrollTo({ top: 430, behavior: 'smooth' }));
  await pausa(page, 3000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await pausa(page, 1000);

  // 2. cadastro (e-mail ficticio)
  marca('cadastro');
  await clicar(page, page.getByRole('link', { name: 'Criar conta' }).first());
  await expect(page).toHaveURL(/\/register/);
  await legenda(page, 'Crie uma conta em poucos segundos.');
  await pausa(page, 1000);
  await digitar(page, page.getByLabel('Nome', { exact: true }), 'Ana Souza');
  await digitar(page, page.getByLabel('Nome da organização'), 'Acme');
  await digitar(page, page.getByLabel('E-mail'), 'ana@exemplo.com', 35);
  await digitar(page, page.getByLabel('Senha (mínimo 8 caracteres)'), SENHA, 35);
  await pausa(page, 700);
  await clicar(page, page.getByRole('button', { name: 'Criar conta' }));
  await expect(page).toHaveURL(/\/collections$/, { timeout: 30_000 });

  // 3. colecao
  marca('colecao');
  await legenda(page, 'Organize seus arquivos em coleções.');
  await pausa(page, 1500);
  await clicar(page, page.getByRole('button', { name: 'Nova coleção' }).first());
  await digitar(page, page.getByLabel('Nome da coleção'), 'Documentos da Acme');
  await digitar(page, page.getByLabel('Descrição (opcional)'), 'Políticas, contratos e preços', 30);
  await pausa(page, 600);
  await clicar(page, page.getByRole('button', { name: 'Criar coleção' }));
  await pausa(page, 1500);
  await clicar(page, page.getByRole('link', { name: 'Documentos da Acme' }));

  // 4. upload de 3 documentos de exemplo e espera pelo "Pronto"
  marca('upload');
  await legenda(page, 'Envie PDF, DOCX, TXT ou Markdown: a indexação roda em segundo plano.');
  await pausa(page, 1500);
  const escolha = page.waitForEvent('filechooser');
  await clicar(page, page.getByRole('button', { name: 'Escolher arquivos' }));
  await (await escolha).setFiles(DOCS);
  await pausa(page, 800);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })); // lista com o status
  for (const nome of ['politica-ferias.md', 'contrato-servicos.md', 'tabela-precos.md'])
    await expect(page.getByRole('listitem').filter({ hasText: nome }).getByRole('status')).toHaveText('Pronto', { timeout: 90_000 });
  await pausa(page, 3000);

  // 5. pergunta com streaming, citacao e painel da fonte
  marca('chat');
  await menu(page, 'Chat');
  await legenda(page, 'Pergunte em português: a resposta chega em streaming, com citações [n].');
  await pausa(page, 1500);
  await perguntar(page, PERGUNTA);
  const r1 = await resposta(page, 1);
  await expect(r1).toContainText('30 dias');
  await pausa(page, 3000);
  await legenda(page, 'Clique na citação para conferir o trecho exato do documento.');
  await clicar(page, r1.getByRole('button', { name: /^Fonte \d+$/ }).first());
  const fonte = page.getByRole('complementary', { name: 'Fonte da citação' });
  await expect(fonte).toContainText('politica-ferias.md');
  await pausa(page, 5000);
  await clicar(page, fonte.getByRole('button', { name: 'Fechar' }));

  // 6. parafrase que funciona e pergunta fora do corpus (abstencao)
  marca('parafrase');
  await legenda(page, 'Com outras palavras também funciona: a busca entende o sentido.');
  await perguntar(page, 'Dá para dividir as férias em partes?');
  await expect(await resposta(page, 2)).toContainText(/tr[eê]s/i);
  await pausa(page, 3500);
  marca('fora');
  await legenda(page, 'Fora dos documentos, ele diz que não encontrou em vez de inventar.');
  await perguntar(page, 'Qual é a capital da Austrália?');
  await expect(await resposta(page, 3)).toContainText('Não encontrei');
  await pausa(page, 4000);

  // 7. modo agente: extrair tabela, com os passos
  marca('agente');
  await page.goto('/chat'); // conversa nova
  await legenda(page, 'Modo agente: planeja, usa ferramentas e mostra cada passo.');
  await pausa(page, 1200);
  await clicar(page, page.getByRole('checkbox', { name: 'Modo agente' }));
  await perguntar(page, 'Extraia a tabela de preços de material de escritório');
  await expect(page.getByRole('list', { name: 'Passos do agente' })).toBeVisible({ timeout: 30_000 });
  await resposta(page, 1);
  await expect(page.getByRole('region', { name: 'Tabela extraída' })).toContainText('Caneta azul');
  await pausa(page, 6000);

  // 8. historico e uso
  marca('historico');
  await menu(page, 'Conversas');
  await legenda(page, 'Histórico: retome qualquer conversa de onde parou.');
  await expect(page.getByRole('link', { name: /Quantos dias de férias/ })).toBeVisible();
  await pausa(page, 3500);
  marca('uso');
  await menu(page, 'Uso');
  await legenda(page, 'Uso por organização: consultas, tokens, custo e limite mensal.');
  await expect(page.getByText(/Limite mensal/)).toBeVisible();
  await pausa(page, 5000);

  // 9. tema escuro
  marca('escuro');
  await legenda(page, 'Tema escuro incluído.');
  await clicar(page, page.getByRole('button', { name: 'Tema escuro' }));
  await expect(page.locator('html')).toHaveClass(/dark/);
  await pausa(page, 1500);
  await menu(page, 'Conversas');
  await pausa(page, 1000);
  await clicar(page, page.getByRole('link', { name: /Quantos dias de férias/ }));
  await expect(page.getByRole('log', { name: 'Conversa' }).getByRole('article', { name: 'Assistente' }).first()).toContainText('30 dias');
  await pausa(page, 4500);

  // 10. cartela final
  marca('cartela');
  await legenda(page, '');
  await page.setContent(CARTELA);
  await pausa(page, 7000);
  marca('fim');

  await page.close();
  const bruto = test.info().outputPath('bruto.webm');
  await page.video()!.saveAs(bruto);
  console.log('marcas (s):', JSON.stringify(marcas));
  if (spawnSync('ffmpeg', ['-version']).error) {
    copyFileSync(bruto, OUT.webm);
    console.log('ffmpeg nao encontrado no PATH: gerado so o .webm');
    return;
  }
  const ff = (args: string[]) => expect(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' }).status).toBe(0);
  ff(['-i', bruto, '-c', 'copy', OUT.webm]); // remux: o webm do Playwright sai sem duracao nem indice de busca
  ff(['-i', OUT.webm, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT.mp4]);
  // GIF curto: da pergunta ate o fim do modo agente, em velocidade 2x
  const [de, ate] = [marcas.chat!, marcas.historico!];
  ff(['-ss', String(de), '-t', String(ate - de), '-i', OUT.webm, '-vf', 'setpts=0.5*PTS,fps=8,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', OUT.gif]);
  for (const f of Object.values(OUT)) console.log(f, `${(statSync(f).size / 1e6).toFixed(1)} MB`);
});
