// Ported from gridcraft crates/engine/src/cmd/edit/tests.rs at 146161b4b450a56e5e59a083ba0478582d1e602b
// (every #[test] of the module; the Rust test name is in each test title).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: cmd/edit/go_to.rs (Go To references, names, recent list), cell.rs (`cell_set`
//    numbers/booleans, legacy arrays), find.rs (`wildcard`, `replace_ci`), clipboard.rs
//    (`parse_tsv`), paste_special.rs (operations, cut overflow). Excel does the same: Go To lists
//    named ranges of every sheet, keeps the references typed, refuses references on two sheets;
//    Paste Special Multiply keeps text and errors and wraps formulas as =(f)*n.
// 2. Ours runs the same commands on schema-2 workbooks through the kernel session (undoable edits,
//    view-state selection), with the same messages.
// 3. These tests (engine); the bridge flow is tests/e2e/grid/edit-*.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, v, text, stored, run, fails, selection, errorOf} from '../edit-helpers.mjs';
import {referenceParts, GO_TO_MAX_AREAS, GO_TO_RECENT} from '../../../core/grid/lib/edit-goto.mjs';
import {wildcard, replaceCi} from '../../../core/grid/lib/edit-find.mjs';
import {parseTsv} from '../../../core/grid/lib/edit-clip.mjs';

/** Sheet1 and Sheet2 with a workbook range name, a name scoped to each sheet, a constant, a formula and a hidden name. */
async function goToWorkbook() {
  return session(workbook([{id: 's1', name: 'Sheet1'}, {id: 's2', name: 'Sheet2'}], {names: [
    {name: 'Price', formula: '=Sheet1!$B$2:$B$5'},
    {name: 'type', formula: '=Sheet1!$D$2:$D$5'},
    {name: 'Areas', formula: '=Sheet1!$A$1,Sheet1!$C$3:$C$4'},
    {name: 'Local', formula: '=Sheet2!$C$3', scope: 's2'},
    {name: 'Own', formula: '=Sheet1!$E$1', scope: 's1'},
    {name: 'Rate', formula: '=0.07'},
    {name: 'Total', formula: '=SUM(Sheet1!$B$2:$B$5)'},
    {name: 'Secret', formula: 'Sheet1!$Z$9', hidden: true},
  ]}));
}

test('go_to_lists_the_named_ranges_of_every_sheet', async () => {
  const t = await goToWorkbook();
  let list = await run(t, 'edit.goTo', {list: true});
  assert.deepEqual(list.names, ['Areas', 'Own', 'Price', 'Sheet2!Local', 'type']);
  assert.deepEqual(list.recent, []);
  // Seen from Sheet2, its own name is bare and Sheet1's is qualified.
  await run(t, 'selection.set', {sheet: 1});
  list = await run(t, 'edit.goTo', {list: true});
  assert.deepEqual(list.names, ['Areas', 'Local', 'Price', 'Sheet1!Own', 'type']);
});

test('go_to_a_name_scoped_to_another_sheet_goes_to_that_sheet', async () => {
  const t = await goToWorkbook();
  let out = await run(t, 'edit.goTo', {reference: 'Sheet2!Local'});
  assert.equal(out.selection, 'C3');
  assert.equal((await selection(t)).sheet, 1);
  // A name of several areas selects all of them.
  out = await run(t, 'edit.goTo', {reference: 'Areas'});
  assert.equal(out.selection, 'A1,C3:C4');
  assert.equal((await selection(t)).sheet, 0);
});

test('go_to_matches_a_sheet_name_in_any_case', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}, {id: 's2', name: 'Sheet2'}], {names: [
    {name: 'Price', formula: '=Sheet1!$B$2:$B$5'}, {name: 'type', formula: '=Sheet1!$D$2:$D$5'},
    {name: 'Areas', formula: '=Sheet1!$A$1,Sheet1!$C$3:$C$4'}, {name: 'Local', formula: '=Sheet2!$C$3', scope: 's2'},
    {name: 'Own', formula: '=Sheet1!$E$1', scope: 's1'}, {name: 'Rate', formula: '=0.07'}, {name: 'Total', formula: '=SUM(Sheet1!$B$2:$B$5)'},
    {name: 'Secret', formula: 'Sheet1!$Z$9', hidden: true},
    {name: 'Größe', formula: '=Sheet2!$D$4', scope: 's2'}, {name: 'GRÖSSE', formula: '=Sheet1!$F$6'},
  ]}));
  const out = await run(t, 'edit.goTo', {reference: 'Sheet2!GRÖSSE'});
  assert.equal(out.selection, 'D4');
  // Seen from Sheet2, its own name hides the workbook name it shares.
  const list = await run(t, 'edit.goTo', {list: true});
  assert.deepEqual(list.names, ['Areas', 'Größe', 'Local', 'Price', 'Sheet1!Own', 'type']);
});

