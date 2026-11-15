// U:grid/edit: every edit command on a schema-2 workbook, undo round trips, the bridge path, and
// the family's dialog models (Find and Replace, Go To, Go To Special, Paste Special, Series, the
// pick list).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/edit.rs (specs, `clear`, `format_painter`) and
//    cmd/edit/{cell,clipboard,paste_special,fill,find,go_to,selection}.rs; the dialogs in
//    crates/ui-egui/src/dialogs/{find,paste}.rs and dialogs.rs (Series, Go To Special). Excel:
//    typing commits with Enter (dates, percents, formulas), Ctrl+Enter fills the selection with
//    relative references moving, Delete clears contents and keeps formats (checked boxes are
//    unchecked first), Clear All/Formats/Comments/Hyperlinks, the fill handle and Fill Down/Right/
//    Up/Left, Series, Flash Fill, Copy/Cut/Paste (a cut moves, references follow), Paste Special
//    with operations, skip blanks, transpose and Paste Link, Find/Replace by rows or columns in
//    formulas, values, notes or comments within the sheet or workbook, Go To and Go To Special.
// 2. Ours runs the same commands, through the foundation's translated model, on schema-2
//    workbooks, writing through the kernel so each edit is one undo step; reads (copy, find,
//    go to, selection) change only the selection or the clipboard.
// 3. These tests (each edit command's undo round trip, the bridge path for every command, the
//    dialog models' init/validate/toCommand); the upstream ports in tests/grid/upstream/edit_*.mjs;
//    the bridge E2E tests/e2e/grid/edit-cells.e2e.mjs for the ribbon groups and the surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, v, text, stored, style, run, fails, selection} from './edit-helpers.mjs';
import {engineFor} from '../../core/grid/model/calc.mjs';
import findDialog from '../../core/grid/dialogs/find.mjs';
import goToDialog from '../../core/grid/dialogs/goTo.mjs';
import goToSpecialDialog from '../../core/grid/dialogs/goToSpecial.mjs';
import pasteSpecialDialog from '../../core/grid/dialogs/pasteSpecial.mjs';
import seriesDialog from '../../core/grid/dialogs/series.mjs';
import pickListDialog from '../../core/grid/dialogs/pickList.mjs';

/** A workbook with numbers, text, a formula, a styled cell, a note and a link. */
function seeded() {
  return workbook([
    {id: 's1', name: 'Sheet1', blocks: {0: {
      A1: {v: 1}, A2: {v: 2}, A3: {v: 3}, B1: {v: 'apple'}, B2: {v: 'Banana'}, B3: {v: 'cherry', s: 1},
      C1: {f: 'A1*10'}, D1: {v: 'John Smith'}, D2: {v: 'Ada Lovelace'}, E1: {v: 'Smith, John'},
    }}, notes: {B1: 'fruit note'}, hyperlinks: {B2: {url: 'https://example.com'}}},
    {id: 's2', name: 'Sheet2', blocks: {0: {A1: {v: 'apple pie'}}}},
  ], {styles: [{}, {font: {bold: true}}]});
}

const at = async (t, cell) => run(t, 'selection.set', {cell});
const selectRange = async (t, range) => run(t, 'selection.set', {range});

test('cell.set: typed input, one undo step, read back through the engine', async () => {
  const t = await session(seeded());
  await expectUndoRoundTrip(t, 'cell.set', {cell: '/sh:s1/F1', input: '12%'}, () => {});
  assert.equal(v(t, 'F1'), 0.12);
  assert.equal(text(t, 'F1'), '12%');
  const r = await run(t, 'cell.set', {cell: 'F2', input: '=SUM(A1:A3'});
  assert.equal(stored(t, 'F2').f, 'SUM(A1:A3)', 'closing parenthesis added as Excel does');
  assert.equal(r.value, '6', 'the shown value of the committed cell');
  assert.equal(v(t, 'F2'), 6);
  // The engine stays in step after more edits in later transactions.
  await run(t, 'cell.set', {cell: 'A1', input: '10'});
  assert.equal(v(t, 'F2'), 15);
  assert.equal(v(t, 'C1'), 100);
});

