// U:grid/view: Normal and Page Break Preview, Gridlines, Headings, Formula Bar, Zoom to Selection, the
// Freeze Panes family, Split, Custom Views, the pagination Page Break Preview draws, and the view a
// workbook is saved with (zoomScale, sheetView view).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/view.rs (freeze_panes, sheet_flag, zoom_selection,
//    view.formulaBar), cmd/extra/window.rs (set_view, custom_views, split), cmd/print/layout.rs (the
//    pagination), tests/it/custom_view_freeze.rs, at fb1e59f. Each assertion below is one of those
//    behaviours.
// 2. Ours: the view mode and the zoom are the session's view, written into the active sheet when the
//    workbook is saved (model/index.mjs fileForSave); the formula bar is an application option.
// 3. These tests; tests/e2e/grid/view.e2e.mjs drives the ribbon and takes the captures.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {fileForSave, initialView} from '../../core/grid/lib/view-file.mjs';
import {layoutSheet, bands} from '../../core/grid/lib/page-layout.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';

const sel = (t, range) => run(t, 'selection.set', {range});
const sheet = t => t.content.sheets[0];
const data = () => workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 'a'}, B1: {v: 'b'}, A2: {v: 1}, B2: {v: 2}}}}]);

test('gridlines and headings: toggle, set, and the state a check box shows', async () => {
  const t = await session(data());
  assert.equal(t.state('view.gridlines').checked, true);
  assert.deepEqual(await run(t, 'view.gridlines', {}), {on: false});
  assert.equal(sheet(t).showGridlines, false);
  assert.equal(t.state('view.gridlines').checked, false);
  await run(t, 'view.gridlines', {on: true});
  assert.equal(sheet(t).showGridlines, undefined, 'on is the default and is not stored');
  await run(t, 'view.headings', {on: false});
  assert.equal(sheet(t).showHeadings, false);
  assert.equal(t.state('view.headings').checked, false);
  await expectUndoRoundTrip(t, 'view.gridlines', {on: false}, () => {});
});

test('freeze panes: the active cell, a cell, toggling off, top row, first column, unfreeze', async () => {
  const t = await session(data());
  await sel(t, 'C4');
  assert.deepEqual((await run(t, 'view.freezePanes', {})).freeze, [3, 2]);
  assert.deepEqual(sheet(t).freeze, {rows: 3, cols: 2});
  assert.equal(t.state('view.freezePanes').checked, true);
  await run(t, 'view.freezePanes', {});
  assert.equal(sheet(t).freeze, undefined, 'Freeze Panes on a frozen sheet unfreezes');
  await run(t, 'view.freezePanes', {cell: 'B2'});
  assert.deepEqual(sheet(t).freeze, {rows: 1, cols: 1});
  await run(t, 'view.freezePanes', {cell: 'D3'});
  assert.deepEqual(sheet(t).freeze, {rows: 2, cols: 3}, 'a cell given freezes at that cell even when frozen');
  await run(t, 'view.freezeTopRow', {});
  assert.deepEqual(sheet(t).freeze, {rows: 1, cols: 0});
  await run(t, 'view.freezeFirstColumn', {});
  assert.deepEqual(sheet(t).freeze, {rows: 0, cols: 1});
  await run(t, 'view.unfreezePanes', {});
  assert.equal(sheet(t).freeze, undefined);
  await sel(t, 'A1');
  await run(t, 'view.freezePanes', {});
  assert.equal(sheet(t).freeze, undefined, 'at A1 there is nothing to freeze');
  await fails(t, 'view.freezePanes', {cell: 'zz'});
  await expectUndoRoundTrip(t, 'view.freezeTopRow', {}, () => {});
});

test('split toggles frozen panes at the active cell, as gridcraft does', async () => {
  const t = await session(data());
  await sel(t, 'B3');
  await run(t, 'view.split', {});
  assert.deepEqual(sheet(t).freeze, {rows: 2, cols: 1});
  assert.equal(t.state('view.split').checked, true);
  await run(t, 'view.split', {});
  assert.equal(sheet(t).freeze, undefined);
});

test('normal and page break preview are the window view, not an edit', async () => {
  const t = await session(data());
  assert.equal(t.state('view.normal').checked, true);
  await run(t, 'view.pageBreakPreview', {});
  assert.equal(t.doc.view.mode, 'pageBreakPreview');
  assert.equal(t.state('view.pageBreakPreview').checked, true);
  assert.equal(t.state('view.normal').checked, false);
  assert.equal(t.doc.dirty, false, 'a view switch does not mark the workbook changed');
  await run(t, 'view.normal', {});
  assert.ok(!t.doc.view.mode);
  assert.equal(t.state('view.normal').checked, true);
});

test('formula bar is an application option, on by default', async () => {
  const t = await session(data());
  assert.equal(t.state('view.formulaBar').checked, true);
  assert.deepEqual(await run(t, 'view.formulaBar', {}), {on: false});
  assert.equal(t.session.prefs.formulaBar, false);
  assert.equal(t.state('view.formulaBar').checked, false);
  assert.deepEqual(await run(t, 'view.formulaBar', {on: true}), {on: true});
  assert.equal(t.session.prefs.formulaBar, true);
});

