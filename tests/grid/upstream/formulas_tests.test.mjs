// Ported from gridcraft crates/engine/src/cmd/formulas.rs `mod tests` at
// 146161b4b450a56e5e59a083ba0478582d1e602b (every #[test]; the Rust name is each test's title).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: formulas.rs define_name (relative references kept relative to A1, unions),
//    delete_name, name_manager (union preview), create_from_selection, paste_name (list, Paste
//    List, InsertName), stash.rs holds_item (GridCraft's hidden `_gc_`/`_sc_` names refused
//    without force). Excel: Define Name with a relative reference is relative to the active cell;
//    Paste Name lists workbook and active-sheet names; Paste List writes two columns.
// 2. Ours runs the same commands on schema-2 workbooks through the kernel session; the UiRequest
//    InsertName is the `insertNameRequest` view state the grid surface answers.
// 3. These tests (engine); the bridge flow is tests/e2e/grid/formulas-ribbon.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, v, stored, run, fails} from '../edit-helpers.mjs';
import {MAX_ROWS, MAX_COLS, colToLetters} from '../../../core/grid/lib/addr.mjs';

const named = n => ({...n});

test('names_with_relative_references', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2], [3]]});
  // Defined from B2, `=Sheet1!A2` is "the cell to the left".
  await run(t, 'selection.set', {range: 'B2'});
  let r = await run(t, 'formulas.defineName', {name: 'LeftCell', refersTo: '=Sheet1!A2'});
  assert.equal(r.refersTo, '=Sheet1!XFD1');
  await run(t, 'cell.set', {cell: 'B1', input: '=LeftCell'});
  await run(t, 'cell.set', {cell: 'B3', input: '=LeftCell*10'});
  assert.equal(v(t, 'B1'), 1);
  assert.equal(v(t, 'B3'), 30);
  // Absolute references are kept as they are.
  r = await run(t, 'formulas.defineName', {name: 'First', refersTo: '=Sheet1!$A$1'});
  assert.equal(r.refersTo, '=Sheet1!$A$1');
});

test('the_name_commands_leave_gridcraft_data_alone', async () => {
  const text = 'm'.repeat(30);
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}], {names: [
    {name: '_gc_macro_1_0', formula: `"${text}"`, hidden: true},
    {name: '_gc_macro_1_1', formula: '"m"', hidden: true},
    {name: '_sc_watch', formula: '"[]"', hidden: true},
    // A legacy item is read whether or not it is hidden, so a visible one is data too.
    {name: '_sc_old', formula: '"[]"'},
  ]}));
  const names = () => structuredClone(t.content.names);
  const before = names();
  for (const params of [
    {name: '_gc_macro_1_0', refersTo: '=1'},
    {name: '_SC_Watch', refersTo: '=1'},
    {name: 'Mine', refersTo: '=1', oldName: '_gc_macro_1_1'},
    {name: '_gc_macro_1_0', refersTo: '=1', force: false},
    {name: 'Mine2', refersTo: '=1', oldName: '_SC_old'},
  ]) {
    const err = await fails(t, 'formulas.defineName', params);
    assert.match(err.message, /force/, JSON.stringify(params));
  }
  for (const name of ['_gc_macro_1_1', '_sc_watch', '_sc_old']) {
    const err = await fails(t, 'formulas.deleteName', {name});
    assert.match(err.message, /force/, name);
  }
  await run(t, 'range.setValues', {range: 'A1:B2', values: [['_gc_macro_1_0', 'Rate'], [1, 2]]});
  const r = await run(t, 'formulas.createFromSelection', {range: 'A1:B2', top: true, replace: true});
  assert.deepEqual([r.created, r.skipped], [1, ['_gc_macro_1_0']]);
  assert.deepEqual(names().filter(n => n.name !== 'Rate'), before);
  // A visible name of the shape is the person's own: changed and removed without force.
  t.content.names; // (read)
  await run(t, 'formulas.defineName', {name: '_gc_rate_0', refersTo: '=1'});
  await run(t, 'formulas.defineName', {name: 'Rate0', refersTo: '=2', oldName: '_gc_rate_0'});
  await run(t, 'formulas.deleteName', {name: 'Rate0'});
  // Ordinary names and forced calls go ahead.
  await run(t, 'formulas.deleteName', {name: 'Rate'});
  await run(t, 'formulas.defineName', {name: '_gc_macro_1_1', refersTo: '=1', force: true});
  await run(t, 'formulas.deleteName', {name: '_gc_macro_1_1', force: true});
  assert.ok(!t.content.names.some(n => n.name === '_gc_macro_1_1'));
  assert.ok(t.content.names.some(n => n.name === '_gc_macro_1_0' && n.formula === `"${text}"`), 'the hidden item is untouched');
});

test('arabic_defined_names_count_characters_not_bytes', async () => {
  const t = await session();
  const arabic = n => 'س'.repeat(n);
  for (const ok of [200, 255]) await run(t, 'formulas.defineName', {name: arabic(ok), refersTo: '=1'});
  await fails(t, 'formulas.defineName', {name: arabic(256), refersTo: '=1'});
  await run(t, 'range.setValues', {range: 'A1', values: [[`ع${arabic(199)}`], [1]]});
  const r = await run(t, 'formulas.createFromSelection', {range: 'A1:A2', top: true});
  assert.equal(r.created, 1);
});

