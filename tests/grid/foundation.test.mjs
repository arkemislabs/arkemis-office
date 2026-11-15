// Grid foundation (F:grid): schema 2, migration from schema 1, the address resolver, typed input,
// AutoFill, structural edits with anchors, selection helpers, the editor model and contextual flags.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/edit/cell.rs:11 `input_to_cell` (what typing stores),
//    crates/engine/src/fill.rs:89 `fill` (AutoFill), crates/engine/src/selection.rs:149 `jump`,
//    crates/model/src/sheet.rs `insert_rows` + crates/formula/src/adjust.rs (structural edits),
//    crates/ui-egui/src/editor.rs (pointing, autocomplete). Excel does the same: typed input is
//    parsed (numbers, dates with an automatic format, formulas closed up), AutoFill extends series,
//    inserting a row moves cells and every reference.
// 2. Ours runs the same logic in core/grid/model/* through the kernel (undoable recorded changes),
//    with values recalculated by the dependency-graph engine.
// 3. This file (engine) and tests/e2e/grid/surface-*.e2e.mjs (bridge, window captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {defineCommands} from '../../core/kernel/command.mjs';
import {s} from '../../core/kernel/schema.mjs';
import {apps} from '../../core/generated/apps.mjs';
import * as model from '../../core/grid/model/index.mjs';
import * as address from '../../core/grid/address.mjs';
import {createContent, validateContent, apply as applyOp, applyLegacyCommand} from '../../core/grid/schema.mjs';
import {migrate, migrateFile, isSchema1} from '../../core/grid/migrate.mjs';
import {evaluate as contextFlags, flags} from '../../core/grid/context.mjs';
import {twoSheets} from '../../core/grid/fixtures.mjs';
import {createFile} from '../../core/model.mjs';
import * as ed from '../../core/grid/lib/editor.mjs';

const foundation = apps.grid;

// A test-only family: the foundation API the edit/sheet units will call, run through the kernel.
const family = defineCommands({
  family: 'test-foundation', app: 'grid', upstream: {repo: 'gridcraft', files: ['crates/engine/src/cmd/edit/cell.rs']},
  commands: [
    {id: 'test.cellSet', label: 'Set cell', risk: 'edit', params: s.object({sheet: s.integer(), row: s.integer(), col: s.integer(), input: s.string()}),
      run(ctx, p) { return {cell: ctx.model.enterInput(ctx.change, ctx.doc, p.sheet, p.row, p.col, p.input) ?? null}; }},
    {id: 'test.fill', label: 'Fill', risk: 'edit', params: s.object({source: s.string(), target: s.string(), mode: s.optional(s.string())}),
      run(ctx, p) {
        const src = ctx.resolve(p.source), dst = ctx.resolve(p.target);
        return {written: ctx.model.fill(ctx.change, ctx.doc, src.sheet, src.areas[0], dst.areas[0], p.mode ?? 'series')};
      }},
    {id: 'test.insertRows', label: 'Insert rows', risk: 'edit', params: s.object({sheet: s.string(), at: s.integer(), count: s.integer()}),
      run(ctx, p) { ctx.change.apply({op: 'grid.structure', sheet: p.sheet, edit: {type: 'insert', axis: 'rows', at: p.at, count: p.count}}); return {}; }},
    {id: 'test.deleteCols', label: 'Delete columns', risk: 'edit', params: s.object({sheet: s.string(), at: s.integer(), count: s.integer()}),
      run(ctx, p) { ctx.change.apply({op: 'grid.structure', sheet: p.sheet, edit: {type: 'delete', axis: 'cols', at: p.at, count: p.count}}); return {}; }},
  ],
});

const session = (content = twoSheets()) => createTestSession('grid', {modules: [family], sources: ['tests/grid/foundation.test.mjs'], foundation, content});
const v = (t, a) => t.read(a, 'values');