test('zoom to selection: the largest zoom at which the selection fits, 10 to 400, rounded down', async () => {
  const t = await session(data());
  // 64 x 20 px cells: A1:B2 is 128 x 40 px; 1200 / 128 = 9.375, 700 / 40 = 17.5, so 937%, capped at 400.
  await sel(t, 'A1:B2');
  assert.deepEqual(await run(t, 'view.zoomToSelection', {}), {zoom: 400});
  assert.equal(t.doc.view.zoom, 400);
  // 10 columns x 100 rows = 640 x 2000 px at 1200 x 700: min(1.875, 0.35) = 35%.
  await sel(t, 'A1:J100');
  assert.deepEqual(await run(t, 'view.zoomToSelection', {}), {zoom: 35});
  assert.deepEqual(await run(t, 'view.zoomToSelection', {viewWidth: 640, viewHeight: 2000}), {zoom: 100});
  // The shared commands set and read the same zoom.
  await run(t, 'view.zoom', {percent: 150});
  assert.equal(t.doc.view.zoom, 150);
  await run(t, 'view.zoom100', {});
  assert.equal(t.doc.view.zoom, 100);
});

test('custom views save the sheet, selection, zoom and frozen panes, and show them again', async () => {
  const t = await session(data());
  await sel(t, 'B2');
  await run(t, 'view.freezePanes', {cell: 'B2'});
  await run(t, 'view.zoom', {percent: 150});
  assert.deepEqual(Object.keys(await run(t, 'view.customViews', {save: 'Frozen'})), ['Frozen']);
  assert.deepEqual(t.content.customViews.Frozen, {sheet: 's1', selection: 'B2', zoom: 150, freeze: [1, 1]});
  await run(t, 'view.unfreezePanes', {});
  await run(t, 'view.zoom100', {});
  await sel(t, 'D5');
  await run(t, 'view.customViews', {show: 'Frozen'});
  assert.deepEqual(sheet(t).freeze, {rows: 1, cols: 1}, 'showing a view restores its frozen panes');
  assert.equal(t.doc.view.zoom, 150);
  assert.equal(t.doc.selection.ranges.length, 1);
  // A view saved unfrozen clears the current panes (gridcraft custom_view_freeze.rs).
  await run(t, 'view.unfreezePanes', {});
  await run(t, 'view.customViews', {save: 'Plain'});
  await run(t, 'view.freezePanes', {cell: 'B2'});
  await run(t, 'view.customViews', {show: 'Plain'});
  assert.equal(sheet(t).freeze, undefined);
  await fails(t, 'view.customViews', {show: 'Nope'});
  await fails(t, 'view.customViews', {save: '   '});
  assert.deepEqual(Object.keys(await run(t, 'view.customViews', {delete: 'Frozen'})), ['Plain']);
  await run(t, 'view.customViews', {delete: 'Plain'});
  assert.equal(t.content.customViews, undefined);
  await expectUndoRoundTrip(t, 'view.customViews', {save: 'X'}, () => {});
});

test('the view is saved with the workbook: the active sheet keeps its zoom and view mode', async () => {
  const content = workbook([{id: 's1', name: 'Sheet1', zoom: 150, view: 'pageBreakPreview'}, {id: 's2', name: 'Sheet2', zoom: 75}]);
  const open = initialView({content});
  assert.deepEqual(open, {zoom: 150, fit: null, mode: 'pageBreakPreview'});
  // Nothing changed: the same file comes back.
  const file = {id: 'f', content};
  assert.equal(fileForSave(file, {zoom: 150, mode: 'pageBreakPreview'}), file);
  const saved = fileForSave(file, {zoom: 100, mode: null});
  assert.equal(saved.content.sheets[0].zoom, undefined);
  assert.equal(saved.content.sheets[0].view, undefined);
  assert.equal(saved.content.sheets[1].zoom, 75, 'other sheets keep theirs');
  assert.equal(fileForSave(file, {zoom: 90, mode: 'pageBreakPreview'}).content.sheets[0].zoom, 90);
  // Page Layout view is shown here: a sheet saved in it opens in it, and shows Normal again once the window does.
  const paper = {id: 'f', content: workbook([{id: 's1', name: 'Sheet1', view: 'pageLayout'}])};
  assert.deepEqual(initialView(paper), {mode: 'pageLayout'});
  assert.equal(fileForSave(paper, {zoom: 100, mode: 'pageLayout'}), paper);
  assert.equal(fileForSave(paper, {zoom: 100, mode: null}).content.sheets[0].view, undefined);
  assert.equal(fileForSave(file, {zoom: 100, mode: 'pageLayout'}).content.sheets[0].view, 'pageLayout');
});

test('sheetView view and zoomScale survive .xlsx', async () => {
  const content = workbook([{id: 's1', name: 'Sheet1', zoom: 125, view: 'pageBreakPreview', blocks: {0: {A1: {v: 1}}}}]);
  const back = await readXlsx(await writeXlsx(content));
  assert.equal(back.sheets[0].view, 'pageBreakPreview');
  assert.equal(back.sheets[0].zoom, 125);
});