test('names_referring_to_several_ranges', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1:C2', values: [[1, 0, 5], [2, 0, 7]]});
  // Excel writes and accepts a union in a name without parentheses.
  const r = await run(t, 'formulas.defineName', {name: 'u', refersTo: '=Sheet1!$A$1:$A$2,Sheet1!$C$1:$C$2'});
  assert.equal(r.refersTo, '=Sheet1!$A$1:$A$2,Sheet1!$C$1:$C$2');
  for (const [cell, input] of [['E1', '=SUM(u)'], ['E2', '=AREAS(u)'], ['E3', '=MIN(u)'], ['E4', '=INDEX(u,2,1,2)']]) await run(t, 'cell.set', {cell, input});
  assert.equal(v(t, 'E1'), 15);
  assert.equal(v(t, 'E2'), 2);
  assert.equal(v(t, 'E3'), 1);
  assert.equal(v(t, 'E4'), 7);
});

test('name_manager_previews_a_name_over_several_ranges', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1:C2', values: [[1, 0, 5], [2, 0, 7]]});
  await run(t, 'formulas.defineName', {name: 'u', refersTo: '=Sheet1!$A$1:$A$2,Sheet1!$C$1:$C$2'});
  const list = await run(t, 'formulas.nameManager', {});
  const u = list.find(n => n.name === 'u');
  // The union parses as one, so the preview is what the union gives in a cell, not #NAME?.
  assert.deepEqual(u.value, {error: '#VALUE!'});
});

/** `Sales` and `rate`, a hidden name, a name of Sheet1 that hides a workbook `Tax`, and a name of another sheet. */
async function namedWorkbook() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}, {id: 's2', name: 'Sheet2'}]));
  await run(t, 'formulas.defineName', {name: 'Sales', refersTo: '=Sheet1!$A$1:$A$3'});
  await run(t, 'formulas.defineName', {name: 'rate', refersTo: '=0.07'});
  await run(t, 'formulas.defineName', {name: 'Tax', refersTo: '=0.2'});
  const content = structuredClone(t.content);
  content.names.push(named({name: '_Filter', formula: 'Sheet1!$A$1:$B$9', hidden: true}));
  content.names.push(named({name: 'TAX', formula: '0.25', scope: 's1'}));
  content.names.push(named({name: 'Other', formula: '1', scope: 's2'}));
  return session(content);
}

test('paste_names_lists_the_names_the_active_sheet_can_use', async () => {
  const t = await namedWorkbook();
  const r = await run(t, 'formulas.pasteName', {});
  assert.deepEqual(r.names, [
    {name: 'rate', refersTo: '=0.07'},
    {name: 'Sales', refersTo: '=Sheet1!$A$1:$A$3'},
    {name: 'TAX', refersTo: '=0.25'},
  ]);
  assert.equal(stored(t, 'A1'), null, 'listing the names writes nothing');
});

test('paste_names_and_use_in_formula_ask_the_ui_to_insert_the_name', async () => {
  const t = await namedWorkbook();
  await run(t, 'formulas.pasteName', {name: 'Sales'});
  assert.equal(t.doc.view.insertNameRequest.name, 'Sales');
  assert.equal(stored(t, 'A1'), null, 'the cell changes only when the edit is entered');
  // A name Paste Name doesn't list is refused; one typed in another case is pasted as listed.
  await fails(t, 'formulas.pasteName', {name: 'NoSuchName'});
  await run(t, 'formulas.pasteName', {name: 'SALES'});
  assert.equal(t.doc.view.insertNameRequest.name, 'Sales');
});

test('paste_list_writes_each_name_and_what_it_refers_to', async () => {
  const t = await namedWorkbook();
  await run(t, 'selection.set', {range: 'D2'});
  const r = await run(t, 'formulas.pasteName', {list: true});
  assert.equal(r.range, 'D2:E4');
  const rows = [['D2', 'rate'], ['E2', '=0.07'], ['D3', 'Sales'], ['E3', '=Sheet1!$A$1:$A$3'], ['D4', 'TAX'], ['E4', '=0.25']];
  for (const [cell, text] of rows) assert.equal(v(t, cell), text, cell);
  assert.equal(stored(t, 'E3').f, undefined, 'refers-to is text');
  await t.undo();
  for (const [cell] of rows) assert.equal(v(t, cell), null, `${cell} after Undo`);
  await run(t, 'formulas.pasteName', {list: true, at: 'B7'});
  assert.equal(v(t, 'B7'), 'rate');
});

test('paste_list_needs_names_and_room', async () => {
  const t = await namedWorkbook();
  await fails(t, 'formulas.pasteName', {list: true, at: `A${MAX_ROWS - 1}`});
  await fails(t, 'formulas.pasteName', {list: true, at: `${colToLetters(MAX_COLS - 1)}1`});
  const empty = await session();
  await fails(empty, 'formulas.pasteName', {list: true});
  assert.deepEqual((await run(empty, 'formulas.pasteName', {})).names, []);
});
