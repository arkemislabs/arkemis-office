// Every Table Design / Table Layout command (U:quill/table, table_style, table_draw, table_mouse,
// table_resize): an undo round trip on a schema-2 document, run through the kernel and over the
// bridge path, plus the dialogs' models (Insert Table, Table Properties, Delete Cells, Split Cells,
// Convert Text to Table / to Text, Sort, Formula, Modify Table Style, Insert Cells).
//
// Behaviour fidelity:
// 1. ArtCraft: crates/engine/src/cmd/table.rs + table/*.rs, table_style.rs, table_draw.rs,
//    table_mouse.rs, table_resize.rs (the command tables) and crates/ui-egui/src/dialogs/
//    {dispatch,forms}.rs, dialogs_layout/table.rs, dialogs_table_style.rs (the dialogs). Word's
//    Table Design and Table Layout tabs and their dialogs do the same.
// 2. Each edit command changes the document once (one undo step: undo restores content and
//    selection, redo reproduces it); each dialog's OK runs the command upstream's dialog runs with
//    the values the person set.
// 3. This file (engine), tests/quill/upstream/table_*_tests.test.mjs (upstream's own tests) and
//    tests/e2e/quill/table-layout.e2e.mjs (the contextual tabs and dialogs through the bridge).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {openDialogModel, submitDialog} from '../../core/kernel/dialog.mjs';
import {doc, tableSession, firstTable, cellRect, ready, caretIn, selectCells, cellText, blocks, selectBody} from './table-helpers.mjs';
import * as P from '../../core/quill/model/para.mjs';

await ready();
const dialogs = (await import('../../core/generated/quill.dialogs.mjs'));
const dialog = id => dialogs.dialogs[id];

/** A 3×3 table of numbers 1..9 after "Intro", caret in the middle cell. */
async function numbers() {
  const t = await tableSession(3, 3, 'Intro');
  const tb = firstTable(t);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { caretIn(t, r, c); await t.exec('text.insert', {text: String(r * 3 + c + 1)}); }
  void tb;
  caretIn(t, 1, 1);
  return t;
}

const cases = [
  ['table.insertRowAbove', {}], ['table.insertRowBelow', {}], ['table.insertColumnLeft', {}], ['table.insertColumnRight', {}],
  ['table.deleteRow', {}], ['table.deleteColumn', {}], ['table.deleteTable', {}], ['table.deleteCells', {}],
  ['table.split', {columns: 2, rows: 1}], ['table.splitTable', {}],
  ['table.style', {style: 'Grid Table 4 – Blue'}], ['table.look', {bandedRows: false}], ['table.shading', {color: 'FFC000'}],
  ['table.borders', {kind: 'outside'}], ['table.cellAlign', {value: 'center'}], ['table.textDirection', {}],
  ['table.autofit', {mode: 'contents'}], ['table.distributeColumns', {}, async t => { await t.exec('table.columnWidth', {width: 50}); }],
  ['table.distributeRows', {}, async t => { await t.exec('table.rowHeight', {height: 40}); selectCells(t, [0, 0, 0], [2, 2]); }],
  ['table.columnWidth', {width: 100}], ['table.rowHeight', {height: 30, rule: 'exact'}], ['table.repeatHeader', {}],
  ['table.altText', {title: 'Numbers', text: 'One to nine'}], ['table.sort', {column: 0, descending: true}],
  ['table.toText', {separator: 'tab'}], ['table.formula', {formula: '=SUM(ABOVE)'}, async t => { caretIn(t, 2, 0); await t.exec('text.delete', {}).catch(() => {}); }],
  ['table.rtl', {}], ['table.properties', {align: 'center', rowHeight: 30}],
  ['table.newStyle', {name: 'My Table Style'}], ['table.modifyStyle', {style: 'Table Grid', part: 'wholeTable', fill: 'DDEEFF'}],
];

for (const [id, params, setup] of cases) {
  test(`${id}: one undo step`, async () => {
    const t = await numbers();
    if (setup) await setup(t);
    await expectUndoRoundTrip(t, id, params);
  });
}