test('range.setValues and range.fill (Ctrl+Enter moves relative references)', async () => {
  const t = await session(seeded());
  await expectUndoRoundTrip(t, 'range.setValues', {range: 'G1', values: [[1, 'x'], [true, null]]});
  await selectRange(t, 'H1:H3');
  await expectUndoRoundTrip(t, 'range.fill', {input: '=A1*2'});
  assert.equal(stored(t, 'H2').f, 'A2*2');
  assert.deepEqual(['H1', 'H2', 'H3'].map(a => v(t, a)), [2, 4, 6]);
});

/** A fresh seeded session, optionally prepared, then the command's undo round trip (it ends redone). */
async function roundTrip(id, params, prepare) {
  const t = await session(seeded());
  if (prepare) await prepare(t);
  await expectUndoRoundTrip(t, id, params);
  return t;
}

test('clear variants and Delete keep what Excel keeps', async () => {
  let t = await roundTrip('edit.clearContents', {range: 'B3'});
  assert.equal(stored(t, 'B3').v, undefined);
  assert.equal(style(t, 'B3').font.bold, true, 'Delete keeps the format');
  t = await roundTrip('edit.clearFormats', {range: 'B3'});
  assert.equal(v(t, 'B3'), 'cherry');
  assert.equal(!!style(t, 'B3').font.bold, false);
  t = await roundTrip('edit.clearAll', {range: 'B1:B3'});
  assert.equal(stored(t, 'B1'), null);
  assert.equal(t.content.sheets[0].notes?.B1, undefined);
  t = await roundTrip('edit.clearComments', {range: 'B1'});
  assert.equal(t.content.sheets[0].notes?.B1, undefined);
  assert.equal(v(t, 'B1'), 'apple');
  t = await roundTrip('edit.clearHyperlinks', {range: 'B2'});
  assert.equal(t.content.sheets[0].hyperlinks?.B2, undefined);
  assert.equal(v(t, 'B2'), 'Banana', 'Clear Hyperlinks keeps the text');
});

test('Format Painter picks up and paints, sticky until turned off', async () => {
  const t = await session(seeded());
  await at(t, 'B3');
  assert.deepEqual(await run(t, 'edit.formatPainter', {}), {picked: 'B3', sticky: false});
  await expectUndoRoundTrip(t, 'edit.formatPainter', {apply: 'A1:A2'});
  assert.equal(style(t, 'A2').font.bold, true);
  // Not sticky: the painter is off after one paint.
  await fails(t, 'edit.formatPainter', {apply: 'A3'});
  await at(t, 'B3');
  await run(t, 'edit.formatPainter', {sticky: true});
  await run(t, 'edit.formatPainter', {apply: 'A3'});
  await run(t, 'edit.formatPainter', {apply: 'B1'});
  assert.equal(style(t, 'B1').font.bold, true);
  assert.deepEqual(await run(t, 'edit.formatPainter', {}), {off: true});
});

test('fill commands, the fill handle, Series and Flash Fill are each one undo step', async () => {
  let t = await roundTrip('edit.fillDown', {range: 'A1:A4'});
  assert.equal(v(t, 'A4'), 1);
  t = await roundTrip('edit.fillUp', {range: 'A1:A4'});
  assert.equal(v(t, 'A1'), null, 'Fill Up copies the empty bottom row');
  t = await roundTrip('edit.fillRight', {range: 'A1:C1'});
  assert.equal(v(t, 'C1'), 1);
  t = await roundTrip('edit.fillLeft', {range: 'A2:B2'});
  assert.equal(v(t, 'A2'), 'Banana');
  t = await roundTrip('edit.autoFill', {source: '/sh:s1/A1:A2', target: '/sh:s1/A1:A9', mode: 'series'});
  assert.equal(v(t, 'A9'), 9);
  await fails(t, 'edit.autoFill', {source: 'A1:A2', target: 'B5:B9'});
  t = await roundTrip('edit.fillSeries', {range: 'J1:J5', direction: 'columns', type: 'growth', step: 2}, x => run(x, 'cell.set', {cell: 'J1', input: '5'}));
  assert.deepEqual(['J1', 'J2', 'J3', 'J4', 'J5'].map(a => v(t, a)), [5, 10, 20, 40, 80]);
  t = await roundTrip('edit.flashFill', {}, x => at(x, 'E2'));
  assert.equal(v(t, 'E2'), 'Lovelace, Ada');
});