test('go_to_selects_every_reference_and_name_in_a_list', async () => {
  const t = await goToWorkbook();
  let out = await run(t, 'edit.goTo', {reference: 'B14:C22,F19:G30,H21:H29'});
  assert.equal(out.selection, 'B14:C22,F19:G30,H21:H29');
  out = await run(t, 'edit.goTo', {reference: 'Price, Type'});
  assert.equal(out.selection, 'B2:B5,D2:D5');
  out = await run(t, 'edit.goTo', {reference: 'Sheet2!$A$1,Sheet2!B2'});
  assert.equal(out.selection, 'A1,B2');
  assert.equal((await selection(t)).sheet, 1);
  // Areas on two sheets, and a part that is not a reference, leave the selection alone.
  for (const bad of ['A1,Sheet1!B2', 'A1,Rate', 'A1,', 'Total']) {
    await fails(t, 'edit.goTo', {reference: bad});
    assert.equal((await selection(t)).a1, 'A1,B2', bad);
  }
});

test('go_to_reads_the_parts_of_a_long_reference_one_at_a_time', async () => {
  const parts = referenceParts("A1, 'Q1, Q2'!B2,SUM(C3,D4)");
  assert.deepEqual([...parts], ['A1', "'Q1, Q2'!B2", 'SUM(C3,D4)']);
  assert.deepEqual([...referenceParts('')], ['']);
  const t = await goToWorkbook();
  const e = await fails(t, 'edit.goTo', {reference: 'A1,'.repeat(GO_TO_MAX_AREAS + 1)});
  assert.match(e.message, /at most/);
  await fails(t, 'edit.goTo', {reference: `Total${','.repeat(1000)}`});
});

test('go_to_keeps_the_references_entered_newest_first', async () => {
  const t = await goToWorkbook();
  await run(t, 'edit.goTo', {reference: 'B14:C22,F19:G30', record: true});
  await run(t, 'edit.goTo', {reference: 'Sheet2!A5', record: true});
  // Names are listed already; a call without `record` (the Name Box) is not kept.
  await run(t, 'edit.goTo', {reference: 'Price', record: true});
  await run(t, 'edit.goTo', {reference: 'Z9'});
  await run(t, 'edit.goTo', {reference: 'b14:c22,f19:g30', record: true});
  let list = await run(t, 'edit.goTo', {list: true});
  assert.deepEqual(list.recent, ['Sheet1!B14:C22,Sheet1!F19:G30', 'Sheet2!A5']);
  // Going back from Sheet2 to a recent reference returns to its sheet.
  await run(t, 'selection.set', {sheet: 1});
  const out = await run(t, 'edit.goTo', {reference: 'Sheet1!B14:C22,Sheet1!F19:G30', record: true});
  assert.equal(out.selection, 'B14:C22,F19:G30');
  assert.equal((await selection(t)).sheet, 0);
  for (let i = 0; i < GO_TO_RECENT + 2; i++) await run(t, 'edit.goTo', {reference: `A${i + 1}`, record: true});
  list = await run(t, 'edit.goTo', {list: true});
  assert.equal(list.recent.length, GO_TO_RECENT);
  assert.equal(list.recent[0], `Sheet1!A${GO_TO_RECENT + 2}`);
});

test('cell_set_takes_numbers_for_input_and_value', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: 123.5});
  await run(t, 'cell.set', {cell: 'A2', value: 77});
  await run(t, 'cell.set', {cell: 'A3', input: true});
  await run(t, 'cell.set', {cell: 'A4', input: '=A1+A2'});
  assert.equal(v(t, 'A1'), 123.5);
  assert.equal(v(t, 'A2'), 77);
  assert.equal(v(t, 'A3'), true);
  assert.equal(v(t, 'A4'), 200.5);
  await fails(t, 'cell.set', {cell: 'A5'});
});

test('legacy_array_entry', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'B2', values: [[1], [2]]});
  await run(t, 'cell.set', {cell: 'C4', input: 'old'});
  await run(t, 'selection.set', {range: 'C2:C4'});
  await run(t, 'cell.set', {cell: 'C2', input: '=B2:B3*2', array: true});
  assert.equal(v(t, 'C3'), 4);
  // Past the result Excel shows #N/A; the old content of the range is replaced.
  assert.equal(text(t, 'C4'), '#N/A');
  assert.deepEqual(stored(t, 'C2'), {f: 'B2:B3*2', a: 'C2:C4'});
});

test('an_array_entered_outside_the_selection_covers_only_its_cell', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'K20', input: 'keep'});
  await run(t, 'selection.set', {range: 'K20:K22'});
  await run(t, 'cell.set', {cell: 'H5', input: '=1+1', array: true});
  assert.equal(stored(t, 'H5').a, 'H5');
  assert.equal(v(t, 'K20'), 'keep');
});

test('wildcards', () => {
  assert.ok(wildcard('hello', 'h*o'));
  assert.ok(wildcard('hello', 'h?llo'));
  assert.ok(!wildcard('hello', 'h?lo'));
  assert.ok(wildcard('a*b', 'a~*b'));
  assert.ok(!wildcard('axb', 'a~*b'));
  assert.ok(wildcard('', '*'));
});

