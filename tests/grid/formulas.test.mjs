// U:grid/formulas engine tests: the Formulas tab's commands on schema-2 workbooks, the tests of
// gridcraft crates/engine/src/tests.rs that drive them (ported, Rust names in the titles) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, and an undo round trip for every edit command.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: cmd/formulas.rs:93-205 (AutoSum: totals in an empty last row/column else past the
//    selection, one undo step; a single cell guesses the numbers above else to the left),
//    :340-418 (Define Name, Name Manager › Edit renames in formulas), :526-591 (Create from
//    Selection), :670-722 (Select Precedents/Dependents, every level with all), :731-770 (Show
//    Formulas, Convert to Number keeps the format), :772-835 (Error Checking with quoted circular
//    references, Evaluate Formula steps, Evaluate refusing what entry refuses), :837-871 (Calculate
//    Now, Calculation Options with Excel's limits). Excel: the same results; Trace Precedents/
//    Dependents draw arrows on the sheet; Remove Arrows clears them.
// 2. Ours: the same commands on the kernel session; the arrows, the edit started by Insert
//    Function / AutoSum without numbers and the name pasted at the caret are view state the grid
//    surface reads (traceArrows, editCellRequest, insertNameRequest).
// 3. These tests; the ribbon flow is tests/e2e/grid/formulas-ribbon.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, v, stored, style, run, fails, selection, errorOf} from './edit-helpers.mjs';
import {functionList, signatureArgs, functionsFor} from '../../core/grid/lib/formulas-catalog.mjs';
import {validName} from '../../core/grid/lib/formulas-names.mjs';

const formulaAt = (t, a) => stored(t, a)?.f ?? null;

test('autosum_over_whole_rows_is_one_undo_step_within_the_data', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A3', values: [[1, 2], [3, 4], [5, 6]]});
  await run(t, 'formulas.autoSum', {range: '3:5'});
  assert.equal(v(t, 'A6'), 9);
  assert.equal(v(t, 'B6'), 12);
  assert.equal(stored(t, 'C6'), null);
  await t.undo();
  assert.equal(v(t, 'A6'), null);
  assert.equal(v(t, 'B6'), null);
});

test('autosum_over_a_row_totals_it_to_the_right', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'B2', values: [[1, 2, 3, 4]]});
  await run(t, 'formulas.autoSum', {range: 'B2:E2'});
  assert.equal(formulaAt(t, 'F2'), 'SUM(B2:E2)');
  assert.equal(v(t, 'F2'), 10);
  for (const c of ['B3', 'C3', 'D3', 'E3', 'F3']) assert.equal(v(t, c), null, 'nothing under the row');
  await run(t, 'range.setValues', {range: 'B4', values: [[5, 6, 7]]});
  await run(t, 'formulas.autoSum', {range: 'B4:E4'});
  assert.equal(formulaAt(t, 'E4'), 'SUM(B4:D4)');
  assert.equal(v(t, 'F4'), null);
  await run(t, 'formulas.autoSum', {range: 'B2:E2', function: 'average'});
  assert.equal(formulaAt(t, 'F2'), 'AVERAGE(B2:E2)');
});

test('autosum_over_a_whole_row_totals_it_after_the_data', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A2', values: [[1, 2, 3]]});
  await run(t, 'formulas.autoSum', {range: '2:2'});
  assert.equal(formulaAt(t, 'D2'), 'SUM(A2:C2)');
  assert.equal(stored(t, 'E2'), null, 'not out to the last column');
});