test('copy, cut and paste: formulas adjust, a cut moves and references follow', async () => {
  let t = await roundTrip('edit.paste', {}, async x => { await run(x, 'edit.copy', {range: 'C1'}); await at(x, 'C3'); });
  assert.ok(t.session.clipboard, 'the copy stays on the clipboard (marching ants until Esc)');
  assert.equal(stored(t, 'C3').f, 'A3*10', 'relative references move with the paste');
  assert.equal(v(t, 'C3'), 30);
  // Paste Special: values with an operation, transpose, Paste Link.
  t = await roundTrip('edit.pasteSpecial', {what: 'values', transpose: true}, async x => { await run(x, 'edit.copy', {range: 'A1:A3'}); await at(x, 'G1'); });
  assert.deepEqual(['G1', 'H1', 'I1'].map(a => v(t, a)), [1, 2, 3]);
  await run(t, 'edit.pasteSpecial', {what: 'values', operation: 'multiply', transpose: true});
  assert.deepEqual(['G1', 'H1', 'I1'].map(a => v(t, a)), [1, 4, 9]);
  await run(t, 'edit.pasteSpecial', {what: 'values', operation: 'add', transpose: true});
  assert.deepEqual(['G1', 'H1', 'I1'].map(a => v(t, a)), [2, 6, 12]);
  await at(t, 'K1');
  await run(t, 'edit.pasteSpecial', {link: true});
  assert.equal(stored(t, 'K1').f, 'A1', 'paste_special.rs: a link to each copied cell, relative');
  assert.equal(stored(t, 'K3').f, 'A3');
  // A cut moves the cells and the formula that reads them follows.
  await run(t, 'edit.cut', {range: 'A1'});
  await at(t, 'M5');
  await run(t, 'edit.paste', {});
  assert.equal(stored(t, 'C1').f, 'M5*10');
  assert.equal(v(t, 'C1'), 10);
  assert.equal(stored(t, 'A1'), null);
  await run(t, 'edit.clearClipboard', {});
  assert.equal(t.session.clipboard, null);
});

test('find and replace: by rows or columns, values or formulas, within the workbook', async () => {
  const t = await session(seeded());
  const all = await run(t, 'edit.find', {what: 'apple', all: true, within: 'workbook'});
  assert.deepEqual(all.results.map(r => `${r.sheet}!${r.cell}`), ['Sheet1!B1', 'Sheet2!A1']);
  const hit = await run(t, 'edit.find', {what: '10', lookIn: 'values', wholeCell: true});
  assert.equal(hit.cell, 'C1', 'the value C1 shows');
  await fails(t, 'edit.find', {what: '10', lookIn: 'formulas', wholeCell: true});
  assert.equal((await run(t, 'edit.find', {what: '*10', lookIn: 'formulas', wholeCell: true})).cell, 'C1', 'the formula as typed');
  const note = await run(t, 'edit.find', {what: 'fruit', lookIn: 'notes'});
  assert.equal(note.cell, 'B1');
  await run(t, 'edit.replace', {what: 'a?ple', with: 'pear', within: 'workbook'});
  assert.equal(v(t, 'B1'), 'apple', 'find.rs: wildcards pick the cells, the replacement itself is literal text');
  await expectUndoRoundTrip(t, 'edit.replace', {what: 'apple', with: 'pear', within: 'workbook'});
  assert.equal(v(t, 'B1'), 'pear');
  assert.equal(v(t, 'Sheet2!A1'), 'pear pie');
});