test('schema 2: a new workbook has Sheet1, validates, and rejects malformed content', () => {
  const c = createContent('Book');
  assert.equal(c.sheets.length, 1);
  assert.equal(c.sheets[0].name, 'Sheet1');
  assert.deepEqual(c.sheets[0].blocks, {});
  assert.equal(c.activeSheetId, c.sheets[0].id);
  validateContent(c);
  validateContent(twoSheets());
  const bad = twoSheets();
  bad.sheets[0].blocks[0].A300 = {v: 1};
  assert.throws(() => validateContent(bad), /wrong block/);
  const dup = twoSheets(); dup.sheets[1].name = 'sheet1';
  assert.throws(() => validateContent(dup), /two sheets/);
  const legacy = twoSheets(); legacy.sheets[0].cells = {};
  assert.throws(() => validateContent(legacy), /schema-1/);
  const name = twoSheets(); name.sheets[0].name = 'a/b';
  assert.throws(() => validateContent(name), /sheet name/);
});

test('migrate: schema-1 cells, inline styles, layout and names become schema 2', () => {
  const file = createFile('grid', 'Old');
  const c = file.content;
  const sh = c.sheets[0];
  sh.cells = {A1: {value: '12.5'}, A2: {value: '=A1*2', bold: true}, B1: {value: '3/4/2026'}, C1: {value: '50%', color: '#ff0000'},
    D1: {value: '=1', valueType: 'text'}, E1: {value: 'x', bold: true}};
  sh.xlsxLayout = {rowHeights: {2: 30}, columnWidths: {1: 20}, merges: ['F1:G2'], freeze: {xSplit: 1, ySplit: 1}};
  c.namedRanges = [{name: 'Rate', reference: '=Sheet 1!$A$1'}];
  assert.ok(isSchema1(c));
  const next = migrate(c);
  validateContent(next);
  const s2 = next.sheets[0];
  assert.equal(s2.blocks[0].A1.v, 12.5);
  assert.equal(s2.blocks[0].A2.f, 'A1*2');
  assert.equal(next.styles[s2.blocks[0].A2.s].font.bold, true);
  assert.equal(typeof s2.blocks[0].B1.v, 'number');
  assert.equal(next.styles[s2.blocks[0].B1.s].numFmt, 'm/d/yyyy');
  assert.equal(s2.blocks[0].C1.v, 0.5);
  assert.equal(next.styles[s2.blocks[0].C1.s].numFmt, '0%');
  assert.equal(s2.blocks[0].D1.v, '=1', 'text kept as text');
  assert.equal(s2.blocks[0].E1.s, s2.blocks[0].A2.s, 'equal styles are interned once');
  assert.deepEqual(s2.rows[1], {size: 40, custom: true});
  assert.deepEqual(s2.cols[0], {size: 145});
  assert.deepEqual(s2.merges, ['F1:G2']);
  assert.deepEqual(s2.freeze, {rows: 1, cols: 1});
  assert.deepEqual(next.names, [{name: 'Rate', formula: 'Sheet 1!$A$1'}]);
  assert.equal(model.valueAt(next, 0, 1, 0), 25);
  const f2 = migrateFile(file);
  assert.equal(f2.schema, 2);
  assert.equal(migrateFile(f2), f2);
});