test('autosum_fills_a_selections_empty_last_column_and_row', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1, 2], [3, 4]]});
  await run(t, 'formulas.autoSum', {range: 'A1:C2'});
  assert.deepEqual([formulaAt(t, 'C1'), formulaAt(t, 'C2')], ['SUM(A1:B1)', 'SUM(A2:B2)']);
  assert.deepEqual([v(t, 'C1'), v(t, 'C2')], [3, 7]);
  for (const c of ['A3', 'B3', 'C3']) assert.equal(v(t, c), null, 'no totals under the rows');
  await run(t, 'range.setValues', {range: 'E1', values: [[1, 2], [3, 4]]});
  await expectUndoRoundTrip(t, 'formulas.autoSum', {range: 'E1:G3'}, ({content}) => {
    assert.ok(content.sheets[0].blocks);
  });
  await run(t, 'formulas.autoSum', {range: 'E1:G3'});
  for (const [cell, f, value] of [['E3', 'SUM(E1:E2)', 4], ['F3', 'SUM(F1:F2)', 6], ['G1', 'SUM(E1:F1)', 3], ['G2', 'SUM(E2:F2)', 7], ['G3', 'SUM(E1:F2)', 10]]) {
    assert.equal(formulaAt(t, cell), f, cell);
    assert.equal(v(t, cell), value, cell);
  }
  await run(t, 'range.setValues', {range: 'I1', values: [[1, 2], [3, 4]]});
  await run(t, 'formulas.autoSum', {range: 'I1:J2'});
  assert.deepEqual([formulaAt(t, 'I3'), formulaAt(t, 'J3')], ['SUM(I1:I2)', 'SUM(J1:J2)']);
  assert.equal(v(t, 'K1'), null);
});

test('autosum in one cell sums the numbers above, else to the left, else starts =SUM()', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'B1', values: [[1], [2], [null], [4]]});
  await run(t, 'selection.set', {range: 'B5'});
  const r = await run(t, 'formulas.autoSum', {});
  assert.equal(r.formula, '=SUM(B1:B4)');
  assert.equal(v(t, 'B5'), 7);
  await run(t, 'range.setValues', {range: 'D7', values: [[3, 4]]});
  await run(t, 'selection.set', {range: 'F7'});
  assert.equal((await run(t, 'formulas.autoSum', {function: 'MAX'})).formula, '=MAX(D7:E7)');
  await run(t, 'selection.set', {range: 'H20'});
  await run(t, 'formulas.autoSum', {});
  assert.equal(t.doc.view.editCellRequest.text, '=SUM()');
  assert.equal(stored(t, 'H20'), null);
  await run(t, 'selection.set', {range: 'B5'});
  await run(t, 'formulas.autoSum', {enter: false, function: 'COUNT'});
  assert.equal(t.doc.view.editCellRequest.text, '=COUNT(B1:B4)');
});

test('editing_a_name_renames_it_in_formulas', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: '21'});
  await run(t, 'formulas.defineName', {name: 'Price', refersTo: '=Sheet1!$A$1'});
  await run(t, 'formulas.defineName', {name: 'Other', refersTo: '=1'});
  await run(t, 'cell.set', {cell: 'B1', input: '=Price*2'});
  await fails(t, 'formulas.defineName', {name: 'Other', refersTo: '=Sheet1!$A$1', oldName: 'Price'});
  await run(t, 'formulas.defineName', {name: 'Cost', refersTo: '=Sheet1!$A$1', comment: 'unit', oldName: 'Price'});
  assert.deepEqual(t.content.names.map(n => n.name), ['Other', 'Cost']);
  assert.equal(formulaAt(t, 'B1'), 'Cost*2');
  assert.equal(v(t, 'B1'), 42);
  await fails(t, 'formulas.defineName', {name: 'X', oldName: 'Missing'});
});