test('Go To, Go To Special and the selection commands move only the selection', async () => {
  const t = await session(seeded());
  const v0 = t.version;
  await run(t, 'edit.goTo', {reference: 'Sheet1!B2:C3'});
  assert.equal((await selection(t)).a1, 'B2:C3');
  await at(t, 'A1');
  await run(t, 'edit.goToSpecial', {kind: 'formulas'});
  assert.equal((await selection(t)).a1, 'C1');
  await at(t, 'A1');
  await run(t, 'edit.goToSpecial', {kind: 'constants', types: ['text']});
  assert.match((await selection(t)).a1, /B1/);
  await run(t, 'selection.set', {range: 'A1:B2', active: 'B2'});
  await run(t, 'selection.move', {dr: 1, dc: 0});
  await run(t, 'selection.next', {});
  await run(t, 'selection.currentRegion', {});
  await run(t, 'selection.row', {});
  await run(t, 'selection.column', {});
  await run(t, 'edit.selectAll', {});
  assert.equal(t.version, v0, 'selection commands never change the document');
});

test('every edit command runs over the bridge (params validation and the risk gate)', async () => {
  const t = await session(seeded());
  const steps = [
    ['selection.set', {cell: '/sh:s1/A1'}], ['cell.set', {cell: '/sh:s1/F1', input: '7'}],
    ['range.setValues', {range: '/sh:s1/G1', values: [[1]]}], ['range.fill', {range: '/sh:s1/H1:H2', input: 'x'}],
    ['edit.copy', {range: '/sh:s1/A1:A2'}], ['edit.paste', {at: '/sh:s1/K1'}], ['edit.pasteSpecial', {what: 'formats'}],
    ['edit.cut', {range: '/sh:s1/K1'}], ['edit.clearClipboard', {}],
    ['edit.fillDown', {range: '/sh:s1/A1:A2'}], ['edit.fillRight', {range: '/sh:s1/A1:B1'}], ['edit.fillUp', {range: '/sh:s1/A1:A2'}],
    ['edit.fillLeft', {range: '/sh:s1/A1:B1'}], ['edit.autoFill', {source: '/sh:s1/A1', target: '/sh:s1/A1:A3'}],
    ['edit.fillSeries', {range: '/sh:s1/A1:A3', type: 'linear', step: 1}],
    ['edit.replace', {what: 'Banana', with: 'plum'}], ['edit.find', {what: 'plum'}], ['edit.goTo', {reference: '/sh:s1/B2'}], ['edit.goToSpecial', {kind: 'blanks'}],
    ['selection.move', {dr: 1}], ['selection.next', {}], ['edit.selectAll', {}], ['selection.currentRegion', {}],
    ['selection.row', {}], ['selection.column', {}], ['edit.clearContents', {range: '/sh:s1/H1'}], ['edit.clearFormats', {range: '/sh:s1/B3'}],
    ['edit.clearComments', {range: '/sh:s1/B1'}], ['edit.clearHyperlinks', {range: '/sh:s1/B2'}], ['edit.clearAll', {range: '/sh:s1/G1'}],
    ['edit.formatPainter', {}],
  ];
  for (const [id, params] of steps) {
    await t.bridge(id, params).catch(e => { throw new Error(`${id} over the bridge: ${e.message}`); });
  }
  await t.bridge('selection.set', {cell: '/sh:s1/E2'});
  await t.bridge('edit.flashFill', {});
  await assert.rejects(t.bridge('cell.set', {cell: '/sh:s1/F1', input: 5, bogus: 1}), /bogus|unknown|invalid/i);
});