test('addresses: canonical forms, friendly inputs, both forms on reads', () => {
  const c = twoSheets();
  assert.equal(address.canonical(c, 'Sheet1!B2:C3'), '/sh:s1/B2:C3');
  assert.equal(address.canonical(c, "'Sheet2'!A1"), '/sh:s2/A1');
  assert.equal(address.canonical(c, 'D4'), '/sh:s1/D4');
  assert.equal(address.canonical(c, 'B:D'), '/sh:s1/cols:B-D');
  assert.equal(address.canonical(c, '3:5'), '/sh:s1/rows:3-5');
  assert.equal(address.canonical(c, '/sh:s1/row:2'), '/sh:s1/row:2');
  assert.throws(() => address.canonical(c, 'Nope!A1'), e => e.code === 'not_found');
  assert.throws(() => address.parse('/sh:s1/ZZZZ1'), e => e.code === 'invalid_address');
  const r = address.resolve(c, '/sh:s1/A1:B2,D4');
  assert.equal(r.kind, 'range');
  assert.equal(r.a1, 'Sheet1!A1:B2,Sheet1!D4');
  assert.deepEqual(address.read(c, address.parse('/sh:s1/D2:D4'), 'values'), [[3.75], [4], [7.75]]);
  assert.deepEqual(address.read(c, address.parse('/sh:s1/D2'), 'formulas'), '=B2*C2');
  assert.deepEqual(address.read(c, address.parse('Sheet1!A1:B1'), 'display'), [['Item', 'Qty']]);
  assert.equal(address.read(c, address.parse('/sh:s1/A1:B2'), 'text'), 'Item\tQty\nApples\t3');
  const props = address.read(c, address.parse('/sh:s1/A1'), 'props');
  assert.equal(props.bold, false);
  assert.equal(props.fontName, 'Calibri');
  assert.equal(props.a1, 'Sheet1!A1');
  const wb = address.read(c, address.parse('/'), 'json');
  assert.deepEqual(wb.sheets.map(x => [x.address, x.used]), [['/sh:s1', 'A1:D4'], ['/sh:s2', null]]);
  const page = address.enumerate(c, address.parse('/sh:s1'), {limit: 5});
  assert.equal(page.nodes.length, 5);
  assert.equal(page.nodes[0].address, '/sh:s1/A1');
  assert.equal(page.cursor, '5');
  const rest = address.enumerate(c, address.parse('/sh:s1'), {limit: 50, cursor: page.cursor});
  assert.equal(rest.nodes.length, 9);
  assert.equal(rest.nodes.find(n => n.a1 === 'Sheet1!D4').formula, '=SUM(D2:D3)');
  const found = address.find(c, {query: 'pear'});
  assert.deepEqual(found.matches.map(m => m.cell), ['/sh:s1/A3']);
  // Raw content paths stay readable for families written against schema 1.
  assert.equal(address.read(c, address.parse('/sheets/0/name')), 'Sheet1');
});

test('typed input: numbers, dates, percent entry, formulas closed up, wrong argument counts refused; undo round trip', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'test.cellSet', {sheet: 0, row: 0, col: 5, input: '1,234.5'}, after => {
    assert.equal(after.read('/sh:s1/F1', 'values'), 1234.5);
    assert.equal(after.read('/sh:s1/F1', 'display'), '1,234.50', 'typed thousands separators set #,##0.00 (parse.rs)');
  });
  await t.exec('test.cellSet', {sheet: 0, row: 1, col: 5, input: '=sum(B2:B3'});
  assert.equal(t.read('/sh:s1/F2', 'formulas'), '=SUM(B2:B3)');
  assert.equal(v(t, '/sh:s1/F2'), 8);
  await t.exec('test.cellSet', {sheet: 0, row: 2, col: 5, input: '10/30/2026'});
  assert.equal(t.read('/sh:s1/F3', 'display'), '10/30/2026');
  await t.exec('test.cellSet', {sheet: 0, row: 3, col: 5, input: '=TODAY()'});
  assert.equal(t.read('/sh:s1/F4', 'props').numFmt, 'm/d/yyyy');
  await assert.rejects(() => t.exec('test.cellSet', {sheet: 0, row: 4, col: 5, input: '=ROUND(1)'}), /ROUND has too few arguments/);
  await assert.rejects(() => t.exec('test.cellSet', {sheet: 0, row: 4, col: 5, input: '=1+'}), /problem with this formula/);
  // Recalculation follows edits: changing a precedent updates the dependents.
  await t.exec('test.cellSet', {sheet: 0, row: 1, col: 1, input: '10'});
  assert.equal(v(t, '/sh:s1/D2'), 12.5);
  assert.equal(v(t, '/sh:s1/D4'), 16.5);
  await t.undo();
  assert.equal(v(t, '/sh:s1/D4'), 7.75);
  // Alt+Enter input wraps.
  await t.exec('test.cellSet', {sheet: 0, row: 5, col: 0, input: 'two\nlines'});
  assert.equal(t.read('/sh:s1/A6', 'props').wrap, true);
  // Emptying a cell removes it.
  await t.exec('test.cellSet', {sheet: 0, row: 5, col: 0, input: ''});
  assert.equal(t.read('/sh:s1/A6', 'values'), null);
});