test('create_names_from_the_chosen_edges', async () => {
  const t = await session();
  const names = () => t.content.names.map(n => [n.name, n.formula]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  await run(t, 'range.setValues', {range: 'A1', values: [['', 'Jan', 'Feb', ''], ['North', 1, 2, 'N'], ['South', 3, 4, 'S'], ['', 'First', 'Second', '']]});
  await run(t, 'formulas.createFromSelection', {range: 'A1:D4', top: false, bottom: true, right: true});
  assert.deepEqual(names(), [['First', 'Sheet1!$B$1:$B$3'], ['N', 'Sheet1!$A$2:$C$2'], ['S', 'Sheet1!$A$3:$C$3'], ['Second', 'Sheet1!$C$1:$C$3']]);
  let r = await run(t, 'formulas.createFromSelection', {range: 'A1:C3', top: true, left: true});
  assert.equal(r.created, 4);
  r = await run(t, 'formulas.createFromSelection', {range: 'B1:C3', top: true});
  assert.deepEqual([r.created, r.skipped], [0, ['Jan', 'Feb']]);
  await run(t, 'cell.set', {cell: 'B1', input: 'N'});
  r = await run(t, 'formulas.createFromSelection', {range: 'B1:B3', replace: true});
  assert.equal(r.created, 1);
  assert.ok(names().some(([n, f]) => n === 'N' && f === 'Sheet1!$B$2:$B$3'));
  assert.ok(names().some(([n, f]) => n === 'North' && f === 'Sheet1!$B$2:$C$2'));
});

test('names_that_look_like_references_are_refused', async () => {
  const t = await session();
  for (const bad of ['R1C1', 'r2', 'C3', 'RC', 'R', 'c', 'rc12', 'A1', 'XFD1048576', '1st']) {
    await fails(t, 'formulas.defineName', {name: bad, refersTo: '=1'});
    assert.equal(validName(bad), false, bad);
  }
  for (const good of ['R1C1X', 'Rate', 'RCx', 'Rx', '_R1', 'Cost']) await run(t, 'formulas.defineName', {name: good, refersTo: '=1'});
});

test('sheet-scoped names and delete in one scope', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}, {id: 'd', name: 'Data'}, {id: 'n', name: 'Notes'}]));
  await run(t, 'formulas.defineName', {name: 'Rate', refersTo: '=Data!$A$1', scope: 'Data'});
  await run(t, 'formulas.defineName', {name: 'Rate', refersTo: '=Notes!$B$1', scope: 'Notes'});
  await run(t, 'formulas.defineName', {name: 'Total', refersTo: '=Data!$C$1'});
  assert.deepEqual(t.content.names.map(n => [n.name, n.scope ?? null]), [['Rate', 'd'], ['Rate', 'n'], ['Total', null]]);
  await run(t, 'formulas.deleteName', {name: 'rate', scope: 'Notes'});
  assert.deepEqual(t.content.names.map(n => n.scope ?? null), ['d', null]);
  await fails(t, 'formulas.deleteName', {name: 'Total', scope: 'Notes'});
  await run(t, 'formulas.deleteName', {name: 'Total', scope: 'Workbook'});
  assert.equal(t.content.names.length, 1);
  const list = await run(t, 'formulas.nameManager', {});
  assert.deepEqual(list.map(n => [n.name, n.scope, n.refersTo]), [['Rate', 'Data', '=Data!$A$1']]);
});

test('define name defaults to the selection, and the undo round trips', async () => {
  const t = await session();
  await run(t, 'selection.set', {range: 'B2:C4'});
  await expectUndoRoundTrip(t, 'formulas.defineName', {name: 'Block'}, ({content}) => {
    assert.deepEqual(content.names, [{name: 'Block', formula: 'Sheet1!$B$2:$C$4'}]);
  });
  await run(t, 'formulas.defineName', {name: 'Block'});
  await expectUndoRoundTrip(t, 'formulas.deleteName', {name: 'Block'});
  await run(t, 'range.setValues', {range: 'A1', values: [['Head'], [1]]});
  await expectUndoRoundTrip(t, 'formulas.createFromSelection', {range: 'A1:A2'});
  await expectUndoRoundTrip(t, 'formulas.pasteName', {list: true, at: 'E1'});
  await fails(t, 'formulas.defineName', {name: 'Bad name', refersTo: '=1'});
  await fails(t, 'formulas.defineName', {name: 'Broken', refersTo: '=SUM(('});
});

