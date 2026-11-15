// U:grid/data: the Table Design tab: Table Name, Resize Table, Convert to Range, Header Row, Total Row,
// the style options, Table Styles and the Total Row functions, each with its undo round trip.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/insert.rs (the table_rename test: invalid and duplicate names,
//    the same name again), cmd/insert/table.rs (`table_flag`, `write_totals`, `table_total_fn`),
//    cmd/extra/data.rs (`table_resize`). Excel: Header Row clears and rewrites the header cells, Total Row adds
//    "Total" and a SUBTOTAL, Convert to Range keeps the look as formatting and turns references into cells.
// 2. Ours runs those commands through the translated model, one undo step each.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, v, stored, run, fails, style, errorOf} from './edit-helpers.mjs';

const sheet = t => t.content.sheets[0];

/** Sales table A1:C4 (Item, Qty, Price) with formulas outside that name it. */
function sales() {
  return workbook([{id: 's1', name: 'Sheet1', blocks: {0: {
    A1: {v: 'Item'}, B1: {v: 'Qty'}, C1: {v: 'Price'},
    A2: {v: 'ax'}, B2: {v: 10}, C2: {v: 1.5},
    A3: {v: 'bolt'}, B3: {v: 20}, C3: {v: 2},
    A4: {v: 'cog'}, B4: {v: 30}, C4: {v: 4},
    E1: {f: 'SUM(Sales[Qty])'}, E2: {f: 'COUNTA(Sales[#Headers])'}, F2: {f: '[@Qty]*2'},
  }}, tables: [{name: 'Sales', range: 'A1:C4', headerRow: true, totalsRow: false, columns: [{name: 'Item'}, {name: 'Qty'}, {name: 'Price'}],
    style: {name: 'TableStyleMedium2', showRowStripes: true, showColumnStripes: false, showFirstColumn: false, showLastColumn: false}, autoFilter: true}]}]);
}
const select = (t, cell) => run(t, 'selection.set', {cell});

test('table.rename: validity and uniqueness as the upstream test, structured references follow, slicers and defined names too', async () => {
  const wb = sales();
  wb.sheets[0].slicers = [{id: 1, table: 'Sales', column: 'Item', caption: 'Item', anchor: {cell: 'H2'}, selected: null, columns: 1}];
  wb.names = [{name: 'Rate', formula: 'Sales[Price]'}];
  const t = await session(wb);
  await select(t, 'B2');
  for (const name of ['A1', 'R1C1', 'my-table', '1abc', 'has space']) assert.ok(await fails(t, 'table.rename', {name}), `refused ${name}`);
  assert.match((await fails(t, 'table.rename', {name: 'rate'})).message, /already exists/);
  await run(t, 'table.rename', {name: 'Sales'});
  await expectUndoRoundTrip(t, 'table.rename', {name: 'Orders'}, () => {});
  assert.equal(sheet(t).tables[0].name, 'Orders');
  assert.equal(stored(t, 'E1').f, 'SUM(Orders[Qty])');
  assert.equal(stored(t, 'E2').f, 'COUNTA(Orders[#Headers])');
  assert.equal(stored(t, 'F2').f, '[@Qty]*2');
  assert.equal(t.content.names[0].formula, 'Orders[Price]');
  assert.equal(sheet(t).slicers[0].table, 'Orders');
  assert.equal(v(t, 'E1'), 60);
});

test('table.resize: the headers stay in their row, the new range overlaps the old one, new columns are named', async () => {
  const t = await session(sales());
  await select(t, 'A2');
  assert.match((await fails(t, 'table.resize', {range: 'A2:C4'})).message, /headers must remain/);
  assert.match((await fails(t, 'table.resize', {range: 'E1:F4'})).message, /headers must remain/);
  await expectUndoRoundTrip(t, 'table.resize', {range: 'A1:D6'}, () => {});
  const tb = sheet(t).tables[0];
  assert.equal(tb.range, 'A1:D6');
  assert.deepEqual(tb.columns.map(c => c.name), ['Item', 'Qty', 'Price', 'Column4']);
  assert.equal(stored(t, 'D1').v, 'Column4');
  await run(t, 'table.resize', {range: '$A$1:$B$3'});
  assert.deepEqual(sheet(t).tables[0].columns.map(c => c.name), ['Item', 'Qty']);
});