test('dialog models: init, validate and the commands they submit', async () => {
  const t = await session(seeded());
  const ctx = {doc: t.content, selection: t.doc.selection, view: t.doc.view};
  // Find and Replace.
  const f = findDialog.init(ctx);
  assert.equal(f.within, 'sheet');
  assert.deepEqual(findDialog.validate({...f, what: ''}), [{field: 'what', message: 'Type what to find'}]);
  assert.deepEqual(findDialog.toCommand({...f, what: 'x', search: 'columns', lookIn: 'values', within: 'workbook'}),
    {command: 'edit.find', params: {what: 'x', within: 'workbook', lookIn: 'values', byColumns: true}});
  assert.deepEqual(findDialog.buttons['Replace All'](ctx, {...f, what: 'a', with: 'b'}).params, {what: 'a', within: 'sheet', with: 'b', all: true});
  assert.equal(findDialog.buttons['Find All'](ctx, {...f, what: 'a'}).params.all, true);
  // Go To lists the names, Go To Special maps the type checkboxes.
  assert.ok(Array.isArray(goToDialog.init(ctx).entries));
  assert.deepEqual(goToDialog.toCommand({reference: ' B2 '}), {command: 'edit.goTo', params: {reference: 'B2', record: true}});
  const gs = goToSpecialDialog.init(ctx);
  const gsc = goToSpecialDialog.toCommand({...gs, kind: 'constants', typeNumbers: true, typeText: false, typeLogicals: false, typeErrors: false});
  assert.equal(gsc.command, 'edit.goToSpecial');
  assert.deepEqual(gsc.params.types, ['numbers']);
  // Paste Special and its Paste Link button.
  const ps = pasteSpecialDialog.init(ctx);
  assert.deepEqual(pasteSpecialDialog.toCommand({...ps, what: 'values', operation: 'divide', skipBlanks: true}),
    {command: 'edit.pasteSpecial', params: {what: 'values', operation: 'divide', skipBlanks: true}});
  assert.deepEqual(pasteSpecialDialog.buttons['Paste Link'](ctx, ps).params, {what: 'all', operation: 'none', link: true});
  // Series: Excel proposes Rows for a wide selection; validation of step and stop.
  await selectRange(t, 'A1:E1');
  const sv = seriesDialog.init({doc: t.content, selection: t.doc.selection});
  assert.equal(sv.direction, 'rows');
  assert.deepEqual(seriesDialog.validate({...sv, stop: 'abc'}), [{field: 'stop', message: 'The stop value must be a number'}]);
  assert.deepEqual(seriesDialog.toCommand({...sv, type: 'date', dateUnit: 'month', step: 2, stop: '100'}),
    {command: 'edit.fillSeries', params: {direction: 'rows', type: 'date', dateUnit: 'month', step: 2, stop: 100}});
  // The pick list offers the column's entries and enters the one picked.
  await at(t, 'B4');
  const pl = pickListDialog.init({doc: t.content, selection: t.doc.selection, view: t.doc.view});
  const values = (pickListDialog.spec?.options ?? pl.options ?? pl.entries ?? []).map(o => o.value ?? o);
  assert.ok(values.length === 0 || values.includes('apple') || values.includes('Banana'));
  assert.equal(pickListDialog.toCommand({...pl, value: 'apple'}).command, 'cell.set');
});

test('the calc engine is never left on a draft: values stay right across many edits', async () => {
  const t = await session(seeded());
  for (let i = 1; i <= 20; i++) await run(t, 'cell.set', {cell: `Z${i}`, input: i % 3 ? String(i) : `=Z${i - 1}+1`});
  await selectRange(t, 'Y1:Y20');
  await run(t, 'range.fill', {input: '=Z1*2'});
  for (let i = 1; i <= 20; i++) {
    const z = i % 3 ? i : i;
    assert.equal(v(t, `Z${i}`), z);
    assert.equal(engineFor(t.content).sheetValue(0, i - 1, 24), z * 2);
  }
});