test('AutoFill: series, text numbers, lists, months, Ctrl+drag, formulas shift their relative references', async () => {
  const t = await session(createContent('x', {id: 's1'}));
  const put = (row, col, input) => t.exec('test.cellSet', {sheet: 0, row, col, input});
  await put(0, 0, '1'); await put(1, 0, '3');
  await expectUndoRoundTrip(t, 'test.fill', {source: '/sh:s1/A1:A2', target: '/sh:s1/A1:A5'}, after => {
    assert.deepEqual(after.read('/sh:s1/A1:A5', 'values'), [[1], [3], [5], [7], [9]]);
  });
  await put(0, 1, 'Item 9');
  await t.exec('test.fill', {source: '/sh:s1/B1', target: '/sh:s1/B1:B3'});
  assert.deepEqual(t.read('/sh:s1/B1:B3', 'values'), [['Item 9'], ['Item 10'], ['Item 11']]);
  await put(0, 2, 'Mon');
  await t.exec('test.fill', {source: '/sh:s1/C1', target: '/sh:s1/C1:C3'});
  assert.deepEqual(t.read('/sh:s1/C1:C3', 'values'), [['Mon'], ['Tue'], ['Wed']]);
  await put(0, 3, '1/15/2026'); await put(1, 3, '2/15/2026');
  await t.exec('test.fill', {source: '/sh:s1/D1:D2', target: '/sh:s1/D1:D4'});
  assert.deepEqual(t.read('/sh:s1/D1:D4', 'display'), [['1/15/2026'], ['2/15/2026'], ['3/15/2026'], ['4/15/2026']], 'same day, whole months');
  // Different days step by the linear trend in days (fill.rs `detect`).
  await put(0, 7, '1/31/2026'); await put(1, 7, '2/28/2026');
  await t.exec('test.fill', {source: '/sh:s1/H1:H2', target: '/sh:s1/H1:H4'});
  assert.deepEqual(t.read('/sh:s1/H3:H4', 'display'), [['3/28/2026'], ['4/25/2026']]);
  await put(0, 4, '5');
  await t.exec('test.fill', {source: '/sh:s1/E1', target: '/sh:s1/E1:E3'});
  assert.deepEqual(t.read('/sh:s1/E1:E3', 'values'), [[5], [5], [5]], 'a lone number copies');
  await t.exec('test.fill', {source: '/sh:s1/E1', target: '/sh:s1/E1:E3', mode: 'alternate'});
  assert.deepEqual(t.read('/sh:s1/E1:E3', 'values'), [[5], [6], [7]], 'Ctrl+drag counts up');
  await put(0, 5, '=A1*2'); await put(0, 6, '=$A$1+A1');
  await t.exec('test.fill', {source: '/sh:s1/F1:G1', target: '/sh:s1/F1:G3'});
  assert.deepEqual(t.read('/sh:s1/F1:G3', 'formulas'), [['=A1*2', '=$A$1+A1'], ['=A2*2', '=$A$1+A2'], ['=A3*2', '=$A$1+A3']]);
  assert.deepEqual(t.read('/sh:s1/F3:G3', 'values'), [[10, 6]]);
  // Filling up (backward) continues the series downward.
  await put(9, 0, '10'); await put(10, 0, '20');
  await t.exec('test.fill', {source: '/sh:s1/A10:A11', target: '/sh:s1/A8:A11'});
  assert.deepEqual(t.read('/sh:s1/A8:A9', 'values'), [[-10], [0]]);
});