test('trace precedents and dependents report the cells and set the arrows; remove arrows clears them', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}, {id: 's2', name: 'Sheet2'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2]]});
  await run(t, 'cell.set', {cell: 'B1', input: '=SUM(A1:A2)+Sheet2!C3'});
  await run(t, 'cell.set', {cell: 'C1', input: '=B1*2'});
  await run(t, 'cell.set', {cell: 'D1', input: '=B1+C1'});
  await run(t, 'selection.set', {range: 'B1'});
  const pre = await run(t, 'formulas.tracePrecedents', {});
  assert.deepEqual(pre, [{sheet: 'Sheet1', range: 'A1:A2'}, {sheet: 'Sheet2', range: 'C3'}]);
  const dep = await run(t, 'formulas.traceDependents', {});
  assert.deepEqual(dep, [{sheet: 'Sheet1', cell: 'C1'}, {sheet: 'Sheet1', cell: 'D1'}]);
  const arrows = t.doc.view.traceArrows;
  assert.deepEqual([arrows.sheet, arrows.row, arrows.col], ['s1', 0, 1]);
  assert.equal(arrows.precedents.length, 2);
  assert.equal(arrows.dependents.length, 2);
  await run(t, 'formulas.removeArrows', {kind: 'dependents'});
  assert.equal(t.doc.view.traceArrows.dependents.length, 0);
  await run(t, 'formulas.removeArrows', {});
  assert.equal(t.doc.view.traceArrows, null);
});

test('select precedents and dependents, one level or all', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [2]]});
  await run(t, 'cell.set', {cell: 'B1', input: '=SUM(A1:A2)'});
  await run(t, 'cell.set', {cell: 'C1', input: '=B1*2'});
  await run(t, 'cell.set', {cell: 'D1', input: '=C1+1'});
  await run(t, 'selection.set', {range: 'D1'});
  await run(t, 'formulas.selectPrecedents', {});
  assert.equal((await selection(t)).a1, 'C1');
  await run(t, 'selection.set', {range: 'D1'});
  await run(t, 'formulas.selectPrecedents', {all: true});
  assert.equal((await selection(t)).a1, 'A1,A2,B1,C1');
  await run(t, 'selection.set', {range: 'A1'});
  await run(t, 'formulas.selectDependents', {all: true});
  assert.equal((await selection(t)).a1, 'B1,C1,D1');
  await run(t, 'selection.set', {range: 'A2'});
  await run(t, 'formulas.selectDependents', {});
  assert.equal((await selection(t)).a1, 'B1');
  await run(t, 'selection.set', {range: 'F9'});
  const e = await fails(t, 'formulas.selectPrecedents', {});
  assert.match(e.message, /No precedent cells/);
});

test('show formulas toggles the sheet and undoes', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'formulas.showFormulas', {}, ({content}) => assert.equal(content.sheets[0].showFormulas, true));
  assert.equal(t.state('formulas.showFormulas').checked, true, 'redo left it on');
  await run(t, 'formulas.showFormulas', {on: false});
  assert.equal(t.state('formulas.showFormulas').checked, false);
  await run(t, 'formulas.showFormulas', {on: true});
  assert.equal(t.state('formulas.showFormulas').checked, true);
  assert.deepEqual(await run(t, 'formulas.showFormulas', {}), {on: false});
});

test('convert_to_number_turns_numbers_stored_as_text_into_numbers', async () => {
  const t = await session();
  for (const [cell, input] of [['A1', "'123"], ['A2', "'1,000.5"], ['A3', "'abc"], ['A4', "'3/4/2026"], ['A5', '="7"']]) await run(t, 'cell.set', {cell, input});
  await run(t, 'home.bold', {range: 'A1'});
  const r = await run(t, 'formulas.convertToNumber', {range: 'A1:A5'});
  assert.equal(r.converted, 2);
  assert.equal(v(t, 'A1'), 123);
  assert.equal(v(t, 'A2'), 1000.5);
  assert.equal(v(t, 'A3'), 'abc');
  assert.equal(v(t, 'A4'), '3/4/2026');
  assert.equal(v(t, 'A5'), '7');
  assert.equal(style(t, 'A1').font.bold, true, 'the format is kept');
  await run(t, 'cell.set', {cell: 'B1', input: '=SUM(A1:A2)'});
  assert.equal(v(t, 'B1'), 1123.5);
  await t.undo();
  await t.undo();
  assert.equal(v(t, 'A1'), '123');
  await run(t, 'selection.set', {range: 'A2'});
  assert.equal((await run(t, 'formulas.convertToNumber', {})).converted, 1);
  assert.equal(v(t, 'A1'), '123');
  await run(t, 'selection.set', {range: 'A1'});
  await expectUndoRoundTrip(t, 'formulas.convertToNumber', {});
});

