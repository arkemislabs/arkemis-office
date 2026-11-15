// Port of the #[test] functions in gridcraft crates/engine/src/selection.rs
// (146161b4b450a56e5e59a083ba0478582d1e602b): jumps, regions, cycling. Each test names the Rust test.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../../../core/grid/model/index.mjs';
import {MAX_ROWS, MAX_COLS, parseRange, rangeA1, a1} from '../../../core/grid/lib/addr.mjs';

/** A sheet as gridcraft Sheet::new + set_value(Number(1.0)) at the given cells. */
function sheetWith(cells) {
  const blocks = {};
  for (const [r, c] of cells) (blocks[model.blockOf(r)] ??= {})[a1(r, c)] = {v: 1};
  return {sheets: [{id: 's', name: 'S', blocks}], activeSheetId: 's', styles: [{}]};
}

test('jumps', () => {
  const cells = [];
  for (let r = 0; r < 5; r++) cells.push([r, 0]);
  cells.push([10, 0]);
  const c = sheetWith(cells);
  const v = (r, col) => model.valueAt(c, 0, r, col);
  const u = model.usedBounds(c.sheets[0]);
  const used = {start: {row: u.r0, col: u.c0}, end: {row: u.r1, col: u.c1}};
  assert.deepEqual(model.jump(v, used, {row: 0, col: 0}, 1, 0), {row: 4, col: 0});
  // Without a direction it stays put (it used to loop forever from a blank cell).
  assert.deepEqual(model.jump(v, used, {row: 7, col: 0}, 0, 0), {row: 7, col: 0});
  assert.deepEqual(model.jump(v, used, {row: 4, col: 0}, 1, 0), {row: 10, col: 0});
  assert.deepEqual(model.jump(v, used, {row: 10, col: 0}, 1, 0), {row: MAX_ROWS - 1, col: 0});
  assert.deepEqual(model.jump(v, used, {row: 0, col: 0}, 0, 1), {row: 0, col: MAX_COLS - 1});
  assert.deepEqual(model.jump(v, used, {row: 0, col: 0}, -1, 0), {row: 0, col: 0});
});

test('regions', () => {
  const cells = [];
  for (let r = 2; r < 5; r++) for (let c = 1; c < 4; c++) cells.push([r, c]);
  const c = sheetWith(cells);
  const filled = (r, col) => model.hasContent(model.cellAt(c.sheets[0], r, col));
  assert.equal(rangeA1(model.currentRegion(filled, {row: 3, col: 2})), 'B3:D5');
  assert.equal(rangeA1(model.currentRegion(filled, {row: 5, col: 4})), 'B3:E6');
  assert.equal(rangeA1(model.currentRegion(filled, {row: 20, col: 20})), 'U21');
  // Taller than 10,000 rows: it used to stop growing after 10,000 steps.
  const tall = {sheets: [{id: 's', name: 'S', blocks: {}}], activeSheetId: 's'};
  for (let r = 0; r < 20000; r++) { const b = (tall.sheets[0].blocks[model.blockOf(r)] ??= {}); b[`A${r + 1}`] = {v: r}; b[`B${r + 1}`] = {v: 1}; }
  const f2 = (r, col) => model.hasContent(model.cellAt(tall.sheets[0], r, col));
  assert.equal(rangeA1(model.currentRegion(f2, {row: 5, col: 0})), 'A1:B20000');
});

test('cycling', () => {
  const r = parseRange('A1:B2');
  let sel = {sheet: 0, active: {...r.start}, anchor: {...r.start}, ranges: [r]};
  sel = model.cycle(sel, true, false);
  assert.equal(a1(sel.active.row, sel.active.col), 'A2');
  sel = model.cycle(sel, true, false);
  assert.equal(a1(sel.active.row, sel.active.col), 'B1');
  sel = model.cycle(sel, true, true);
  assert.equal(a1(sel.active.row, sel.active.col), 'A2');
});