test('tsv', () => {
  assert.deepEqual(parseTsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseTsv('"x\ty"\tz'), [['x\ty', 'z']]);
  assert.deepEqual(parseTsv('"he said ""hi"""'), [['he said "hi"']]);
});

test('paste_special_operations_keep_text_errors_and_formulas', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [["'123", 'Total', '=NA()', '=B3*2', 5], [1, null, null, null, null], [null, 4, null, null, null]]});
  assert.equal(v(t, 'A1'), '123');
  await run(t, 'edit.copy', {range: 'A2'});
  await run(t, 'selection.set', {range: 'A1:E1'});
  await run(t, 'edit.pasteSpecial', {what: 'values', operation: 'multiply'});
  assert.equal(v(t, 'A1'), 123);
  assert.equal(v(t, 'B1'), 'Total');
  assert.equal(errorOf(v(t, 'C1')), '#N/A');
  assert.equal(stored(t, 'D1').f, '(B3*2)*1');
  assert.equal(v(t, 'D1'), 8);
  assert.equal(v(t, 'E1'), 5);
});

test('cut_paste_that_overflows_the_grid_moves_nothing', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2]]});
  await run(t, 'edit.cut', {range: 'A1:A2'});
  // Transposed, the 2 rows become 2 columns and the second one is past XFD.
  await fails(t, 'edit.pasteSpecial', {what: 'all', transpose: true, at: 'XFD1'});
  assert.equal(v(t, 'A1'), 1);
  assert.equal(v(t, 'A2'), 2);
  // Not transposed, the second row would be past the last row.
  await fails(t, 'edit.pasteSpecial', {what: 'all', at: 'A1048576'});
  assert.equal(v(t, 'A1'), 1);
  assert.equal(v(t, 'A2'), 2);
  // Not transposed it still fits in column XFD.
  await run(t, 'edit.pasteSpecial', {what: 'all', at: 'XFD1'});
  assert.equal(v(t, 'XFD1'), 1);
  assert.equal(v(t, 'XFD2'), 2);
});

test('replace_case_insensitive', () => {
  assert.equal(replaceCi('Apple apple APPLE', 'apple', 'pear'), 'pear pear pear');
});

test('replace_case_insensitive_keeps_text_when_folding_moves_boundaries', async () => {
  const t = await session();
  const s = 'Kİİ';
  await run(t, 'cell.set', {cell: 'A1', input: s});
  await run(t, 'edit.replace', {what: 'k', with: 'x'});
  assert.equal(v(t, 'A1'), s);
});

test('set_values_can_store_strings_as_the_text_they_are', async () => {
  const t = await session();
  const strings = ['05.04.2026', '02/11/2026', '2.500', '4.25 %', '=1+1', "'keep"];
  // The default is unchanged: the dates swap, the thousands separator is a decimal point.
  await run(t, 'range.setValues', {range: 'A1', values: [strings]});
  assert.equal(text(t, 'A1'), '5/4/2026', 'dd.mm.yyyy read as mm.dd.yyyy');
  assert.equal(v(t, 'C1'), 2.5, '"2.500" read as a decimal');
  assert.equal(v(t, 'D1'), 0.0425, '"4.25 %" read as a percentage');
  // With parse: false each string is the text it was given, and a formula is still a formula.
  await run(t, 'range.setValues', {range: 'A3', parse: false, values: [strings]});
  strings.forEach((want, i) => {
    const cell = `${String.fromCharCode(65 + i)}3`;
    if (want === '=1+1') {
      assert.equal(v(t, cell), 2, `${cell} is still a formula`);
      assert.equal(stored(t, cell).f, '1+1');
    } else {
      assert.equal(v(t, cell), want, `${cell} is the text it was given`);
      assert.equal(stored(t, cell).f, undefined, `${cell} is not a formula`);
    }
  });
  // Numbers and booleans are untouched either way.
  await run(t, 'range.setValues', {range: 'A5', parse: false, values: [[12.5, true, null]]});
  assert.equal(v(t, 'A5'), 12.5);
  assert.equal(v(t, 'B5'), true);
  assert.equal(text(t, 'C5'), '');
  // parse is a flag; anything else is a usage error rather than a quiet default.
  await run(t, 'range.setValues', {range: 'A7', parse: true, values: [['2.500']]});
  assert.equal(v(t, 'A7'), 2.5);
  await fails(t, 'range.setValues', {range: 'A8', parse: 'no', values: [['x']]});
  await fails(t, 'range.setValues', {range: 'A8', parse: 0, values: [['x']]});
  // A line break still turns on Wrap Text.
  await run(t, 'range.setValues', {range: 'A9', parse: false, values: [['one\ntwo']]});
  assert.equal(v(t, 'A9'), 'one\ntwo');
  const {style} = await import('../edit-helpers.mjs');
  assert.equal(style(t, 'A9').align.wrap, true);
});