test('error_checking_quotes_sheet_names_in_circular_references', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}, {id: 'b', name: "Bob's Q1"}]));
  await run(t, 'cell.set', {cell: "'Bob''s Q1'!B2", input: '=B2+1'});
  await run(t, 'cell.set', {cell: 'A3', input: '=1/0'});
  const r = await run(t, 'formulas.errorChecking', {});
  assert.deepEqual(r.circular, ["'Bob''s Q1'!B2"]);
  assert.deepEqual(r.errors.find(e => e.cell === 'A3'), {sheet: 'Sheet1', cell: 'A3', error: '#DIV/0!', formula: '=1/0'});
  await run(t, 'cell.set', {cell: 'A1', input: `=ROW(${r.circular[0]})`});
  assert.equal(v(t, 'A1'), 2);
});

test('evaluate_refuses_what_entry_refuses_and_says_why', async () => {
  const t = await session();
  let e = await fails(t, 'formulas.evaluate', {formula: '=SUM(1;2)'});
  assert.match(e.message, /There's a problem with this formula/);
  e = await fails(t, 'formulas.evaluate', {formula: '=DATEDIF(1,2)'});
  assert.match(e.message, /too few arguments/);
  assert.deepEqual(await run(t, 'formulas.evaluate', {formula: '=SOMME(1,2)'}), {error: '#NAME?'});
  assert.equal(await run(t, 'formulas.evaluate', {formula: '=SUM(1,2'}), 3);
  assert.equal(await run(t, 'formulas.evaluate', {formula: '1/4'}), 0.25);
});

test('evaluate formula lists the steps innermost first', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[2], [3]]});
  await run(t, 'cell.set', {cell: 'B1', input: '=SUM(A1:A2)*2'});
  await run(t, 'selection.set', {range: 'B1'});
  const r = await run(t, 'formulas.evaluateFormula', {});
  assert.equal(r.formula, '=SUM(A1:A2)*2');
  assert.equal(r.result, 10);
  assert.deepEqual(r.steps.map(s => s.expression), ['A1:A2', 'SUM(A1:A2)', 'SUM(A1:A2)*2']);
  assert.deepEqual(r.steps.map(s => s.value), [[[2], [3]], 5, 10]);
  await run(t, 'selection.set', {range: 'C1'});
  await fails(t, 'formulas.evaluateFormula', {});
  assert.equal((await run(t, 'formulas.evaluateFormula', {formula: '=1+1'})).result, 2);
});

