// Ported from gridcraft crates/engine/src/tests.rs at 146161b4b450a56e5e59a083ba0478582d1e602b:
// insert_delete_rows_adjust, deleting_a_multi_area_row_selection_*, move_columns_* (2),
// insert_copied_cells_inserts_rows_columns_and_blocks, insert_cut_cells_moves_whole_rows,
// inserting_or_deleting_cells_cancels_copy_mode, insert_delete_cells_adjust,
// inserting_cells_refuses_to_push_values_off_the_sheet, insert_and_delete_cells_never_shift_part_of_a_table,
// copies_of_a_long_named_sheet_get_unique_names, sheets, sheet_operations_keep_names_on_their_sheets,
// deleting_a_3d_span_end_sheet_keeps_the_rest.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: sheet.rs (insert/delete lines and cells move cells, formulas, names, merges, rules,
//    tables; Insert Copied Cells makes room then pastes, a cut of whole lines moves them; inserting
//    ends copy mode) and sheet/tabs.rs (insert, delete, rename, move/copy, hide/unhide, tab colour).
//    Excel's Home › Cells › Insert/Delete and the sheet tab menu do the same.
// 2. Ours does the same on schema-2 workbooks: whole lines through the foundation's grid.structure op,
//    cell shifts and moves as one grid.replace op, each command one undo step.
// 3. These tests (engine), tests/grid/sheet.test.mjs (undo round trips), tests/e2e/grid/format-ribbon.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, run, fails, stored, v, errorOf, selection} from '../edit-helpers.mjs';