test('table.merge: one undo step, the cells\' text joined', async () => {
  const t = await numbers();
  selectCells(t, [0, 0, 0], [0, 1]);
  await expectUndoRoundTrip(t, 'table.merge', {}, () => {
    assert.equal(firstTable(t).rows[0].cells.length, 2);
    assert.equal(cellText(t, 0, 0), '1\n2');
  });
});

test('table.deleteStyle: a custom style goes, tables using it fall back; one undo step', async () => {
  const t = await numbers();
  await t.exec('table.newStyle', {name: 'Custom One'});
  await t.exec('table.style', {style: 'Custom One'});
  await expectUndoRoundTrip(t, 'table.deleteStyle', {style: 'Custom One'});
});

test('table.fromText and table.quick: one undo step each (Insert › Table)', async () => {
  let t = await doc('a\tb\tc\nd\te\tf');
  selectBody(t, [0, 0], [1, 5]);
  await expectUndoRoundTrip(t, 'table.fromText', {separator: 'tab'}, () => {
    const tb = firstTable(t);
    assert.equal(tb.rows.length, 2);
    assert.equal(tb.rows[0].cells.length, 3);
  });
  t = await doc('x');
  await expectUndoRoundTrip(t, 'table.quick', {kind: 'matrix'}, () => assert.ok(firstTable(t)));
});

test('table select commands change the selection, never the document', async () => {
  const t = await numbers();
  for (const id of ['table.selectTable', 'table.selectRow', 'table.selectColumn', 'table.selectCell']) {
    caretIn(t, 1, 1);
    const v = t.version;
    await t.exec(id);
    assert.equal(t.version, v, id);
  }
  caretIn(t, 1, 1);
  await t.exec('table.selectColumn');
  assert.equal(t.doc.selection.ranges.length, 3, 'a column is one range per cell');
});

