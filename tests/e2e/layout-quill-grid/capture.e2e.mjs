// Ribbon layout review for Quill and Grid (docs/architecture.md sections 7.3, 8.4, 17.5): every
// ribbon tab of both apps, contextual tabs included, rendered from its layout overlay
// (docs/spec/layout/<app>/<tab>.json) and captured with ui.capture (webContents.capturePage) into
// artifacts/e2e/layout-quill-grid/, so the placement can be compared with Word and Excel. The flow
// asserts through ui.inspect that the groups drawn are the spec's, in the spec's order.
//
// It serves its own development renderer (pending controls shown, the shell's SHOW_PENDING review
// mode, in which ui.tab also opens contextual tabs) from artifacts/dev-dist/layout-qg-<hash>/,
// keyed by the generated Quill and Grid specs so an overlay change rebuilds it; dist/ is never
// touched. Windows run inactive and are driven only through the bridge (ui.tab, ui.inspect,
// ui.capture).
//
//   npm run build && node --test tests/e2e/layout-quill-grid/capture.e2e.mjs
//   LAYOUT_APPS=grid node --test tests/e2e/layout-quill-grid/capture.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {launchApp, artifactDir, root} from '../harness.mjs';

const OUT = artifactDir('layout-quill-grid');
const APPS = (process.env.LAYOUT_APPS || 'quill,grid').split(',').map(s => s.trim()).filter(Boolean);
const ONLY = (process.env.LAYOUT_TABS || '').split(',').map(s => s.trim()).filter(Boolean);
const safe = s => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');

/** dist/ copied and src/main.tsx rebuilt with the review defines, keyed by the generated specs. */
async function reviewRenderer() {
  const hash = createHash('sha256');
  for (const app of ['quill', 'grid']) hash.update(await fs.readFile(path.join(root, 'src/generated', `${app}.spec.ts`)));
  hash.update(await fs.readFile(path.join(root, 'dist', 'build-meta.json')).catch(() => ''));
  const out = path.join(root, 'artifacts', 'dev-dist', `layout-qg-${hash.digest('hex').slice(0, 16)}`);
  if (fsSync.existsSync(path.join(out, 'main.js'))) return out;
  const tmp = `${out}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(out), {recursive: true});
  await fs.cp(path.join(root, 'dist'), tmp, {recursive: true});
  const {build} = await import('esbuild');
  await build({
    absWorkingDir: root, entryPoints: ['src/main.tsx'], outdir: tmp, bundle: true, splitting: true, format: 'esm', platform: 'browser',
    target: 'chrome142', minify: true, loader: {'.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'file'}, assetNames: 'fonts/[name]', logLevel: 'warning',
    define: {'process.env.NODE_ENV': '"production"', 'process.env.ARKEMIS_DIAGNOSTICS': '"0"', 'process.env.ARKEMIS_SHOW_PENDING': '"1"', 'process.env.ARKEMIS_NEW_HOST': '"1"'},
  });
  try { await fs.rename(tmp, out); } catch {
    await fs.rm(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}).catch(() => {});
    if (!fsSync.existsSync(path.join(out, 'main.js'))) throw new Error(`could not prepare the review renderer in ${out}`);
  }
  return out;
}

test('ribbon layouts: every Quill and Grid tab as its overlay places it', {timeout: 900_000}, async () => {
  await fs.mkdir(OUT, {recursive: true});
  const renderer = await reviewRenderer();
  const report = [];
  for (const product of APPS) {
    const spec = (await import(`../../../src/generated/${product}.spec.ts`)).default;
    const app = await launchApp({product, renderer});
    try {
      await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 30_000});
      const {doc} = await app.rpc('documents.create', {title: `${product} ribbon review`});
      await app.rpc('documents.open', {doc, show: true});
      await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.tabs?.length && Object.keys(ui.levels ?? {}).length ? ui : null; }, {timeout: 30_000})
        .catch(e => { throw new Error(`${e.message}\n--- app log ---\n${app.log.join('').slice(-4000)}`); });
      let i = 0;
      for (const tab of spec.tabs) {
        i++;
        if (ONLY.length && !ONLY.includes(tab.id)) continue;
        await app.rpc('ui.tab', {doc, id: tab.id});
        const ui = await app.until(async () => {
          const s = await app.rpc('ui.inspect', {doc});
          return s.tab === tab.id && Object.keys(s.levels).some(k => k.startsWith(`${tab.id}/`)) ? s : null;
        }, {timeout: 15_000}).catch(() => null);
        assert.ok(ui, `${product}/${tab.id} renders`);
        // Let fonts and the fit pass settle before the capture (two inspections agree).
        await app.until(async () => JSON.stringify((await app.rpc('ui.inspect', {doc})).levels) === JSON.stringify(ui.levels) ? true : null, {timeout: 5000}).catch(() => {});
        const settled = await app.rpc('ui.inspect', {doc});
        const shot = await app.rpc('ui.capture', {doc});
        const file = path.join(OUT, `${product}-${String(i).padStart(2, '0')}-${safe(tab.id)}.png`);
        await fs.writeFile(file, Buffer.from(shot.png, 'base64'));
        const drawn = Object.keys(settled.levels).filter(k => k.startsWith(`${tab.id}/`)).map(k => k.slice(tab.id.length + 1));
        const expected = tab.groups.map(g => g.id).filter(g => drawn.includes(g));
        assert.deepEqual(drawn, expected, `${product}/${tab.id}: groups in spec order`);
        const levels = drawn.map(g => settled.levels[`${tab.id}/${g}`]);
        report.push(`${product}: ${tab.id}: ${drawn.length} groups, levels ${levels.join('')}, ${path.relative(root, file)}`);
      }
    } finally {
      await app.close();
    }
  }
  await fs.writeFile(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  console.log(report.join('\n'));
});
