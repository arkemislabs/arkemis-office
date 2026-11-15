// Runs the bridge-driven E2E flows (docs/architecture.md section 17.5): every tests/e2e/**/*.e2e.mjs
// under `node --test`, at most N at a time (default 4), each with a 4-minute limit. Only the
// process trees this runner started are killed. Exit code 1 when any flow fails.
//
//   node scripts/verify-bridge-e2e.mjs [--concurrency=4] [--timeout=240] [filter ...]

import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  const value = hit ? Number(hit.split('=')[1]) : fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive whole number`);
  return value;
};
const concurrency = option('concurrency', 4);
const timeoutMs = option('timeout', 240) * 1000;
const filters = args.filter(a => !a.startsWith('--'));

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith('.e2e.mjs')) yield full;
  }
}

function killTree(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

const files = [...walk(path.join(root, 'tests', 'e2e'))]
  .map(f => path.relative(root, f))
  .filter(f => !filters.length || filters.some(q => f.replace(/\\/g, '/').includes(q)));

if (!files.length) {
  console.log('verify-bridge-e2e: no flows matched.');
  process.exit(0);
}
for (const file of ['dist/index.html', 'runtime/format-worker.cjs']) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`verify-bridge-e2e: ${file} is missing; run \`npm run build\` first.`);
    process.exit(1);
  }
}

const children = new Set();
const cleanup = () => { for (const c of children) killTree(c.pid); };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

function run(file) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', file], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, detached: process.platform !== 'win32', env: {...process.env, ARKEMIS_STUDIO_TEST: '1'}});
    children.add(child);
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      children.delete(child);
      resolve({file, ok: code === 0 && !timedOut, timedOut, ms: Date.now() - started, output});
    });
  });
}

console.log(`verify-bridge-e2e: ${files.length} flow(s), concurrency ${concurrency}, ${timeoutMs / 1000} s each`);
const queue = [...files];
const results = [];
await Promise.all(Array.from({length: Math.min(concurrency, queue.length)}, async () => {
  while (queue.length) {
    const r = await run(queue.shift());
    results.push(r);
    console.log(`${r.ok ? 'pass' : r.timedOut ? 'TIMEOUT' : 'FAIL'}  ${r.file}  (${(r.ms / 1000).toFixed(1)} s)`);
    if (!r.ok) console.log(r.output.split('\n').map(l => '    ' + l).join('\n'));
  }
}));
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