// ---------------------------------------------------------------- pagination (Page Break Preview)

const wide = (rows, cols) => {
  const blocks = {};
  for (let r = 0; r < rows; r++) { const b = Math.floor(r / 64); blocks[b] ??= {}; for (let c = 0; c < cols; c++) blocks[b][`${String.fromCharCode(65 + c)}${r + 1}`] = {v: r * cols + c}; }
  return blocks;
};

test('bands: lines fill a band, a manual break starts a new one, an oversized line stands alone', () => {
  const size = () => 20;
  assert.deepEqual(bands(0, 9, size, () => 100, [], 100), [[0, 4], [5, 9]]);
  assert.deepEqual(bands(0, 9, size, () => 100, [3], 100), [[0, 2], [3, 7], [8, 9]]);
  assert.deepEqual(bands(0, 2, () => 500, () => 100, [], 100), [[0, 0], [1, 1], [2, 2]]);
  assert.deepEqual(bands(0, 99, size, () => 100, [], 3), [[0, 4], [5, 9], [10, 14]], 'capped');
});

test('pages: the used range split down then over for the paper, margins and scale', async () => {
  // Letter portrait, 0.7 / 0.75 inch margins: printable 612 - 100.8 = 511.2 pt wide, 792 - 108 = 684 pt high; 1 px = 0.75 pt.
  // 681.6 px wide fits 10 columns of 64 px (640) and not 11; 912 px high fits 45 rows of 20 px (900) and not 46.
  const sh = {id: 's1', name: 'Sheet1', blocks: wide(100, 12)};
  const lay = layoutSheet(sh);
  assert.equal(lay.areas.length, 1);
  assert.deepEqual(lay.areas[0].colBands, [[0, 9], [10, 11]]);
  assert.deepEqual(lay.areas[0].rowBands, [[0, 44], [45, 89], [90, 99]]);
  assert.equal(lay.pages.length, 6);
  assert.deepEqual(lay.pages.map(p => p.n), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(lay.pages[1].range, {start: {row: 45, col: 0}, end: {row: 89, col: 9}}, 'down first, then over');
  assert.deepEqual(lay.pages[3].range.start, {row: 0, col: 10});
});

test('pages: landscape, a manual break, fit to one page wide, a print area and repeated titles', async () => {
  const blocks = wide(100, 12);
  const base = {id: 's1', name: 'Sheet1', blocks};
  assert.equal(layoutSheet({...base, pageSetup: {orientation: 'landscape'}}).pages.length, 4, 'landscape: 792 - 100.8 pt wide holds all 12 columns, 612 - 108 high holds 36 rows');
  const manual = layoutSheet({...base, pageSetup: {rowBreaks: [10]}});
  assert.deepEqual(manual.areas[0].rowBands[0], [0, 9]);
  const fit = layoutSheet({...base, pageSetup: {fitWidth: 1, fitHeight: 0, rowBreaks: [10]}});
  assert.equal(fit.areas[0].colBands.length, 1, 'fit to one page wide');
  assert.ok(fit.areas[0].scale < 1);
  assert.deepEqual(fit.areas[0].rowBands[0][0], 0);
  assert.notDeepEqual(fit.areas[0].rowBands[0], [0, 9], 'manual breaks do not apply when fitted to pages');
  const area = layoutSheet({...base, printArea: 'A1:C5,E1:F2'});
  assert.deepEqual(area.areas.map(a => [a.area.start.col, a.area.end.col]), [[0, 2], [4, 5]]);
  assert.deepEqual(area.pages.map(p => p.n), [1, 2]);
  const titled = layoutSheet({...base, printTitles: 'Sheet1!$1:$2'});
  assert.deepEqual(titled.areas[0].titleRows, [0, 1]);
  assert.ok(titled.areas[0].rowBands[1][1] - titled.areas[0].rowBands[1][0] + 1 < 45, 'the repeated rows leave room for fewer rows on the later pages');
  assert.equal(layoutSheet({id: 's1', name: 'Empty', blocks: {}}).pages.length, 0);
});

test('pages: an 8 by 6 range is one page until a break is inserted; manual breaks are known to the layout', () => {
  const sh = {id: 's1', name: 'Sheet1', blocks: wide(8, 6)};
  const one = layoutSheet(sh);
  assert.equal(one.pages.length, 1);
  assert.deepEqual(one.areas[0].rowBands, [[0, 7]]);
  const cut = layoutSheet({...sh, pageSetup: {rowBreaks: [5], colBreaks: [3]}});
  assert.equal(cut.pages.length, 4);
  assert.equal(cut.areas[0].manualBreaks, true);
  assert.deepEqual(cut.areas[0].setup.rowBreaks, [5]);
  // The print area is the printed area: no page outside it.
  assert.equal(layoutSheet({...sh, printArea: 'A1:C3'}).pages.length, 1);
});
