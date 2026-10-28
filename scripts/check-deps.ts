/**
 * `pnpm check:deps`: todo import bare (@docmind/* ou lib) precisa estar declarado no package.json do proprio pacote
 * (ou nos devDependencies da raiz, que cobrem vitest/tsx/typescript). Sem isso o codigo so funciona por hoisting
 * local e quebra no Docker / `pnpm install --frozen-lockfile`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, sep } from 'node:path';

const root = join(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'test-results', 'playwright-report']);
const builtin = new Set(builtinModules);
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

const rootDev = new Set(Object.keys(readJson(join(root, 'package.json')).devDependencies ?? {}));
const dirs = [
  ...['apps', 'packages'].flatMap((g) => (existsSync(join(root, g)) ? readdirSync(join(root, g)).map((d) => `${g}/${d}`) : [])),
  'tests',
  'evals',
];

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.next')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

let missing = 0;
for (const d of dirs) {
  const pj = join(root, d, 'package.json');
  if (!existsSync(pj)) continue;
  const pkg = readJson(pj);
  const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }));
  const seen = new Map<string, string>();
  for (const file of sources(join(root, d))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1]!;
      if (/^[./]/.test(spec) || spec.startsWith('node:')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
      if (builtin.has(name) || declared.has(name) || rootDev.has(name) || seen.has(name)) continue;
      seen.set(name, file.slice(root.length + 1).split(sep).join('/'));
    }
  }
  for (const [name, file] of seen) {
    missing++;
    console.log(`FALTA  ${pkg.name}: ${name}  (${file})`);
  }
}
console.log(missing ? `\n${missing} dependencia(s) nao declarada(s)` : 'OK: todos os imports estao declarados');
process.exit(missing ? 1 : 0);
