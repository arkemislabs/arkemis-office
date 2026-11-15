// Grid's gate (docs/architecture.md 17.5), the flows the other Grid suites don't already cover:
// values and a formula typed into cells, Save As (F12, the system Save dialog answered by the
// test-mode script) to every format Excel saves here (.xlsx, and CSV with Excel's compatibility
// question), each reopened from its path with values and the formula's result intact, Print, and
// every address the workbook lists read back over the bridge. Editing, Paste Special, fill,
// formats, formulas and dialogs are in edit-cells, format-ribbon, formulas-ribbon, sheet-cells and
// the dialog sweep.
//
//   npm run build && node --test tests/e2e/grid/gate.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {documentsFolder, exists, script, asked, show, start, run} from '../common/file-helpers.mjs';

test('grid gate: type values and a formula, Save As .xlsx and CSV, reopen each, Print, read back every address', {timeout: 600_000}, async () => {
  const folder = await documentsFolder('grid-gate');
  const app = await start('grid', 'grid-gate');
  await run(async () => {
    const {doc} = await app.rpc('documents.create', {});
    await show(app, doc);
    const enter = async (cell, text) => {
      await app.rpc('ui.pointer', {doc, action: 'click', cell});
      await app.rpc('ui.type', {doc, text});
      await app.rpc('ui.keys', {doc, key: 'Enter'});
    };
    await enter('A1', 'Item');
    const sheet = (await app.rpc('selection.get', {doc})).selection.ranges[0].anchor.split('/')[1];
    await enter('B1', 'Price');
    await enter('A2', 'Pens');
    await enter('B2', '4.5');
    await enter('A3', 'Paper');
    await enter('B3', '12');
    await enter('B4', '=SUM(B2:B3)');
    const value = async (d, a) => (await app.rpc('document.read', {doc: d, address: `/${sheet}/${a}`, as: 'values'})).value;
    await app.until(async () => (await value(doc, 'B4')) === 16.5 || null, {timeout: 10_000});

    const saved = {};
    for (const ext of ['xlsx', 'csv']) {
      const target = path.join(folder, `Gate.${ext}`);
      await fs.rm(target, {force: true});
      // CSV asks Excel's question (features not compatible with CSV: keep this format?): Yes.
      await script(app, {type: 'save', path: target}, ...(ext === 'csv' ? [{type: 'message', response: 0}] : []));
      const key = await app.rpc('ui.key', {doc, keys: 'F12'});
      assert.equal(key.command, 'file.saveAs', 'F12 is Save As');
      await app.until(() => exists(target), {timeout: 30_000});
      assert.ok((await asked(app)).some(a => a.type === 'save'), `${ext}: the system Save As dialog was asked`);
      saved[ext] = target;
    }
    const csv = await fs.readFile(saved.csv, 'utf8');
    assert.match(csv, /Pens,4\.5/);
    assert.match(csv, /16\.5/, 'the formula is saved as its value in CSV');

    // Reopen each from its path (File > Open, Explorer): values and the formula come back.
    for (const ext of ['xlsx', 'csv']) {
      const r = await app.rpc('documents.open', {path: saved[ext], show: false});
      const id = r.doc ?? r.id;
      assert.ok(id, `${ext}: opened`);
      const s = (await app.rpc('document.inspect', {doc: id})).nodes?.find(n => /^\/sh:/.test(n.address))?.address ?? `/${sheet}`;
      const read = async a => (await app.rpc('document.read', {doc: id, address: `${s}/${a}`, as: 'values'})).value;
      assert.equal(await read('A2'), 'Pens', `${ext}: text survives`);
      assert.equal(await read('B2'), 4.5, `${ext}: numbers survive`);
      assert.equal(await read('B4'), 16.5, `${ext}: the formula's result survives`);
      if (ext === 'xlsx') assert.equal((await app.rpc('document.read', {doc: id, address: `${s}/B4`, as: 'formulas'})).value, '=SUM(B2:B3)', 'xlsx keeps the formula');
    }

    // Print: File > Print's command, through the print path (the test-mode script answers it).
    await script(app);
    await app.rpc('engine.execute', {doc, command: 'file.print', params: {copies: 1}}).catch(e => { if (e.code !== 'approval_required') throw e; });
    await app.capture('after-print');

    // Bridge read-back: every address the workbook lists reads back.
    const tree = await app.rpc('document.inspect', {doc});
    const addresses = [];
    const walk = n => { if (n?.address) addresses.push(n.address); for (const k of n?.nodes ?? []) walk(k); };
    walk(tree);
    assert.ok(addresses.length > 1, 'the workbook lists its parts');
    for (const address of addresses) {
      const r = await app.rpc('document.read', {doc, address});
      assert.ok(r && 'value' in r, `${address} reads back`);
    }
  }, app);
});