const f = (t, a, si = 0) => stored(t, a, si)?.f;
const select = (t, a, si = 0) => {
  const id = t.content.sheets[si].id;
  const [x, y] = a.split(':');
  const line = /^\d+$/.test(x) ? 'row:' : /^[A-Z]+$/.test(x) ? 'col:' : '';
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sh:${id}/${line}${x}`, focus: `/sh:${id}/${line}${y ?? x}`}], primary: 0});
};
const clip = t => t.session.clipboard;

test('insert_delete_rows_adjust', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2], [3]]});
  await run(t, 'cell.set', {cell: 'B1', input: '=SUM(A1:A3)'});
  await run(t, 'home.insertRows', {rows: '2:2'});
  assert.equal(f(t, 'B1'), 'SUM(A1:A4)');
  await run(t, 'cell.set', {cell: 'A2', input: '10'});
  assert.equal(v(t, 'B1'), 16);
  await run(t, 'home.deleteRows', {rows: '1:1'});
  assert.equal(v(t, 'B1'), null);
  assert.equal(v(t, 'A1'), 10);
});

test('deleting_a_multi_area_row_selection_removes_every_area_and_undoes_once', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2], [3], [4], [5], [6]]});
  await run(t, 'cell.set', {cell: 'B1', input: '=A6'});
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/row:2', focus: '/sh:s1/row:2'}, {anchor: '/sh:s1/row:4', focus: '/sh:s1/row:4'},
    {anchor: '/sh:s1/row:5', focus: '/sh:s1/row:6'}], primary: 2});
  const depth = t.doc.undo.size;
  await run(t, 'home.deleteRows', {});
  assert.deepEqual([v(t, 'A1'), v(t, 'A2'), v(t, 'A3')], [1, 3, null]);
  assert.equal(f(t, 'B1'), '#REF!');
  await t.undo();
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(r => v(t, `A${r}`)), [1, 2, 3, 4, 5, 6]);
  assert.equal(t.doc.undo.size, depth, 'one undo step restored all rows');
  await run(t, 'range.setValues', {range: 'A1', values: [[1, 2, 3, 4]]});
  await run(t, 'home.deleteColumns', {cols: 'A:A,C:C'});
  assert.deepEqual([v(t, 'A1'), v(t, 'B1'), v(t, 'C1')], [2, 4, null]);
});

test('move_columns_reorders_without_overwriting_and_undoes_once', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1, 2, 3, 4, 5, 6, 7, 8]]});
  await run(t, 'cell.set', {cell: 'H2', input: '=B1+D1'});
  await run(t, 'cell.set', {cell: 'H3', input: '=SUM(B:B)'});
  await run(t, 'home.columnWidth', {cols: 'B:B', width: 101});
  await run(t, 'home.columnWidth', {cols: 'C:C', width: 102});
  const before = JSON.stringify(t.content);
  const depth = t.doc.undo.size;
  const r = await run(t, 'sheet.moveColumns', {cols: 'B:C', before: 4});
  assert.equal(r.cols, 'C:D');
  assert.deepEqual('ABCDEFGH'.split('').map(c => v(t, `${c}1`)), [1, 4, 2, 3, 5, 6, 7, 8]);
  assert.equal(f(t, 'H2'), 'C1+B1');
  assert.equal(f(t, 'H3'), 'SUM(C:C)');
  assert.equal(t.content.sheets[0].cols[2].size, 101);
  assert.equal(t.content.sheets[0].cols[3].size, 102);
  assert.equal((await selection(t)).a1, 'C:D');
  assert.equal(t.doc.undo.size, depth + 1);
  await t.undo();
  assert.equal(JSON.stringify(t.content), before);
});

test('move_columns_can_reorder_left_and_ignores_drops_inside_the_selection', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [['A', 'B', 'C', 'D', 'E']]});
  await run(t, 'sheet.moveColumns', {cols: 'D:E', before: 1});
  assert.deepEqual('ABCDE'.split('').map(c => v(t, `${c}1`)), ['A', 'D', 'E', 'B', 'C']);
  const depth = t.doc.undo.size;
  await run(t, 'sheet.moveColumns', {cols: 'B:C', before: 2});
  assert.equal(t.doc.undo.size, depth);
});

test('insert_copied_cells_inserts_rows_columns_and_blocks', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2], [3], [4], [5]]});
  await run(t, 'cell.set', {cell: 'B2', input: '=A2*10'});
  await run(t, 'edit.copy', {range: '2:2'});
  select(t, 'C4');
  await run(t, 'home.insertCopiedCells', {});
  assert.equal(v(t, 'A4'), 2);
  assert.equal(v(t, 'B4'), 20, 'the formula follows its new row');
  assert.equal(v(t, 'A5'), 4);
  assert.equal(v(t, 'A6'), 5);
  assert.equal((await selection(t)).a1, '4:4');
  await t.undo();
  assert.equal(v(t, 'A4'), 4);
  assert.equal(v(t, 'A6'), null);
  // Whole columns.
  await run(t, 'edit.copy', {range: 'A:A'});
  await run(t, 'home.insertCopiedCells', {at: 'A1'});
  assert.equal(v(t, 'A3'), 3);
  assert.equal(v(t, 'B3'), 3);
  assert.equal(v(t, 'C2'), 20, 'the old column B moved right');
  // A block shifts cells right.
  await run(t, 'cell.set', {cell: 'F1', input: 'x'});
  await run(t, 'cell.set', {cell: 'G1', input: 'y'});
  await run(t, 'edit.copy', {range: 'F1'});
  await run(t, 'home.insertCopiedCells', {at: 'G1', shift: 'right'});
  assert.equal(v(t, 'G1'), 'x');
  assert.equal(v(t, 'H1'), 'y');
  assert.equal(clip(t), null, 'inserting ends copy mode');
  await run(t, 'edit.copy', {range: 'F1'});
  await fails(t, 'home.insertCopiedCells', {shift: 'up'});
});

test('insert_cut_cells_moves_whole_rows', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2], [3], [4], [5]]});
  await run(t, 'cell.set', {cell: 'C1', input: '=A5'});
  // Up: row 5 goes above row 2.
  await run(t, 'edit.cut', {range: '5:5'});
  await run(t, 'home.insertCopiedCells', {at: 'A2'});
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(r => v(t, `A${r}`)), [1, 5, 2, 3, 4, null]);
  assert.equal(v(t, 'C1'), 5, 'references follow the moved cells');
  assert.equal(clip(t), null);
  // Down: row 1 goes above row 4.
  await run(t, 'edit.cut', {range: '1:1'});
  await run(t, 'home.insertCopiedCells', {at: 'A4'});
  assert.deepEqual([1, 2, 3, 4, 5].map(r => v(t, `A${r}`)), [5, 2, 1, 3, 4]);
  assert.equal((await selection(t)).a1, '3:3');
  await t.undo();
  assert.equal(v(t, 'A1'), 1);
  // Inside itself, and a cut block, are refused without changing anything.
  await run(t, 'edit.cut', {range: '2:4'});
  await fails(t, 'home.insertCopiedCells', {at: 'A3'});
  await run(t, 'edit.cut', {range: 'A1:A2'});
  await fails(t, 'home.insertCopiedCells', {at: 'B5'});
  assert.equal(v(t, 'A1'), 1);
  assert.equal(v(t, 'B5'), null);
});

test('inserting_or_deleting_cells_cancels_copy_mode', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2], [3]]});
  await run(t, 'edit.cut', {range: '3:3'});
  await run(t, 'home.insertRows', {rows: '3:3'});
  assert.equal(clip(t), null);
  assert.equal(v(t, 'A4'), 3);
  await run(t, 'edit.copy', {range: 'A:A'});
  await run(t, 'home.deleteColumns', {cols: 'B:B'});
  assert.equal(clip(t), null);
  await run(t, 'edit.copy', {range: 'A1'});
  await run(t, 'home.insertCells', {range: 'A1', shift: 'down'});
  assert.equal(clip(t), null);
  await run(t, 'edit.copy', {range: 'A2'});
  await run(t, 'home.deleteCells', {range: 'A1', shift: 'up'});
  assert.equal(clip(t), null);
});

test('insert_delete_cells_adjust', async () => {
  // home.conditionalFormat (U:grid/insert) and data.validation (U:grid/data) write these records;
  // the name goes in through the content like formulas.defineName would write it.
  const t = await session(workbook([{id: 's1', name: 'Sheet1',
    conditionalFormats: [{ranges: ['A4:A5'], rule: {type: 'cellIs', operator: 'greater', value: '3'}}],
    validations: [{ranges: ['A5'], type: 'whole', operator: 'greater', f1: '0'}]}], {names: [{name: 'Fourth', formula: 'Sheet1!$A$4'}]}));
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2], [3], [4], [5]]});
  await run(t, 'cell.set', {cell: 'C1', input: '=SUM(A1:A5)'});
  await run(t, 'cell.set', {cell: 'C2', input: '=A4*10'});
  await run(t, 'cell.set', {cell: 'C3', input: '=SUM(A1:B5)'});
  // Insert A3 shifting down: ranges across the insertion grow, references below move.
  await run(t, 'home.insertCells', {range: 'A3', shift: 'down'});
  assert.equal(f(t, 'C1'), 'SUM(A1:A6)');
  assert.equal(f(t, 'C2'), 'A5*10');
  assert.equal(f(t, 'C3'), 'SUM(A1:B5)');
  assert.equal(v(t, 'C2'), 40);
  assert.equal(t.content.names[0].formula, 'Sheet1!$A$5');
  assert.deepEqual(t.content.sheets[0].conditionalFormats[0].ranges, ['A5:A6']);
  assert.deepEqual(t.content.sheets[0].validations[0].ranges, ['A6']);
  // Delete A5 (the 4) shifting up: references to it become #REF!, those below move up.
  await run(t, 'home.deleteCells', {range: 'A5', shift: 'up'});
  assert.equal(f(t, 'C1'), 'SUM(A1:A5)');
  assert.equal(f(t, 'C2'), '#REF!*10');
  assert.equal(t.content.names[0].formula, '#REF!');
  assert.equal(v(t, 'C1'), 11);
  assert.deepEqual(t.content.sheets[0].conditionalFormats[0].ranges, ['A5']);
  assert.deepEqual(t.content.sheets[0].validations[0].ranges, ['A5']);
  // Shifting right and left.
  await run(t, 'range.setValues', {range: 'E1', values: [[1, 2, 3]]});
  await run(t, 'cell.set', {cell: 'E3', input: '=G1+SUM(E1:G1)'});
  await run(t, 'home.insertCells', {range: 'F1', shift: 'right'});
  assert.equal(f(t, 'E3'), 'H1+SUM(E1:H1)');
  await run(t, 'home.deleteCells', {range: 'E1:F1', shift: 'left'});
  assert.equal(f(t, 'E3'), 'F1+SUM(E1:F1)');
  assert.equal(v(t, 'E3'), 8);
});

test('inserting_cells_refuses_to_push_values_off_the_sheet', async () => {
  for (const [shift, edge, lastFit, lastOk] of [['right', 'XFD1', 'XFC1', 'XFD1'], ['down', 'A1048576', 'A1048575', 'A1048576']]) {
    let t = await session();
    await run(t, 'cell.set', {cell: 'A1', input: '1'});
    await run(t, 'cell.set', {cell: edge, input: '2'});
    const e = await fails(t, 'home.insertCells', {range: 'A1', shift});
    assert.match(e.message, /loss of data/);
    assert.equal(v(t, 'A1'), 1);
    assert.equal(v(t, edge), 2);
    t = await session();
    await run(t, 'cell.set', {cell: lastFit, input: '2'});
    await run(t, 'home.insertCells', {range: 'A1', shift});
    assert.equal(v(t, lastOk), 2);
  }
});

test('insert_and_delete_cells_never_shift_part_of_a_table', async () => {
  // insert.table (U:grid/insert) writes this record.
  const t = await session(workbook([{id: 's1', name: 'Sheet1',
    tables: [{name: 'Table1', range: 'D8:F10', headerRow: true, columns: [{name: 'a'}, {name: 'b'}, {name: 'c'}]}]}]));
  await run(t, 'range.setValues', {range: 'D8', values: [['a', 'b', 'c'], [1, 2, 3], [4, 5, 6]]});
  for (const [cmd, range, shift] of [
    ['home.deleteCells', 'E9:G9', 'left'], ['home.deleteCells', 'E9', 'up'], ['home.insertCells', 'C9:D9', 'down'],
    ['home.deleteCells', 'D8:F8', 'up'], ['home.insertCells', 'A9:B9', 'right'],
  ]) assert.match((await fails(t, cmd, {range, shift})).message, /shift cells in a table/, `${cmd} ${range} ${shift}`);
  // Whole table columns: the table loses (or gains) columns with them.
  await run(t, 'home.deleteCells', {range: 'E7:E12', shift: 'left'});
  const names = () => t.content.sheets[0].tables[0].columns.map(c => c.name);
  assert.deepEqual(names(), ['a', 'c']);
  assert.equal(t.content.sheets[0].tables[0].range, 'D8:E10');
  await run(t, 'home.insertCells', {range: 'E8:E10', shift: 'right'});
  // shift_table_columns names the new column Column<n+1> (n = the columns it had); Excel's header
  // text for the blank header cell is the table unit's (U:grid/insert) to write.
  assert.deepEqual(names(), ['a', 'Column3', 'c']);
  assert.equal(t.content.sheets[0].tables[0].range, 'D8:F10');
});

test('copies_of_a_long_named_sheet_get_unique_names', async () => {
  const t = await session();
  await run(t, 'sheet.rename', {sheet: 0, name: 'Long name of a sheet 31 chars!'});
  await run(t, 'sheet.move', {sheet: 0, to: 1, copy: true});
  await run(t, 'sheet.move', {sheet: 0, to: 2, copy: true});
  assert.deepEqual(t.content.sheets.map(x => x.name), ['Long name of a sheet 31 chars!', 'Long name of a sheet 31 cha (2)', 'Long name of a sheet 31 cha (3)']);
});

test('sheets', async () => {
  const t = await session();
  await run(t, 'home.insertSheet', {});
  await run(t, 'cell.set', {cell: 'A1', input: '5'});
  await run(t, 'sheet.rename', {name: 'Data'});
  await run(t, 'sheet.activate', {sheet: 0});
  await run(t, 'cell.set', {cell: 'A1', input: '=Data!A1*2'});
  assert.equal(v(t, 'A1', 0), 10);
  await run(t, 'sheet.rename', {sheet: 'Data', name: 'My Data'});
  assert.equal(f(t, 'A1'), "'My Data'!A1*2");
});

test('sheet_operations_keep_names_on_their_sheets', async () => {
  const t = await session();
  await run(t, 'home.insertSheet', {name: 'Data'});
  await run(t, 'home.insertSheet', {name: 'Notes'});
  const id = n => t.content.sheets.find(x => x.name === n).id;
  // formulas.defineName (U:grid/formulas) writes these records.
  const {names: _n, ...rest} = t.content;
  void rest;
  const t2 = await session(workbook(t.content.sheets, {names: [
    {name: 'Rate', formula: 'Data!$A$1', scope: id('Data')}, {name: 'Rate', formula: 'Notes!$B$1', scope: id('Notes')}, {name: 'Total', formula: 'Data!$C$1'}]}));
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const x = a[i] ?? '', y = b[i] ?? ''; if (x !== y) return x < y ? -1 : 1; } return 0; };
  const list = () => t2.content.names.map(n => [n.name, n.scope ? t2.content.sheets.find(x => x.id === n.scope)?.name ?? null : null, n.formula]).sort(cmp);
  await run(t2, 'sheet.move', {sheet: 'Data', to: 2});
  assert.deepEqual(list(), [['Rate', 'Data', 'Data!$A$1'], ['Rate', 'Notes', 'Notes!$B$1'], ['Total', null, 'Data!$C$1']]);
  await run(t2, 'sheet.move', {sheet: 'Data', to: 0, copy: true});
  assert.equal(t2.content.sheets[0].name, 'Data (2)');
  assert.deepEqual(list(), [['Rate', 'Data', 'Data!$A$1'], ['Rate', 'Data (2)', "'Data (2)'!$A$1"], ['Rate', 'Notes', 'Notes!$B$1'], ['Total', null, 'Data!$C$1']]);
  await run(t2, 'home.deleteSheet', {sheet: 'Data'});
  assert.deepEqual(list(), [['Rate', 'Data (2)', "'Data (2)'!$A$1"], ['Rate', 'Notes', 'Notes!$B$1'], ['Total', null, '#REF!']]);
});

test('deleting_a_3d_span_end_sheet_keeps_the_rest', async () => {
  const book = async () => {
    const t = await session();
    for (const name of ['Sheet2', 'Sheet3', 'Results']) await run(t, 'home.insertSheet', {name});
    for (const [sheet, n] of [['Sheet1', 3], ['Sheet2', 5], ['Sheet3', 7]]) {
      await run(t, 'sheet.activate', {sheet});
      await run(t, 'cell.set', {cell: 'A1', input: String(n)});
    }
    await run(t, 'sheet.activate', {sheet: 'Results'});
    await run(t, 'cell.set', {cell: 'A1', input: '=SUM(Sheet1:Sheet3!A1)'});
    await run(t, 'cell.set', {cell: 'B1', input: '=Sheet1!A1'});
    return t;
  };
  for (const [deleted, total, direct] of [['Sheet1', 12, '#REF!'], ['Sheet3', 8, 3], ['Sheet2', 10, 3]]) {
    const t = await book();
    await run(t, 'home.deleteSheet', {sheet: deleted});
    const ri = t.content.sheets.findIndex(x => x.name === 'Results');
    assert.equal(v(t, 'A1', ri), total, `deleting ${deleted}`);
    const b = v(t, 'B1', ri);
    assert.equal(typeof direct === 'string' ? errorOf(b) : b, direct, `deleting ${deleted}`);
  }
});
