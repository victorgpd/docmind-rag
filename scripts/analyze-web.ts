/**
 * `pnpm --filter @docmind/web analyze`: build do web com ANALYZE=true num distDir isolado e relatorio em texto
 * (top modulos e chunks do bundle do cliente, por tamanho). Os JSON completos ficam em apps/web/.next-analyze/analyze/.
 * Uso: tsx scripts/analyze-web.ts [--top 25] [--no-build]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const web = join(import.meta.dirname, '..', 'apps', 'web');
const args = process.argv.slice(2);
const top = Number(args[args.indexOf('--top') + 1]) || 25;
const distDir = '.next-analyze';
const report = join(web, distDir, 'analyze', 'client.json');

if (!args.includes('--no-build')) {
  // o next build reescreve tsconfig.json (inclui <distDir>/types): restaura no fim
  const tsconfig = join(web, 'tsconfig.json');
  const before = readFileSync(tsconfig, 'utf8');
  const r = spawnSync('pnpm exec next build', {
    cwd: web,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ANALYZE: 'true', NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1' },
  });
  writeFileSync(tsconfig, before);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(report)) {
  console.error(`relatorio nao encontrado: ${report}`);
  process.exit(1);
}

type Node = { label: string; parsedSize?: number; gzipSize?: number; statSize?: number; groups?: Node[] };
const chunks: Node[] = JSON.parse(readFileSync(report, 'utf8'));
const kb = (n = 0) => `${(n / 1024).toFixed(1)} kB`;
const row = (name: string, parsed?: number, gzip?: number) => `  ${kb(parsed).padStart(10)} ${kb(gzip).padStart(10)}  ${name}`;

// folhas = modulos; agrega por pacote (node_modules/<pkg>) quando o caminho passa por node_modules
const modules = new Map<string, { parsed: number; gzip: number }>();
const leaves = (n: Node, path: string, out: { path: string; parsed: number; gzip: number }[]) => {
  const p = n.label === undefined ? path : path ? `${path}/${n.label}` : n.label;
  if (n.groups?.length) n.groups.forEach((g) => leaves(g, p, out));
  else out.push({ path: p, parsed: n.parsedSize ?? 0, gzip: n.gzipSize ?? 0 });
};
for (const c of chunks) {
  const out: { path: string; parsed: number; gzip: number }[] = [];
  leaves(c, '', out);
  for (const l of out) {
    const m = l.path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
    const key = m ? m[m.length - 1]!.replace('node_modules/', '') : 'app: ' + l.path.replace(/^.*?(src|app)\//, '$1/');
    const cur = modules.get(key) ?? { parsed: 0, gzip: 0 };
    modules.set(key, { parsed: cur.parsed + l.parsed, gzip: cur.gzip + l.gzip });
  }
}

const sorted = [...modules].sort((a, b) => b[1].parsed - a[1].parsed).slice(0, top);
const total = [...modules.values()].reduce((s, v) => ({ parsed: s.parsed + v.parsed, gzip: s.gzip + v.gzip }), { parsed: 0, gzip: 0 });

console.log(`\nTop ${top} pacotes/modulos do bundle do cliente (parsed, gzip)`);
console.log(`  ${'parsed'.padStart(10)} ${'gzip'.padStart(10)}  nome`);
for (const [name, v] of sorted) console.log(row(name, v.parsed, v.gzip));
console.log(row('TOTAL do cliente', total.parsed, total.gzip));

console.log(`\nTop ${top} chunks`);
for (const c of [...chunks].sort((a, b) => (b.parsedSize ?? 0) - (a.parsedSize ?? 0)).slice(0, top)) console.log(row(c.label, c.parsedSize, c.gzipSize));
console.log(`\nJSON completo: ${report}`);