test('table.totalRow: "Total" and a SUBTOTAL, cells below move down, the functions change and it goes away', async () => {
  const wb = sales();
  wb.sheets[0].blocks[0].A5 = {v: 'below'};
  const t = await session(wb);
  await select(t, 'B2');
  await expectUndoRoundTrip(t, 'table.totalRow', {}, () => {});
  const tb = sheet(t).tables[0];
  assert.equal(tb.totalsRow, true);
  assert.equal(tb.range, 'A1:C5');
  assert.equal(stored(t, 'A5').v, 'Total');
  assert.equal(stored(t, 'C5').f, 'SUBTOTAL(109,Sales[Price])');
  assert.equal(v(t, 'C5'), 7.5);
  assert.equal(stored(t, 'A6').v, 'below');
  await run(t, 'table.totalFunction', {column: 'Qty', function: 'average'});
  assert.equal(v(t, 'B5'), 20);
  await run(t, 'table.totalFunction', {column: 'Item', function: 'count'});
  assert.equal(v(t, 'A5'), 3);
  await run(t, 'table.totalFunction', {column: 'Item', function: 'none'});
  assert.equal(stored(t, 'A5'), null);
  assert.ok(await fails(t, 'table.totalFunction', {column: 'Nope', function: 'sum'}));
  await run(t, 'table.totalRow', {on: false});
  assert.equal(sheet(t).tables[0].range, 'A1:C4');
  assert.equal(stored(t, 'C5'), null);
  assert.equal(sheet(t).tables[0].totalsRow, false);
});

test('table.headerRow: hiding clears the header cells and keeps the names; showing writes them back, inserting a row when needed', async () => {
  const t = await session(sales());
  await select(t, 'B2');
  await expectUndoRoundTrip(t, 'table.headerRow', {}, () => {});
  let tb = sheet(t).tables[0];
  assert.equal(tb.headerRow, false);
  assert.equal(tb.range, 'A2:C4');
  assert.equal(stored(t, 'A1'), null);
  assert.deepEqual(tb.columns.map(c => c.name), ['Item', 'Qty', 'Price']);
  assert.equal(v(t, 'E1'), 60, 'structured references still resolve');
  await run(t, 'table.headerRow', {on: true});
  tb = sheet(t).tables[0];
  assert.equal(tb.headerRow, true);
  assert.equal(tb.range, 'A1:C4');
  assert.deepEqual(['A1', 'B1', 'C1'].map(k => stored(t, k).v), ['Item', 'Qty', 'Price']);
});

test('table.headerRow on a table whose row above holds data inserts a row, keeping that data', async () => {
  const wb = sales();
  const sh = wb.sheets[0];
  // The table sits one row lower, under a title row.
  const b = sh.blocks[0];
  for (const k of Object.keys(b)) if (/^[ABC]\d+$/.test(k)) { const n = Number(k.slice(1)); b[k[0] + (n + 1)] = b[k]; delete b[k]; }
  b.A1 = {v: 'Title'};
  sh.tables[0].range = 'A2:C5';
  sh.tables[0].headerRow = true;
  const t = await session(wb);
  await select(t, 'B3');
  await run(t, 'table.headerRow', {on: false});
  assert.equal(sheet(t).tables[0].range, 'A3:C5');
  // The row above the data is now empty again (the old header), so the names go back there.
  await run(t, 'table.headerRow', {on: true});
  assert.equal(sheet(t).tables[0].range, 'A2:C5');
  assert.equal(stored(t, 'A1').v, 'Title');
  assert.equal(stored(t, 'B2').v, 'Qty');
});