test('calculation_options_enable_iterative_calculation', async () => {
  const t = await session();
  const near = (a, want) => assert.ok(Math.abs(v(t, a) - want) < 0.002, `${a} = ${v(t, a)}`);
  await run(t, 'cell.set', {cell: 'A1', input: '=(A2+10)/2'});
  await run(t, 'cell.set', {cell: 'A2', input: '=A1'});
  assert.equal(errorOf(v(t, 'A1')), '#CIRC!');
  let r = await run(t, 'formulas.calculationOptions', {iterative: true});
  assert.deepEqual(r, {mode: 'Automatic', iterative: true, maxIterations: 100, maxChange: 0.001});
  near('A1', 10);
  near('A2', 10);
  r = await run(t, 'formulas.calculationOptions', {});
  assert.equal(r.iterative, true);
  r = await run(t, 'formulas.calculationOptions', {maxIterations: 1, maxChange: -0.5});
  assert.deepEqual([r.maxIterations, r.maxChange], [1, 0.5]);
  r = await run(t, 'formulas.calculationOptions', {maxIterations: 32767, maxChange: 0.0001});
  assert.deepEqual([r.maxIterations, r.maxChange], [32767, 0.0001]);
  await run(t, 'formulas.calculationOptions', {iterative: false});
  assert.equal(errorOf(v(t, 'A1')), '#CIRC!');
  await t.undo();
  assert.equal(t.content.calc.iterative, true);
  near('A1', 10);
  await expectUndoRoundTrip(t, 'formulas.calculationOptions', {mode: 'manual'}, ({content}) => assert.equal(content.calc.mode, 'manual'));
  assert.equal(t.state('formulas.calculationOptions', {mode: 'manual'}).checked, true, 'redo left it manual');
  await run(t, 'formulas.calculationOptions', {mode: 'automatic'});
  assert.equal(t.state('formulas.calculationOptions', {mode: 'automatic'}).checked, true);
  assert.equal(t.state('formulas.calculationOptions', {mode: 'manual'}).checked, false);
  assert.equal(t.content.calc.mode, undefined, 'automatic is the default and is not stored');
});

test('manual calculation waits for Calculate Now', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: '1'});
  await run(t, 'cell.set', {cell: 'B1', input: '=A1*10'});
  await run(t, 'formulas.calculationOptions', {mode: 'manual'});
  await run(t, 'cell.set', {cell: 'A1', input: '5'});
  const before = v(t, 'B1');
  await run(t, 'formulas.calculateNow', {});
  assert.equal(v(t, 'B1'), 50);
  assert.ok(before === 10 || before === 50);
  await run(t, 'formulas.calculateSheet', {});
  assert.equal(v(t, 'B1'), 50);
});

test('insert function starts the formula, enters it with arguments, and lists the catalogue', async () => {
  const t = await session();
  await run(t, 'selection.set', {range: 'C3'});
  await run(t, 'formulas.insertFunction', {name: 'vlookup'});
  assert.equal(t.doc.view.editCellRequest.text, '=VLOOKUP(');
  assert.deepEqual([t.doc.view.editCellRequest.row, t.doc.view.editCellRequest.col], [2, 2]);
  await run(t, 'range.setValues', {range: 'A1', values: [[4], [5]]});
  await expectUndoRoundTrip(t, 'formulas.insertFunction', {name: 'SUM', args: ['A1:A2', '', '']}, ({content}) => {
    assert.ok(content);
  });
  await run(t, 'formulas.insertFunction', {name: 'SUM', args: ['A1:A2', '']});
  assert.equal(formulaAt(t, 'C3'), 'SUM(A1:A2)');
  assert.equal(v(t, 'C3'), 9);
  assert.equal(t.session.prefs.gridRecentFunctions[0], 'SUM');
  const fin = await run(t, 'formulas.functions', {category: 'Financial'});
  assert.ok(fin.some(f => f.name === 'PMT'));
  const search = await run(t, 'formulas.functions', {search: 'lookup'});
  assert.ok(search.some(f => f.name === 'VLOOKUP') && search.some(f => f.name === 'XLOOKUP'));
  assert.ok(functionList().some(f => f.name === 'IF' && f.category === 'Logical'), 'special forms listed');
  assert.deepEqual(signatureArgs('VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])').map(a => [a.name, a.optional]),
    [['lookup_value', false], ['table_array', false], ['col_index_num', false], ['range_lookup', true]]);
  assert.deepEqual(signatureArgs('SUM(number1, [number2], ...)').map(a => [a.name, a.repeat]), [['number1', false], ['number2', true]]);
  assert.deepEqual(functionsFor({category: 'Most Recently Used'}).slice(0, 3).map(f => f.name), ['SUM', 'AVERAGE', 'IF']);
});
