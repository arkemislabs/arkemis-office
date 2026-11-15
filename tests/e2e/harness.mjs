// Bridge-driven Electron E2E harness (docs/architecture.md section 17.5).
//
//   import {launchApp} from '../harness.mjs';
//   const app = await launchApp({product: 'grid', flow: 'grid/bold'});
//   const {doc} = await app.rpc('documents.create', {});
//   await app.rpc('documents.open', {doc, show: false});
//   await app.rpc('ui.activate', {doc, control: 'home.bold'});
//   await app.capture('after-bold');                      // artifacts/e2e/grid/bold/after-bold.png
//   await app.close();
//
// The app runs from this checkout with ARKEMIS_STUDIO_DATA=<temp vault> and ARKEMIS_STUDIO_TEST=1:
// windows are shown inactive and are not focusable, so flows never take focus and run in parallel.
// Everything goes through the app's test-only transport (electron/test-rpc-server.cjs, tests/e2e/rpc-client.mjs). Pointer, keyboard and OS input are forbidden
// here (scripts/lint-e2e.mjs); visual evidence comes from ui.capture (webContents.capturePage).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import {TestRpcClient} from './rpc-client.mjs';

const PRODUCTS = new Set(['studio', 'quill', 'grid', 'prism', 'slate', 'folio']);

