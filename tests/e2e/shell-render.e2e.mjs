// Visual check of the new shell (src/shell) for every app: each ribbon tab, the File backstage and one
// professional dialog, captured with ui.capture (webContents.capturePage) into artifacts/shell/.
//
// The shell is compiled in with ARKEMIS_NEW_HOST=1 and pending controls are shown with
// ARKEMIS_SHOW_PENDING=1, which are build-time defines: this flow rebuilds the renderer bundle
// (dist/main.js, dist/main.css and their chunks) with them, and restores the production main.js
// and main.css when it ends. Windows run with ARKEMIS_STUDIO_TEST=1 (inactive, never focused) and
// are driven only through the bridge (ui.tab, ui.dialog.open/cancel, ui.inspect, ui.capture).
//
//   npm run build && node --test tests/e2e/shell-render.e2e.mjs
//   SHELL_APPS=quill,grid node --test tests/e2e/shell-render.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {launchApp, root} from './harness.mjs';

const OUT = path.join(root, 'artifacts', 'shell');
const APPS = (process.env.SHELL_APPS || 'quill,grid,prism,folio,slate').split(',').map(s => s.trim()).filter(Boolean);
/** One rich dialog per app (multi-tab, many field kinds). */
const DIALOGS = {quill: 'dialog.font', grid: 'dialog.formatCells', prism: 'dialog.paragraph', folio: 'dialog.print', slate: 'dialog.paragraph-spacing'};

async function buildDevRenderer() {
  const {build} = await import('esbuild');
  const keep = {};
  for (const f of ['main.js', 'main.css']) keep[f] = await fs.readFile(path.join(root, 'dist', f));
  const before = new Set(await fs.readdir(path.join(root, 'dist')));
  await build({
    absWorkingDir: root, entryPoints: ['src/main.tsx'], outdir: 'dist', bundle: true, splitting: true, format: 'esm', platform: 'browser',
    target: 'chrome142', minify: true, loader: {'.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'file'}, assetNames: 'fonts/[name]', logLevel: 'warning',
    define: {'process.env.NODE_ENV': '"production"', 'process.env.ARKEMIS_DIAGNOSTICS': '"0"', 'process.env.ARKEMIS_SHOW_PENDING': '"1"', 'process.env.ARKEMIS_NEW_HOST': '"1"'},
  });
  return async () => {
    for (const [f, bytes] of Object.entries(keep)) await fs.writeFile(path.join(root, 'dist', f), bytes);
    // Remove the development chunks this build added; the production ones are untouched.
    for (const f of await fs.readdir(path.join(root, 'dist'))) if (!before.has(f) && /\.(js|css)$/.test(f)) await fs.rm(path.join(root, 'dist', f), {force: true});
  };
}

const safe = s => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');

test('shell render: every ribbon tab, the backstage and one dialog per app', {timeout: 900_000}, async () => {
  await fs.mkdir(OUT, {recursive: true});
  const restore = await buildDevRenderer();
  const report = [];
  try {
    for (const product of APPS) {
      const app = await launchApp({product});
      try {
        // The startup window must be up (RendererBridge said hello) before it is asked to open a document:
        // an open-document message sent while the page still loads would be lost.
        await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 30_000});
        const {doc} = await app.rpc('documents.create', {title: `${product[0].toUpperCase()}${product.slice(1)} review`});
        await app.rpc('documents.open', {doc, show: true});
        const first = await app.until(async () => {
          const ui = await app.rpc('ui.inspect', {doc});
          return ui.tabs?.length && Object.keys(ui.levels ?? {}).length ? ui : null;
        }, {timeout: 30_000}).catch(e => { throw new Error(`${e.message}
--- app log ---
${app.log.join('').slice(-4000)}`); });
        assert.equal(first.showPending, true, 'the dev bundle shows pending controls');
        const spec = (await import(`../../src/generated/${product}.spec.ts`)).default;
        const tabs = spec.tabs.map(t => t.id);
        const shots = [];
        const capture = async name => {
          const shot = await app.rpc('ui.capture', {});
          const file = path.join(OUT, `${product}-${safe(name)}.png`);
          await fs.writeFile(file, Buffer.from(shot.png, 'base64'));
          shots.push(path.relative(root, file));
        };
        let i = 0;
        for (const tab of tabs) {
          try { await app.rpc('ui.tab', {doc, id: tab}); } catch (e) { report.push(`${product}: tab ${tab}: ${e.message}`); continue; }
          const ui = await app.until(async () => {
            const s = await app.rpc('ui.inspect', {doc});
            return s.tab === tab && Object.keys(s.levels).some(k => k.startsWith(`${tab}/`)) ? s : null;
          }, {timeout: 15_000}).catch(() => null);
          if (!ui) { report.push(`${product}: tab ${tab} did not render`); continue; }
          // Let fonts and the fit pass settle before the capture (two inspections a frame apart agree).
          await app.until(async () => JSON.stringify((await app.rpc('ui.inspect', {doc})).levels) === JSON.stringify(ui.levels) ? true : null, {timeout: 5000}).catch(() => {});
          await capture(`tab-${String(++i).padStart(2, '0')}-${tab}`);
        }
        await app.rpc('ui.tab', {doc, id: 'file'});
        await app.until(async () => (await app.rpc('ui.inspect', {doc})).backstage.open || null);
        await capture('backstage');
        await app.rpc('ui.key', {doc, keys: 'Escape'});
        await app.rpc('ui.tab', {doc, id: tabs[0]});
        const dialogId = DIALOGS[product];
        if (spec.dialogs[dialogId]) {
          const d = await app.rpc('ui.dialog.open', {doc, id: dialogId});
          assert.equal(d.id, dialogId);
          await capture(`dialog-${dialogId}`);
          if (d.tabs.length > 1) {
            await app.rpc('ui.dialog.set', {doc, id: dialogId, tab: 1});
            await capture(`dialog-${dialogId}-tab2`);
          }
          await app.rpc('ui.dialog.cancel', {doc, id: dialogId});
        }
        report.push(`${product}: ${shots.length} captures`);
      } finally {
        await app.close();
      }
    }
  } finally {
    await restore();
  }
  await fs.writeFile(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  console.log(report.join('\n'));
});
