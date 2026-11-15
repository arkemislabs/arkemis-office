// U:grid/view bridge E2E: the View tab from the ribbon (Normal and Page Break Preview, Gridlines, Formula Bar,
// Headings, Zoom, Zoom to Selection, Freeze Panes, Split, Custom Views), what stays hidden, and the view saved
// to a real .xlsx file. Driven only through the bridge: no OS mouse or keyboard, no screen capture.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/ui-egui/src/ribbon/view.rs (the groups and their controls),
//    crates/engine/src/cmd/view.rs, cmd/extra/window.rs and grid/show.rs `paint_pages` (Page Break Preview),
//    at fb1e59f.
// 2. Ours runs the same commands from the ribbon controls and reads the sheet back.
// 3. This flow; captures in artifacts/e2e/grid/view/*.png were looked at by the author.

import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import {startData, assert} from './data-kit.mjs';
import {readXlsx} from '../../../core/grid/formats/xlsx-read.mjs';
import {script, exists} from '../common/file-helpers.mjs';

test('grid view tab: modes, show, zoom, freeze panes, custom views, and the saved view', {timeout: 400_000}, async () => {
  const t = await startData('grid/view', {tab: 'view'});
  const {app, doc, select, press, exec, settle} = t;
  const sheet = async () => (await t.read('/sh:s1', 'props'));
  const control = async id => ((await app.rpc('ui.inspect', {doc})).controls ?? []).find(c => c.id === id) ?? null;
  const openMenu = async id => { await app.rpc('ui.tab', {doc, id: 'view'}); await settle(150); await app.rpc('ui.menu', {doc, control: id}); await settle(350); };
  const closeMenu = async id => { await app.rpc('ui.menu', {doc, control: id, open: false}); await settle(100); };
  try {
    // The tab: gridcraft's controls; the window commands, Page Layout view, Ruler, Macros and Sheet Views stay hidden.
    const ids = new Set(((await app.rpc('ui.inspect', {doc})).controls ?? []).map(c => c.id));
    for (const id of ['view.workbookViews.normal', 'view.workbookViews.pageBreakPreview', 'view.workbookViews.customViews', 'view.show.gridlines', 'view.show.formulaBar', 'view.show.headings',
      'view.zoom.zoom', 'view.zoom.zoom100', 'view.zoom.zoomToSelection', 'view.window.freezePanes', 'view.window.split',
      'view.workbookViews.pageLayout', 'view.show.ruler', 'view.window.newWindow', 'view.window.arrangeAll', 'view.window.hide', 'view.window.unhide', 'view.window.switchWindows',
      'view.window.sideBySide', 'view.window.syncScrolling', 'view.window.resetPosition']) assert.ok(ids.has(id), `${id} is on the View tab`);
    for (const id of ['view.macros.macros']) assert.ok(!ids.has(id), `${id} stays hidden`);
    assert.equal((await control('view.workbookViews.normal')).checked, true);
    assert.equal((await control('view.show.gridlines')).checked, true);
    await app.capture('01-view-tab');

    // Show: Gridlines, Headings and the Formula Bar are check boxes; each changes what the grid draws.
    await press('view.show.gridlines');
    assert.equal((await sheet()).showGridlines, false);
    assert.equal((await control('view.show.gridlines')).checked, false);
    await settle(300);
    await app.capture('02-no-gridlines');
    await press('view.show.headings');
    assert.equal((await sheet()).showHeadings, false);
    await settle(300);
    await app.capture('03-no-gridlines-no-headings');
    await press('view.show.gridlines'); await press('view.show.headings');
    assert.equal((await sheet()).showGridlines, undefined);
    await press('view.show.formulaBar');
    assert.equal((await control('view.show.formulaBar')).checked, false);
    await settle(300);
    await app.capture('04-no-formula-bar');
    await press('view.show.formulaBar');
    assert.equal((await control('view.show.formulaBar')).checked, true);

    // Zoom: 200% drawn, Zoom to Selection, 100%.
    await exec('view.zoom', {percent: 200});
    await select('A1', 'D8');
    await settle(300);
    await app.capture('05-zoom-200');
    const fit = (await exec('view.zoomToSelection', {viewWidth: 640, viewHeight: 320})).result;
    assert.ok(fit.zoom >= 10 && fit.zoom <= 400);
    await press('view.zoom.zoomToSelection');
    await settle(300);
    await app.capture('06-zoom-to-selection');
    await press('view.zoom.zoom100');
    await settle(300);

    // Freeze Panes: at the selected cell, then the menu's top row, then unfreeze.
    await select('C3');
    await press('view.window.freezePanes.freeze-panes');
    assert.deepEqual((await sheet()).freeze, {rows: 2, cols: 2});
    assert.equal((await control('view.window.freezePanes'))?.checked ?? true, true);
    await settle(300);
    await app.capture('07-frozen-c3');
    await openMenu('view.window.freezePanes');
    await app.capture('08-freeze-menu');
    await closeMenu('view.window.freezePanes');
    await press('view.window.freezePanes.freeze-top-row');
    assert.deepEqual((await sheet()).freeze, {rows: 1, cols: 0});
    await press('view.window.freezePanes.unfreeze-panes');
    assert.deepEqual((await sheet()).freeze, {rows: 0, cols: 0});
    await select('B3');
    await press('view.window.split');
    assert.deepEqual((await sheet()).freeze, {rows: 2, cols: 1});
    await press('view.window.split');
    assert.deepEqual((await sheet()).freeze, {rows: 0, cols: 0});

    // Page Break Preview: the pages as they print, a manual break splits them.
    await exec('pageLayout.pageSetup', {rowBreaks: [6], colBreaks: ['C']});
    await select('H12');
    await press('view.workbookViews.pageBreakPreview');
    assert.equal((await control('view.workbookViews.pageBreakPreview')).checked, true);
    assert.equal((await control('view.workbookViews.normal')).checked, false);
    await settle(400);
    await app.capture('09-page-break-preview');
    await exec('pageLayout.pageSetup', {orientation: 'landscape', fitToPage: true, rowBreaks: [], colBreaks: []});
    await settle(300);
    await app.capture('10-page-break-preview-fit-one-page');
    await exec('pageLayout.pageSetup', {orientation: 'portrait', fitToPage: false});

    // Custom Views: save one, change the view, show it again; the dialog lists it.
    await exec('view.zoom', {percent: 150});
    await select('B2');
    await exec('view.freezePanes', {cell: 'B2'});
    await press('view.workbookViews.customViews');
    const d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.customViews');
    assert.deepEqual(d.values.views, []);
    await settle(300);
    await app.capture('11-custom-views-empty');
    await app.rpc('ui.dialog.cancel', {doc});
    await exec('view.customViews', {save: 'Review'});
    await exec('view.unfreezePanes', {});
    await exec('view.zoom100', {});
    await press('view.workbookViews.customViews');
    assert.deepEqual((await app.rpc('ui.dialog.get', {doc})).values.views, ['Review']);
    await settle(300);
    await app.capture('12-custom-views');
    await app.rpc('ui.dialog.submit', {doc});
    await settle(300);
    assert.deepEqual((await sheet()).freeze, {rows: 1, cols: 1}, 'Show restores the frozen panes');

    // The view goes to a real .xlsx: the active sheet's zoomScale and view.
    await exec('view.zoom', {percent: 125});
    const file = path.join(os.tmpdir(), `view-${process.pid}.xlsx`);
    await script(app, {type: 'save', path: file});
    await app.rpc('ui.key', {doc, keys: 'Ctrl+S'});
    await app.until(() => exists(file), {timeout: 30_000});
    const xml = await (await JSZip.loadAsync(await fs.readFile(file))).file('xl/worksheets/sheet1.xml').async('string');
    assert.match(xml, /<sheetView[^>]*view="pageBreakPreview"[^>]*zoomScale="125"/);
    assert.match(xml, /<pane[^>]*state="frozen"/);
    const back = await readXlsx(await fs.readFile(file));
    assert.deepEqual([back.sheets[0].zoom, back.sheets[0].view, back.sheets[0].freeze], [125, 'pageBreakPreview', {rows: 1, cols: 1}]);
    await fs.rm(file, {force: true});
  } finally {
    await t.app.close();
  }
});
