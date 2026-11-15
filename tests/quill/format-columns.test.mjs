// A selected table column formats cell by cell (design note U-quill-table--quill-format--column-segments).
//
// Behaviour fidelity:
// 1. ArtCraft: wordcraft `Session::column_segments` and table_mouse/tests.rs
//    `a_selected_column_is_edited_cell_by_cell` / `numbering_a_column_makes_one_list`: Bold, Center
//    and Numbering on a selected column change each of its cells in one undo step and leave the
//    cells between its ends alone. Word does the same.
// 2. Ours: lib/format-target.mjs `segments` reads every range of the kernel selection (one per cell
//    paragraph, as table.selectColumn sets it) and applyChar / selectedPaths / resolvedRuns use them.
// 3. This test.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import * as P from '../../core/quill/model/para.mjs';

async function table3x3() {
  const q = await quill('');
  q.sel(0, 0);
  await q.exec('insert.table', {rows: 3, cols: 3});
  const t = () => blocks(q.t).find(b => b.kind === 'table');
  const addr = (r, c, off) => {
    const tb = t();
    const row = tb.rows[r], cell = row.cells[c], para = cell.blocks[0];
    return `/body/b:${tb.id}/r:${row.id}/c:${cell.id}/b:${para.id}/t:${off}`;
  };
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    q.t.session.setSelection(q.t.docId, {ranges: [{anchor: addr(r, c, 0), focus: addr(r, c, 0)}], primary: 0});
    await q.exec('text.insert', {text: `r${r}c${c}`});
  }
  const cellPara = (r, c) => t().rows[r].cells[c].blocks[0];
  return {q, addr, cellPara};
}

test('table_mouse/tests.rs a_selected_column_is_edited_cell_by_cell (Bold, Center)', async () => {
  const {q, addr, cellPara} = await table3x3();
  q.t.session.setSelection(q.t.docId, {ranges: [{anchor: addr(0, 1, 1), focus: addr(0, 1, 1)}], primary: 0});
  await q.exec('table.selectColumn');
  assert.equal(q.t.session.get(q.t.docId).selection.ranges.length, 3, 'one range per cell');
  assert.equal(q.state('format.bold').checked, false);
  const version = q.t.session.get(q.t.docId).version;
  await q.exec('format.bold');
  assert.equal(q.t.session.get(q.t.docId).version, version + 1, 'one undo step');
  const bold = (r, c) => !!P.propsAt(cellPara(r, c), 1)?.bold;
  assert.deepEqual([0, 1, 2].map(r => bold(r, 1)), [true, true, true], 'every cell of the column');
  assert.deepEqual([0, 1, 2].map(r => bold(r, 0) || bold(r, 2)), [false, false, false], 'the other columns are left alone');
  assert.equal(q.state('format.bold').checked, true, 'Bold shows on for the column');
  await q.exec('para.alignCenter');
  assert.deepEqual([0, 1, 2].map(r => cellPara(r, 1).props?.align), ['center', 'center', 'center']);
  assert.equal(cellPara(1, 0).props?.align, undefined);
  await q.t.undo();
  await q.t.undo();
  assert.deepEqual([0, 1, 2].map(r => bold(r, 1)), [false, false, false], 'undo takes the column back');
});

test('table_mouse/tests.rs numbering_a_column_makes_one_list', async () => {
  const {q, addr, cellPara} = await table3x3();
  q.t.session.setSelection(q.t.docId, {ranges: [{anchor: addr(0, 2, 0), focus: addr(0, 2, 0)}], primary: 0});
  await q.exec('table.selectColumn');
  await q.exec('para.numbering');
  const nums = [0, 1, 2].map(r => cellPara(r, 2).props?.numbering?.num);
  assert.ok(nums[0] && nums.every(n => n === nums[0]), `one list: ${JSON.stringify(nums)}`);
  assert.equal(cellPara(1, 1).props?.numbering, undefined, 'the cells between are left alone');
});
