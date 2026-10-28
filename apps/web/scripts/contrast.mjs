// Contraste WCAG 2.x dos tokens reais de apps/web/app/globals.css (cores tingidas = composição alfa sobre a base).
import { readFileSync } from 'node:fs';

// Uso: pnpm --filter @docmind/web contrast [--md]. Sai com código 1 se alguma combinação ficar abaixo do mínimo.

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const block = (sel) => css.slice(css.indexOf(sel + ' {'), css.indexOf('}', css.indexOf(sel + ' {')));
const parse = (b) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const themes = { claro: parse(block(':root')), escuro: parse(block('.dark')) };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgba = (s) => {
  if (s.startsWith('#')) return [...hex(s), 1];
  const m = s.match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number);
  return [m[0], m[1], m[2], m[3] ?? 1];
};
const over = (fg, bg, a = fg[3]) => [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
const lum = (c) => {
  const [r, g, b] = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const rows = [];
for (const [name, t] of Object.entries(themes)) {
  const C = (k) => rgba(t[k]);
  const tintOn = (base) => over(C('tint'), base);
  const pill = (k, base) => over([...C(k).slice(0, 3), 0.15], base);
  const [g1, g2] = t.grad.match(/#[0-9a-f]{6}/gi);
  const add = (what, fg, bg, min = 4.5) => rows.push({ tema: name, what, ratio: ratio(fg, bg), min });

  const bg = C('bg'), surface = C('surface'), subtle = C('subtle');
  // pílulas de status (ficam em cards .surface)
  add('pílula Na fila (muted/subtle)', C('muted'), subtle);
  add('pílula Na fila sobre bg', C('muted'), subtle);
  add('pílula Processando (warn/warn15)', C('warn'), pill('warn', surface));
  add('pílula Pronto (ok/ok15)', C('ok'), pill('ok', surface));
  add('pílula Erro (danger/danger15)', C('danger'), pill('danger', surface));
  // chips e acento sobre tingido
  add('chip [n] landing (brand/tint em surface)', C('brand'), tintOn(surface));
  add('chip [n] (brand/tint em bg)', C('brand'), tintOn(bg));
  add('item ativo do menu (brand/tint em surface)', C('brand'), tintOn(surface));
  add('ícone/ext. de documento (brand/tint)', C('brand'), tintOn(surface));
  add('link brand sobre bg', C('brand'), bg);
  add('link brand sobre surface', C('brand'), surface);
  // texto secundário
  add('muted sobre bg', C('muted'), bg);
  add('muted sobre surface', C('muted'), surface);
  add('muted sobre subtle (hover)', C('muted'), subtle);
  add('muted sobre tint (em bg)', C('muted'), tintOn(bg));
  add('badge da landing (muted/surface)', C('muted'), surface);
  add('rótulos do menu 11px (muted/surface)', C('muted'), surface);
  add('placeholder (muted/surface)', C('muted'), surface);
  add('fg sobre bg', C('fg'), bg);
  add('fg sobre surface', C('fg'), surface);
  add('danger sobre surface', C('danger'), surface);
  add('danger sobre bg', C('danger'), bg);
  add('warn sobre surface', C('warn'), surface);
  add('ok sobre surface', C('ok'), surface);
  // gradiente: pior ponto = o extremo mais claro
  const pf = C('primary-fg');
  add('branco no botão primário (início do gradiente)', pf, hex(g1));
  add('branco no botão primário (fim do gradiente)', pf, hex(g2));
  add('branco no painel de marca (início)', [255, 255, 255], hex(g1));
  add('branco no painel de marca (fim)', [255, 255, 255], hex(g2));
    add('botão primário desabilitado (isento WCAG 1.4.3; referência)', over([...pf, 0.6], over(hex(g1), surface, 0.6)), over(hex(g1), surface, 0.6), 2.5);
  // componentes (não texto): 3:1
  add('borda de campo (line-strong/surface)', C('line-strong'), surface, 3);
  add('borda de campo (line-strong/bg)', C('line-strong'), bg, 3);
  add('foco/brand sobre bg', C('brand'), bg, 3);
  add('foco/brand sobre surface', C('brand'), surface, 3);
  add('brand sobre tint (indicador do menu)', C('brand'), tintOn(surface), 3);
}
let bad = 0;
for (const r of rows) {
  const ok = r.ratio >= r.min;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${r.tema.padEnd(6)} ${r.ratio.toFixed(2).padStart(5)}:1 (mín ${r.min})  ${r.what}`);
}
console.log(`\n${bad} combinação(ões) abaixo do mínimo de ${rows.length}`);
if (process.argv.includes('--md')) {
  console.log('\n| Combinação | Claro | Escuro | Mínimo |\n|---|---|---|---|');
  const names = [...new Set(rows.map((r) => r.what))];
  for (const n of names) {
    const c = rows.find((r) => r.what === n && r.tema === 'claro'), d = rows.find((r) => r.what === n && r.tema === 'escuro');
    console.log(`| ${n} | ${c.ratio.toFixed(1)} | ${d.ratio.toFixed(1)} | ${c.min} |`);
  }
}
