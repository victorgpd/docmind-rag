/** `pnpm verify`: build + typecheck + lint + test (build antes: o typecheck do web usa .next/types), uma linha por pacote/tarefa; so as falhas mostram a saida. */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const run = (cmd: string) => spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 << 20 });

const pkgs: { name: string; scripts?: Record<string, string> }[] = [];
const load = (dir: string) => {
  const f = join(root, dir, 'package.json');
  if (existsSync(f)) pkgs.push(JSON.parse(readFileSync(f, 'utf8')));
};
for (const group of ['apps', 'packages']) {
  for (const d of existsSync(join(root, group)) ? readdirSync(join(root, group)) : []) load(join(group, d));
}
load('tests');
load('evals');

const jobs: { label: string; cmd: string }[] = [];
jobs.push({ label: '(raiz) check:deps', cmd: 'pnpm check:deps' });
for (const task of ['build', 'typecheck', 'lint', 'test']) {
  for (const p of pkgs) if (p.scripts?.[task]) jobs.push({ label: `${p.name} ${task}`, cmd: `pnpm --filter ${p.name} run ${task}` });
  // lint e global (eslint . na raiz): roda uma vez
  if (task === 'lint') jobs.push({ label: '(raiz) lint', cmd: 'pnpm lint' });
}

let failed = 0;
for (const j of jobs) {
  const t = Date.now();
  const r = run(j.cmd);
  const ok = r.status === 0;
  console.log(`${ok ? 'OK    ' : 'FALHA '} ${j.label.padEnd(34)} ${((Date.now() - t) / 1000).toFixed(1)}s`);
  if (!ok) {
    failed++;
    console.log(((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n').slice(-15).map((l) => '    ' + l).join('\n'));
  }
}
console.log(`\n${jobs.length - failed}/${jobs.length} OK`);
process.exit(failed ? 1 : 0);