test('style options and Table Styles: flags, a named style, Clear and the look', async () => {
  const t = await session(sales());
  await select(t, 'B2');
  for (const [cmd, key, was] of [['table.bandedRows', 'showRowStripes', true], ['table.bandedColumns', 'showColumnStripes', false], ['table.firstColumn', 'showFirstColumn', false], ['table.lastColumn', 'showLastColumn', false]]) {
    await expectUndoRoundTrip(t, cmd, {}, () => {});
    assert.equal(sheet(t).tables[0].style[key], !was, cmd);
    await run(t, cmd, {on: was});
    assert.equal(sheet(t).tables[0].style[key], was);
  }
  await expectUndoRoundTrip(t, 'table.style', {style: 'TableStyleDark3'}, () => {});
  assert.equal(sheet(t).tables[0].style.name, 'TableStyleDark3');
  assert.ok(await fails(t, 'table.style', {style: 'TableStyleNope'}));
  await run(t, 'table.style', {style: 'None'});
  assert.equal(sheet(t).tables[0].style.name, null);
  // The gallery draws every built-in style as a tile and marks the current one; the name box shows the table.
  await run(t, 'table.style', {style: 'TableStyleMedium9'});
  const gal = await t.state('table.style');
  assert.equal(gal.value.length, 60);
  assert.deepEqual(gal.value.filter(x => x.selected).map(x => x.id), ['TableStyleMedium9']);
  assert.equal(gal.value[0].art.kind, 'table');
  assert.ok(gal.value.find(x => x.id === 'TableStyleMedium9').art.header);
  assert.equal((await t.state('table.rename')).value, 'Sales');
  assert.equal((await t.state('table.headerRow')).checked, true);
});

test('table.convertToRange: the table look stays as formatting, references become cells, the table and its slicers go', async () => {
  const wb = sales();
  wb.sheets[0].slicers = [{id: 1, table: 'Sales', column: 'Item', caption: 'Item', anchor: {cell: 'H2'}, selected: null, columns: 1}];
  // A calculated column inside the table: `[@Qty]` names no table.
  wb.sheets[0].blocks[0].D1 = {v: 'Double'}; wb.sheets[0].blocks[0].D2 = {f: '[@Qty]*2'};
  wb.sheets[0].tables[0] = {...wb.sheets[0].tables[0], range: 'A1:D4', columns: [...wb.sheets[0].tables[0].columns, {name: 'Double'}]};
  const t = await session(wb);
  await select(t, 'B2');
  await expectUndoRoundTrip(t, 'table.convertToRange', {}, () => {});
  assert.equal(sheet(t).tables, undefined);
  assert.equal(sheet(t).slicers, undefined);
  assert.equal(stored(t, 'E1').f, 'SUM(B2:B4)');
  assert.equal(stored(t, 'E2').f, 'COUNTA(A1:D1)');
  assert.equal(stored(t, 'D2').f, 'B2*2');
  assert.equal(stored(t, 'F2').f, '[@Qty]*2', 'outside the table it names nothing');
  assert.equal(v(t, 'E1'), 60);
  assert.equal(style(t, 'A1').font.bold, true);
  assert.notEqual(style(t, 'A1').fill.pattern, 'none');
  assert.equal(errorOf(v(t, 'E1')), null);
});

test('table.removeDuplicates removes repeated data rows of the table', async () => {
  const wb = sales();
  wb.sheets[0].blocks[0].A5 = {v: 'ax'}; wb.sheets[0].blocks[0].B5 = {v: 10}; wb.sheets[0].blocks[0].C5 = {v: 1.5};
  wb.sheets[0].tables[0].range = 'A1:C5';
  const t = await session(wb);
  await select(t, 'B2');
  const r = await run(t, 'table.removeDuplicates', {});
  assert.equal(r.removed, 1);
  assert.equal(v(t, 'A5'), null);
});

test('the tab commands need a table at the selection, or its name', async () => {
  const t = await session(sales());
  await select(t, 'H9');
  assert.match((await fails(t, 'table.totalRow', {})).message, /select a cell in a table/i);
  await run(t, 'table.totalRow', {table: 'sales'});
  assert.equal(sheet(t).tables[0].totalsRow, true);
});