test('structural edits: inserting rows moves cells, formulas, names and anchors; undo restores', async () => {
  const c = twoSheets();
  c.names = [{name: 'Total', formula: 'Sheet1!$D$4'}];
  c.sheets[1].blocks = {0: {A1: {f: 'Sheet1!D4*2'}}};
  const t = await session(c);
  const anchor = t.anchor('/sh:s1/D4');
  await expectUndoRoundTrip(t, 'test.insertRows', {sheet: 's1', at: 1, count: 2}, after => {
    assert.equal(after.read('/sh:s1/D6', 'formulas'), '=SUM(D4:D5)');
    assert.equal(after.read('/sh:s1/D4', 'formulas'), '=B4*C4');
    assert.equal(after.read('/sh:s2/A1', 'formulas'), '=Sheet1!D6*2');
  });
  // expectUndoRoundTrip ends redone: the rows are inserted once, the anchor followed run, undo and redo.
  assert.equal(t.where(anchor).address, '/sh:s1/D6');
  assert.equal(t.content.names[0].formula, 'Sheet1!$D$6');
  assert.equal(v(t, '/sh:s2/A1'), 15.5);
  await t.exec('test.deleteCols', {sheet: 's1', at: 3, count: 1});
  assert.equal(t.where(anchor).deleted, true);
  assert.equal(t.read('/sh:s2/A1', 'formulas'), '=#REF!*2');
  await t.undo(2);
  assert.equal(t.read('/sh:s1/D4', 'formulas'), '=SUM(D2:D3)');
  const fresh = t.anchor('/sh:s1/D4');
  await t.exec('test.insertRows', {sheet: 's1', at: 0, count: 1});
  await t.undo();
  assert.equal(t.where(fresh).address, '/sh:s1/D4', 'an undone insert moves anchors back');
});

test('doc.changed names the cells a command wrote', async () => {
  const t = await session();
  const r = await t.exec('test.cellSet', {sheet: 0, row: 6, col: 2, input: 'x'});
  assert.deepEqual(r.changed, ['/sh:s1/C7']);
  const r2 = await t.exec('test.insertRows', {sheet: 's2', at: 0, count: 1});
  assert.deepEqual(r2.changed, ['/sh:s2']);
});

test('legacy /v1 set_cells on a schema-2 workbook types the input', () => {
  const next = applyLegacyCommand(twoSheets(), {type: 'set_cells', sheetId: 's1', cells: {B2: {value: '7'}, E1: {value: '=B2+1'}}});
  assert.equal(next.sheets[0].blocks[0].B2.v, 7);
  assert.equal(model.valueAt(next, 0, 0, 4), 8);
});