test('outside a table the table commands are disabled with upstream\'s reason', async () => {
  const t = await doc('Plain');
  const st = t.state('table.insertRowAbove');
  assert.equal(st.enabled, false);
  assert.match(st.reason, /isn't in a table/);
});

test('table_draw / table_resize / table_mouse edits: one undo step each', async () => {
  let t = await tableSession(2, 2);
  let a = cellRect(t, 0, 0);
  await expectUndoRoundTrip(t, 'table.draw', {page: 0, x0: a.x + a.w / 2, y0: a.y + 1, x1: a.x + a.w / 2 + 1, y1: a.bottom - 1});
  await expectUndoRoundTrip(t, 'table.eraser', {page: 0, x: a.right, y: a.midY});
  t = await tableSession(2, 2);
  a = cellRect(t, 0, 0);
  await expectUndoRoundTrip(t, 'table.resizeDrag', {page: 0, x: a.right, y: a.midY, toX: a.right + 20, toY: a.midY});
  await expectUndoRoundTrip(t, 'table.insertAt', {page: 0, x: a.x - 10, y: a.bottom});
  caretIn(t, 0, 0);
  await t.exec('text.insert', {text: 'ab'});
  a = cellRect(t, 0, 0);
  await expectUndoRoundTrip(t, 'table.fitColumn', {page: 0, x: a.right, y: a.midY});
  const v = t.version;
  await t.exec('table.selectAt', {page: 0, x: a.x + 2, y: a.midY});
  assert.equal(t.version, v, 'selectAt changes only the selection');
  const st = t.state('table.moveDrag');
  assert.equal(st.enabled, false, 'Move Table waits on floating tables in the layout');
});

test('bridge origin: params are validated before a table command runs', async () => {
  const t = await numbers();
  await assert.rejects(() => t.bridge('table.cellAlign', {value: 'sideways'}));
  await assert.rejects(() => t.bridge('table.resizeDrag', {page: 'one'}));
  const r = await t.bridge('table.insertRowBelow', {});
  assert.ok(r.version > 0);
});

// ---- dialogs ------------------------------------------------------------------------------------

async function submit(t, id, set) {
  const d = dialog(id);
  assert.ok(d, `dialog model ${id}`);
  let values = openDialogModel(t.session, t.docId, d);
  values = {...values, ...set};
  const problems = d.validate(values);
  assert.deepEqual(problems, [], `${id}: ${JSON.stringify(problems)}`);
  return submitDialog(t.session, t.docId, d, values, {origin: 'test'});
}

test('dialog.insertTable: 4 × 3, AutoFit to contents, one undo step', async () => {
  const t = await doc('x');
  await submit(t, 'dialog.insertTable', {cols: 4, rows: 3, autofit: 'contents'});
  const tb = firstTable(t);
  assert.deepEqual([tb.rows.length, tb.rows[0].cells.length], [3, 4]);
  await t.undo();
  assert.equal(firstTable(t), undefined, 'the table and its AutoFit are one step');
  const d = dialog('dialog.insertTable');
  assert.ok(d.validate({cols: 0, rows: 2}).some(p => p.field === 'cols'));
  assert.ok(d.validate({cols: 64, rows: 2}).some(p => p.field === 'cols'));
});

test('dialog.tableProperties: every tab sends only what changed, one undo step', async () => {
  const t = await numbers();
  await submit(t, 'dialog.tableProperties', {alignment: 'center', heightOn: true, height: 0.5, heightRule: 'exact', valign: 'bottom', title: 'T', description: 'D'});
  const tb = firstTable(t);
  assert.equal(tb.props.align, 'center');
  assert.equal(tb.rows[1].props.height, 36);
  assert.equal(tb.rows[1].cells[1].props.valign, 'bottom');
  assert.equal(tb.props.caption, 'T');
  await t.undo();
  assert.equal(firstTable(t).props.align, undefined);
});

for (const [id, set, check] of [
  ['dialog.deleteCells', {mode: 'row'}, t => assert.equal(firstTable(t).rows.length, 2)],
  ['dialog.splitCells', {cols: 3, rows: 1}, t => assert.equal(firstTable(t).rows[1].cells.length, 5)],
  ['dialog.tableToText', {separator: 'comma'}, t => assert.ok(blocks(t).some(b => b.kind === 'para' && P.plainText(b) === '4,5,6'))],
  ['dialog.tableSort', {column: 0, order: 'descending'}, t => assert.equal(cellText(t, 0, 0), '7')],
  ['dialog.tableFormula', {formula: '=SUM(LEFT)'}, t => assert.match(cellText(t, 1, 1), /4/)],
  ['dialog.insertCells', {mode: 'row'}, t => assert.equal(firstTable(t).rows.length, 4)],
]) {
  test(`${id}: OK runs its command`, async () => {
    const t = await numbers();
    if (id === 'dialog.tableFormula') { caretIn(t, 1, 1); }
    await submit(t, id, set);
    check(t);
  });
}

test('dialog.textToTable: Convert Text to Table from tab-separated lines', async () => {
  const t = await doc('a\tb\nc\td');
  selectBody(t, [0, 0], [1, 3]);
  await submit(t, 'dialog.textToTable', {separator: 'tab'});
  const tb = firstTable(t);
  assert.deepEqual([tb.rows.length, tb.rows[0].cells.length], [2, 2]);
});

test('dialog.tableStyle: New Table Style with a fill and bold header', async () => {
  const t = await numbers();
  await submit(t, 'dialog.tableStyle', {name: 'Dialog Style', region: 'headerRow', bold: true, fill: 'C00000'});
  const st = Object.values(t.content.styles.styles ?? t.content.styles).find?.(s => s?.name === 'Dialog Style');
  assert.ok(st, 'the style is in the style sheet');
});

test('Sort keeps the caret on real text: the caret after "Ω" in a row that sorts away stays in the cell its path now names, within its text', async () => {
  // Dialog sweep (2026-10-30): after Sort the caret pointed past the text of the (empty) cell its row
  // was replaced by, and the next command at the caret failed with "Offset 1 is outside the text".
  const t = await tableSession(3, 2, 'Intro');
  caretIn(t, 0, 0); await t.exec('text.insert', {text: 'Ω'});
  await t.exec('table.sort', {column: 0});
  assert.deepEqual([cellText(t, 0, 0), cellText(t, 1, 0), cellText(t, 2, 0)], ['', '', 'Ω'], 'empty cells sort before text');
  await t.exec('text.insert', {text: 'x'});
  assert.equal(cellText(t, 0, 0), 'x', 'typing goes into the cell the caret is in, at its end');
});