/** Kill a process and everything it started (only our own child trees). */
export function killTree(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function assertBuilt() {
  for (const file of ['dist/index.html', 'runtime/format-worker.cjs', 'core/generated/manifest.json']) {
    if (!fsSync.existsSync(path.join(root, file))) throw new Error(`${file} is missing: run \`npm run build\` before the bridge E2E suite`);
  }
}

/**
 * A development renderer for flows that need the new shell before an app's manifest is ready:
 * dist/ copied to artifacts/dev-dist/<key>/ with src/main.tsx rebuilt using the build-time defines
 * (ARKEMIS_NEW_HOST, ARKEMIS_SHOW_PENDING). main.cjs serves it only in test mode, through
 * ARKEMIS_STUDIO_DIST, so dist/ (the production bundle) is never touched and flows can run in
 * parallel: each key is built once, into a temporary folder renamed into place.
 * @param {{newHost?: boolean, showPending?: boolean}} [opts]
 * @returns {Promise<string>} the folder to pass as `launchApp({renderer})`
 */
export async function devRenderer({newHost = true, showPending = false} = {}) {
  assertBuilt();
  const {createHash} = await import('node:crypto');
  const meta = await fs.readFile(path.join(root, 'dist', 'build-meta.json'), 'utf8').catch(() => '');
  // The sources the bundle is made of: a change under src/ or core/ makes a new key, so a flow never
  // runs a stale renderer when dist/ was not rebuilt.
  // ARKEMIS_E2E_READABLE=1: an unminified bundle, so a renderer error the app log shows names a readable line.
  const readable = process.env.ARKEMIS_E2E_READABLE === '1';
  const key = createHash('sha256').update(JSON.stringify({meta, newHost, showPending, readable, sources: newestSource()})).digest('hex').slice(0, 16);
  const base = path.join(root, 'artifacts', 'dev-dist');
  const out = path.join(base, key);
  if (fsSync.existsSync(path.join(out, 'main.js'))) { await fs.utimes(out, new Date(), new Date()).catch(() => {}); return out; }
  // Renderers no flow can still be using (made over two hours ago) are removed.
  for (const name of fsSync.existsSync(base) ? fsSync.readdirSync(base) : []) {
    const dir = path.join(base, name);
    try { if (Date.now() - fsSync.statSync(dir).mtimeMs > 2 * 3600_000) await fs.rm(dir, {recursive: true, force: true, maxRetries: 2}); } catch { /* in use */ }
  }
  const tmp = `${out}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(base, {recursive: true});
  await fs.cp(path.join(root, 'dist'), tmp, {recursive: true});
  const {build} = await import('esbuild');
  await build({
    absWorkingDir: root, entryPoints: ['src/main.tsx'], outdir: tmp, bundle: true, splitting: true, format: 'esm', platform: 'browser',
    target: 'chrome142', minify: !readable, loader: {'.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'file'}, assetNames: 'fonts/[name]', logLevel: 'warning',
    define: {'process.env.NODE_ENV': '"production"', 'process.env.ARKEMIS_DIAGNOSTICS': '"0"',
      'process.env.ARKEMIS_SHOW_PENDING': showPending ? '"1"' : '"0"', 'process.env.ARKEMIS_NEW_HOST': newHost ? '"1"' : '"0"'},
  });
  const {WORKER_ENTRIES} = await import('../../scripts/renderer-entries.mjs');
  for (const w of WORKER_ENTRIES) {
    if (!fsSync.existsSync(path.join(root, w.entry))) continue;
    await build({
      absWorkingDir: root, entryPoints: [w.entry], outfile: path.join(tmp, w.out), bundle: true, format: 'esm', platform: 'browser',
      target: 'chrome142', minify: true, logLevel: 'warning',
      define: {'process.env.NODE_ENV': '"production"', 'process.env.ARKEMIS_DIAGNOSTICS': '"0"',
        'process.env.ARKEMIS_SHOW_PENDING': showPending ? '"1"' : '"0"', 'process.env.ARKEMIS_NEW_HOST': newHost ? '"1"' : '"0"'},
    });
  }
  // main.cjs reads it: a new-host renderer edits schema-2 documents (documents.create, migration on open).
  await fs.writeFile(path.join(tmp, 'host.json'), JSON.stringify({newHost}));
  try {
    await fs.rename(tmp, out);
  } catch {
    // Another flow finished the same key first: use theirs.
    await fs.rm(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}).catch(() => {});
    if (!fsSync.existsSync(path.join(out, 'main.js'))) throw new Error(`could not prepare the development renderer in ${out}`);
  }
  return out;
}

/** Newest modification time (ms) of the files under src/ and core/ (generated indexes included). */
function newestSource() {
  let newest = 0;
  const visit = dir => {
    let entries;
    try { entries = fsSync.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') visit(full); continue; }
      try { const t = fsSync.statSync(full).mtimeMs; if (t > newest) newest = t; } catch { /* removed meanwhile */ }
    }
  };
  for (const dir of ['src', 'core', 'assets/icons']) visit(path.join(root, dir));
  return Math.floor(newest);
}

/** Where a flow's evidence goes: artifacts/e2e/<app>/<flow>/. */
export function artifactDir(flow) {
  const safe = String(flow).split(/[\\/]/).map(part => part.replace(/[^a-zA-Z0-9._-]/g, '_')).filter(Boolean);
  return path.join(root, 'artifacts', 'e2e', ...safe);
}

/**
 * Start the app for `product` with a temporary vault and connect to its test transport.
 * @param {{product?: string, flow?: string, args?: string[], env?: Record<string,string>, timeout?: number, files?: object[], renderer?: string}} [opts]
 *   files: documents written to the vault before launch. renderer: a devRenderer() folder to serve instead of dist/.
 */
export async function launchApp({product = 'studio', flow, args = [], env = {}, timeout = 60_000, files = [], renderer, data: reuse} = {}) {
  if (!PRODUCTS.has(product)) throw new Error(`Unknown product ${product}`);
  assertBuilt();
  // `data`: the folder of an earlier launch closed with close({keepData: true}), so the same profile (its settings) starts again.
  const data = reuse ?? await fs.mkdtemp(path.join(os.tmpdir(), `arkemis-e2e-${product}-`));
  await fs.mkdir(path.join(data, 'documents'), {recursive: true});
  // The demo-file marker keeps the vault empty unless a flow seeds it.
  await fs.writeFile(path.join(data, 'initialized'), '1');
  for (const file of files) await fs.writeFile(path.join(data, 'documents', `${file.id}.json`), JSON.stringify(file));
  // A connection left by an earlier launch of a reused folder is not this one.
  await fs.rm(path.join(data, 'test-rpc.json'), {force: true});
  const electron = require('electron');
  const childEnv = {...process.env, ...env, ARKEMIS_STUDIO_DATA: data, ARKEMIS_STUDIO_TEST: '1'};
  if (renderer) childEnv.ARKEMIS_STUDIO_DIST = renderer;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [root, `--product=${product}`, ...args], {env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, detached: process.platform !== 'win32'});
  const log = [];
  const keep = chunk => { log.push(String(chunk)); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.once('exit', code => { exited = code ?? 0; });
  const deadline = Date.now() + timeout;
  let client = null;
  while (!client) {
    if (exited !== null) throw new Error(`The app exited with code ${exited} before its bridge started:\n${log.join('')}`);
    if (Date.now() > deadline) { killTree(child.pid); throw new Error(`The app bridge did not start within ${timeout} ms:\n${log.join('')}`); }
    try {
      const record = await TestRpcClient.read(data);
      if (record?.product === product) { client = new TestRpcClient(record); await client.rpc('app.describe'); }
    } catch { /* not ready yet */ }
    if (!client) await new Promise(resolve => setTimeout(resolve, 200));
  }
  const evidence = flow ? artifactDir(flow) : null;
  const app = {
    product, data, child, client, log,
    rpc: (method, params = {}, opts) => client.rpc(method, params, opts),
    /** Save a PNG of a window (ui.capture) under artifacts/e2e/<flow>/<name>.png; returns {file, width, height}. */
    async capture(name, params = {}) {
      const shot = await client.rpc('ui.capture', params);
      if (!evidence) return {width: shot.width, height: shot.height};
      await fs.mkdir(evidence, {recursive: true});
      const file = path.join(evidence, `${String(name).replace(/[^a-zA-Z0-9._-]/g, '_')}.png`);
      await fs.writeFile(file, Buffer.from(shot.png, 'base64'));
      return {file, width: shot.width, height: shot.height};
    },
    /** Wait until `check()` returns a truthy value (polling the bridge, never sleeping blind). */
    async until(check, {timeout: limit = 15_000, interval = 100} = {}) {
      const end = Date.now() + limit;
      let last;
      while (Date.now() < end) {
        try { last = await check(); if (last) return last; } catch (e) { last = e; }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
      throw new Error(`Timed out waiting: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    },
    async close({keepData = false} = {}) {
      killTree(child.pid);
      if (exited === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (keepData) return;
      await fs.rm(data, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}).catch(() => {});
    },
  };
  return app;
}