test('selection: kernel round trip, merges expand, Enter cycles, Ctrl+arrow jumps, current region', () => {
  const c = twoSheets();
  c.sheets[0].merges = ['F1:G2'];
  const sel = {sheet: 0, active: {row: 1, col: 1}, anchor: {row: 1, col: 1}, ranges: [{start: {row: 0, col: 0}, end: {row: 0, col: 0}}, {start: {row: 1, col: 1}, end: {row: 3, col: 2}}]};
  const k = model.toKernelSelection(c, sel);
  assert.deepEqual(k, {ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/A1'}, {anchor: '/sh:s1/B2', focus: '/sh:s1/C4'}], primary: 1});
  assert.deepEqual(model.fromKernelSelection(c, k), sel);
  const cols = model.toKernelSelection(c, {sheet: 1, active: {row: 0, col: 3}, anchor: {row: 0, col: 3}, ranges: [{start: {row: 0, col: 1}, end: {row: 1048575, col: 3}}]});
  assert.deepEqual(cols.ranges[0], {anchor: '/sh:s2/col:D', focus: '/sh:s2/col:B'});
  assert.equal(model.fromKernelSelection(c, cols).ranges[0].end.row, 1048575);
  const grown = model.expandMerges({sheet: 0, active: {row: 1, col: 4}, anchor: {row: 1, col: 4}, ranges: [{start: {row: 1, col: 4}, end: {row: 1, col: 5}}]}, c.sheets[0]);
  assert.deepEqual(grown.ranges[0], {start: {row: 0, col: 4}, end: {row: 1, col: 6}});
  const vals = (r, col) => model.valueAt(c, 0, r, col);
  const used = {start: {row: 0, col: 0}, end: {row: 3, col: 3}};
  assert.deepEqual(model.jump(vals, used, {row: 0, col: 0}, 1, 0), {row: 3, col: 0});
  assert.deepEqual(model.jump(vals, used, {row: 3, col: 0}, 1, 0), {row: 1048575, col: 0});
  const filled = (r, col) => model.hasContent(model.cellAt(c.sheets[0], r, col));
  assert.deepEqual(model.currentRegion(filled, {row: 2, col: 1}), {start: {row: 0, col: 0}, end: {row: 3, col: 3}});
});

test('editor model: pointing, autocomplete, argument hint, reference colours', () => {
  let e = ed.editState({sheet: 0, cell: {row: 0, col: 0}, text: '=SUM(', enterMode: true});
  assert.ok(ed.canPoint(e));
  e = ed.insertRef(e, 'A1');
  e = ed.insertRef(e, 'A2:B3');
  assert.equal(e.text, '=SUM(A2:B3');
  e = ed.appendRef(e, 'C1');
  assert.equal(e.text, '=SUM(A2:B3,C1');
  e = ed.updateAutocomplete(ed.editState({sheet: 0, cell: {row: 0, col: 0}, text: '=ro'}), ['ROUND', 'ROUNDDOWN', 'ROW', 'SUM']);
  assert.deepEqual(e.autocomplete, ['ROUND', 'ROUNDDOWN', 'ROW']);
  e = ed.acceptAutocomplete(e);
  assert.equal(e.text, '=ROUND(');
  assert.equal(e.caret, 7);
  assert.deepEqual(ed.currentFunction(ed.editState({sheet: 0, cell: {row: 0, col: 0}, text: '=IF(A1>0,ROUND(B1,'})), {name: 'ROUND', arg: 1});
  assert.ok(!ed.canPoint(ed.editState({sheet: 0, cell: {row: 0, col: 0}, text: 'hello'})));
});

test('contextual flags: table under the active cell, objects selected', () => {
  assert.deepEqual(flags.length, 10);
  const c = twoSheets();
  c.sheets[0].tables = [{name: 'Fruit', range: 'A1:D3', headerRow: true, columns: [{name: 'Item'}, {name: 'Qty'}, {name: 'Price'}, {name: 'Total'}]}];
  assert.equal(contextFlags(c, {ranges: [{anchor: '/sh:s1/B2', focus: '/sh:s1/B2'}], primary: 0})['table-design'], true);
  assert.equal(contextFlags(c, {ranges: [{anchor: '/sh:s1/F9', focus: '/sh:s1/F9'}], primary: 0})['table-design'], false);
  const chart = contextFlags(c, {ranges: [{anchor: '/sh:s1/chart:1', focus: '/sh:s1/chart:1'}], primary: 0});
  assert.equal(chart['chart-design'], true);
  assert.equal(chart.format, true);
  assert.equal(address.resolve(c, '/tbl:Fruit/col:Price').a1, 'Sheet1!C1:C3');
});

test('app ops apply and invert exactly', () => {
  const c = twoSheets();
  const {content, inverse} = applyOp(c, {op: 'grid.structure', sheet: 's1', edit: {type: 'insert', axis: 'cols', at: 0, count: 1}});
  assert.equal(content.sheets[0].blocks[0].B1.v, 'Item');
  assert.equal(content.sheets[0].blocks[0].E4.f, 'SUM(E2:E3)');
  const back = applyOp(content, inverse).content;
  assert.deepEqual(back, c);
});
