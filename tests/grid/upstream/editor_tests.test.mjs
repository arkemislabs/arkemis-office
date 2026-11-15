// Port of the #[test] functions in gridcraft crates/ui-egui/src/editor.rs
// (146161b4b450a56e5e59a083ba0478582d1e602b). Each test names the Rust test it translates.
// Not ported: a_pasted_name_replaces_the_selected_text (Formulas › Use in Formula pastes a name:
// the formulas unit's formulas.pasteName, not the foundation editor model).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '../../../core/grid/lib/editor.mjs';
import {rangeA1} from '../../../core/grid/lib/addr.mjs';

const at = {row: 0, col: 0};

test('point_mode', () => {
  let e = ed.editState({sheet: 0, cell: at, text: '=SUM(', enterMode: true});
  assert.ok(ed.canPoint(e));
  e = ed.insertRef(e, 'A1');
  assert.equal(e.text, '=SUM(A1');
  e = ed.insertRef(e, 'A2');
  assert.equal(e.text, '=SUM(A2');
  e = {...e, text: e.text + ':', caret: e.caret + 1, point: null};
  assert.ok(ed.canPoint(e));
  assert.ok(!ed.canPoint(ed.editState({sheet: 0, cell: at, text: 'hello', enterMode: true})));
});

test('autocomplete_and_hints', () => {
  const names = ['SUM', 'SUMIF', 'SUMPRODUCT', 'AVERAGE'];
  let e = ed.updateAutocomplete(ed.editState({sheet: 0, cell: at, text: '=su', enterMode: true}), names);
  assert.equal(e.autocomplete.length, 3);
  e = ed.acceptAutocomplete(e);
  assert.ok(e);
  assert.equal(e.text, '=SUM(');
  assert.deepEqual(ed.currentFunction(ed.editState({sheet: 0, cell: at, text: '=IF(A1>0,SUM(B1,', enterMode: true})), {name: 'SUM', arg: 1});
});

test('ref_spans', () => {
  const r = ed.formulaRefs('=A1+B2:C3*a1+Sheet2!D4');
  assert.equal(r.length, 4);
  assert.equal(r[0].color, r[2].color, 'A1 and a1 share a colour');
  assert.equal(rangeA1(r[1].range), 'B2:C3');
  assert.equal(r[3].sheet, 'Sheet2');
});

test('refs_are_outlined_on_their_own_sheet_only', () => {
  assert.ok(ed.refIsOnSheet(null, 'Sheet1', 'Sheet1'));
  assert.ok(!ed.refIsOnSheet(null, 'Sheet1', 'Sheet2'));
  assert.ok(ed.refIsOnSheet('Sheet2', 'Sheet1', 'Sheet2'));
  assert.ok(!ed.refIsOnSheet('Sheet2', 'Sheet1', 'Sheet1'));
  assert.ok(ed.refIsOnSheet('sheet2', 'Sheet1', 'Sheet2'), 'sheet names compare ignoring case');
});

test('whole_row_and_column_ref_spans', () => {
  const refs = ed.formulaRefs('=SUM(C:C,4:6,$D:$E,Sheet2!7:8)');
  assert.equal(refs.length, 4);
  assert.deepEqual(refs.map(r => rangeA1(r.range)), ['C:C', '4:6', 'D:E', '7:8']);
  assert.equal(refs[3].sheet, 'Sheet2');
});

test('inserting_a_union_keeps_each_reference_separately_pointed', () => {
  let e = ed.editState({sheet: 0, cell: at, text: '=SUM(', enterMode: true});
  e = ed.insertRef(e, 'C:C');
  e = ed.appendRef(e, 'E:E');
  assert.equal(e.text, '=SUM(C:C,E:E');
  assert.deepEqual(ed.formulaRefs(e.text).map(r => rangeA1(r.range)), ['C:C', 'E:E']);
  assert.deepEqual(e.point, [9, 12]);
  assert.ok(ed.canPoint(e));
});
