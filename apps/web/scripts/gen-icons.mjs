// Gera favicon.ico (16+32, PNG embutido), apple-icon.png (180) e icons/icon-{192,512}.png a partir de app/icon.svg.
// Uso: pnpm --filter @docmind/web icons   (usa o Playwright/Chromium de tests/, sem dependências novas)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(resolve(root, '../../tests/package.json'))('@playwright/test');
const svgRound = readFileSync(resolve(root, 'app/icon.svg'), 'utf8');
const svgSquare = svgRound.replace('rx="8"', 'rx="0"'); // iOS aplica o próprio arredondamento

const browser = await chromium.launch();
const page = await browser.newPage();
const png = async (size, svg = svgRound) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
};

const out = (p, buf) => (mkdirSync(dirname(resolve(root, p)), { recursive: true }), writeFileSync(resolve(root, p), buf));
const ico = async (sizes) => {
  const imgs = await Promise.all(sizes.map((s) => png(s)));
  const head = Buffer.alloc(6 + 16 * imgs.length);
  head.writeUInt16LE(1, 2); // tipo: ícone
  head.writeUInt16LE(imgs.length, 4);
  let offset = head.length;
  imgs.forEach((img, i) => {
    const e = 6 + 16 * i;
    head[e] = head[e + 1] = sizes[i]; // largura/altura (<256)
    head.writeUInt16LE(1, e + 4); // planos
    head.writeUInt16LE(32, e + 6); // bits por pixel
    head.writeUInt32LE(img.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([head, ...imgs]);
};

out('app/favicon.ico', await ico([16, 32]));
out('app/apple-icon.png', await png(180, svgSquare));
out('public/icons/icon-192.png', await png(192));
out('public/icons/icon-512.png', await png(512));
await browser.close();
