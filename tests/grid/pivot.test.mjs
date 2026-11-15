// U:grid/pivot: PivotTables (Insert > PivotTable, the PivotTable Fields commands, Analyze and Design commands, refresh, protection
// and shifting with the cells).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/pivot/tests.rs at fb1e59f (the sales table, Region by Product, several value fields,
//    date grouping, report filters and hidden items, Show Values As, Compact, Outline and Tabular shapes, collapse, refresh and
//    change source, replace protection and overlaps, fields move/remove/sort, Summarize with PivotTable, repeated header names,
//    hostile parameters, empty headers, too many columns, collapsed column items, inserting and deleting lines, Show Details). Not translated
//    (hidden in the ribbon): Σ Values in rows, PivotCharts, calculated fields, Recommended PivotTables.
// 2. Ours: the same commands over our sheet model (sheet.pivots, the report written as plain styled cells).
// 3. These tests; tests/e2e/grid/pivot.e2e.mjs drives the ribbon, the dialogs and the Fields pane.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run, fails, v, text, style, stored} from './edit-helpers.mjs';

const SALES = [
  ['Region', 'Product', 'Date', 'Units', 'Sales'],
  ['East', 'Apples', '1/15/2026', 10, 100], ['West', 'Apples', '2/10/2026', 5, 50], ['East', 'Pears', '3/3/2026', 8, 120],
  ['North', 'Pears', '4/20/2026', 2, 30], ['West', 'Plums', '5/5/2026', 7, 70], ['East', 'Plums', '6/30/2026', 4, 60],
  ['North', 'Apples', '7/4/2026', 9, 90], ['West', 'Pears', '8/8/2026', 3, 45], ['East', 'Apples', '9/9/2026', 6, 60],
  ['North', 'Plums', '10/10/2026', 1, 15], ['West', 'Apples', '11/11/2026', 12, 120], ['East', 'Pears', '12/12/2026', 5, 75],
];
const TOTAL = 835;

async function sales() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: SALES});
  await run(t, 'selection.set', {range: 'A1'});
  return t;
}
const pt = (t, si) => { const sh = t.content.sheets[si ?? t.content.sheets.findIndex(s => (s.pivots ?? []).length)]; return sh.pivots[sh.pivots.length - 1]; };
const onReport = t => t.content.sheets.findIndex(s => (s.pivots ?? []).length);
const T = (t, ref) => text(t, ref, onReport(t));
const V = (t, ref) => v(t, ref, onReport(t));
const findRow = (t, label) => {
  const r = pt(t).lastRange.split(':');
  const first = Number(/\d+/.exec(r[0])[0]), last = Number(/\d+/.exec(r[1])[0]);
  const col = /[A-Z]+/.exec(r[0])[0];
  for (let row = first; row <= last; row++) if (T(t, col + row) === label) return row;
  return null;
};

test('insert creates the placeholder on a new sheet before the current one, as one undo step', async () => {
  const t = await sales();
  const r = await run(t, 'insert.pivotTable', {});
  assert.equal(r.name, 'PivotTable1');
  assert.equal(r.anchor, 'A3');
  assert.deepEqual(r.fields, ['Region', 'Product', 'Date', 'Units', 'Sales']);
  assert.equal(t.content.sheets.length, 2);
  assert.equal(t.content.sheets[0].name, 'Sheet2', 'the new sheet goes before the current one');
  assert.ok(T(t, 'A3').startsWith('PivotTable1'));
  assert.equal(pt(t).source, 'Sheet1!$A$1:$E$13');
  await run(t, 'edit.undo', {});
  assert.equal(t.content.sheets.length, 1);
});

test('Region by Product, sum of Sales: totals, styles and the listing', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {});
  await run(t, 'pivot.addField', {field: 'region', area: 'rows'});
  await run(t, 'pivot.addField', {field: 'Product', area: 'columns'});
  const r = await run(t, 'pivot.addField', {field: 'Sales', area: 'values'});
  assert.equal(r.range, 'A3:E8');
  assert.deepEqual(['A3', 'B3', 'A4', 'B4', 'C4', 'D4', 'E4'].map(a => T(t, a)), ['Sum of Sales', 'Column Labels', 'Row Labels', 'Apples', 'Pears', 'Plums', 'Grand Total']);
  assert.deepEqual(['A5', 'A6', 'A7', 'A8'].map(a => T(t, a)), ['East', 'North', 'West', 'Grand Total']);
  assert.deepEqual([V(t, 'B5'), V(t, 'C5'), V(t, 'E5'), V(t, 'E8')], [160, 195, 415, TOTAL]);
  assert.equal(V(t, 'B8') + V(t, 'C8') + V(t, 'D8'), TOTAL);
  assert.equal(V(t, 'E5') + V(t, 'E6') + V(t, 'E7'), TOTAL);
  const si = onReport(t);
  assert.equal(style(t, 'A4', si).font.bold, true, 'header bold');
  const g = style(t, 'B8', si);
  assert.ok(g.font.bold && g.borders.top, 'grand total bold with a top border');
  const l = await run(t, 'pivot.list', {});
  assert.equal(l[0].values[0].name, 'Sum of Sales');
});

test('several value fields make a values dimension', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales', {field: 'Units', func: 'average'}]});
  assert.deepEqual(['A3', 'B3', 'C3', 'A7'].map(a => T(t, a)), ['Row Labels', 'Sum of Sales', 'Average of Units', 'Grand Total']);
  assert.equal(V(t, 'B7'), TOTAL);
  assert.equal(V(t, 'C7'), 72 / 12);
  await run(t, 'pivot.addField', {field: 'Product', area: 'columns'});
  assert.deepEqual(['B4', 'B5', 'C5', 'D4', 'H4', 'I4'].map(a => T(t, a)), ['Apples', 'Sum of Sales', 'Average of Units', 'Pears', 'Total Sum of Sales', 'Total Average of Units']);
  const last = pt(t).lastRange.split(':')[1];
  assert.equal(V(t, 'H' + /\d+/.exec(last)[0]), TOTAL);
});

test('dates group by quarters, months and years; a text field cannot be grouped', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Date'], values: ['Sales']});
  const range = pt(t).lastRange.split(':');
  assert.equal(Number(/\d+/.exec(range[1])[0]) - Number(/\d+/.exec(range[0])[0]) + 1, 14, 'ungrouped: one row per date');
  await run(t, 'pivot.group', {field: 'Date', by: 'quarters'});
  assert.deepEqual(['A4', 'A7'].map(a => T(t, a)), ['Qtr1', 'Qtr4']);
  assert.deepEqual([V(t, 'B4'), V(t, 'B5'), V(t, 'B8')], [270, 160, TOTAL]);
  await run(t, 'pivot.group', {field: 'Date', by: 'months'});
  assert.deepEqual(['A4', 'A15'].map(a => T(t, a)), ['Jan', 'Dec']);
  await run(t, 'pivot.group', {field: 'Date', by: 'years'});
  assert.equal(T(t, 'A4'), '2026');
  await run(t, 'pivot.addField', {field: 'Region', area: 'columns'});
  await fails(t, 'pivot.group', {field: 'Region', by: 'years'});
});

test('report filters sit above the body; hidden items drop out of a row field', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Product'], values: ['Sales'], filters: ['Region']});
  assert.deepEqual(['A1', 'B1', 'A3'].map(a => T(t, a)), ['Region', '(All)', 'Row Labels']);
  await run(t, 'pivot.filter', {field: 'Region', selected: ['East']});
  assert.equal(T(t, 'B1'), 'East');
  assert.equal(V(t, 'B' + findRow(t, 'Grand Total')), 415);
  await run(t, 'pivot.filter', {field: 'Region', selected: ['East', 'west']});
  assert.equal(T(t, 'B1'), '(Multiple Items)');
  await run(t, 'pivot.filter', {field: 'Region', selected: null});
  assert.equal(V(t, 'B' + findRow(t, 'Grand Total')), TOTAL);
  await run(t, 'pivot.filter', {field: 'Product', selected: ['Apples']});
  assert.deepEqual([T(t, 'A4'), T(t, 'A5'), V(t, 'B5')], ['Apples', 'Grand Total', 420]);
  await fails(t, 'pivot.filter', {field: 'Product', selected: []});
});

test('Show Values As: percent of the grand total, running total, rank, then back with a function and a format', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  await run(t, 'pivot.valueSettings', {field: 'Sum of Sales', showAs: 'percentOfGrandTotal'});
  assert.ok(Math.abs(V(t, 'B4') - 415 / TOTAL) < 1e-12);
  assert.equal(V(t, 'B7'), 1);
  assert.equal(T(t, 'B7'), '100.00%');
  assert.equal(style(t, 'B4', onReport(t)).numFmt, '0.00%');
  await run(t, 'pivot.valueSettings', {index: 0, showAs: 'runningTotal'});
  assert.deepEqual([V(t, 'B4'), V(t, 'B5'), V(t, 'B6')], [415, 550, TOTAL]);
  await run(t, 'pivot.valueSettings', {index: 0, showAs: 'rank'});
  assert.deepEqual([V(t, 'B4'), V(t, 'B5'), V(t, 'B6')], [1, 3, 2]);
  await run(t, 'pivot.valueSettings', {index: 0, showAs: 'normal', func: 'max', numberFormat: '#,##0'});
  assert.equal(T(t, 'B3'), 'Max of Sales');
  assert.equal(V(t, 'B4'), 120);
  await fails(t, 'pivot.valueSettings', {index: 0, name: 'Sales'});
  await run(t, 'pivot.valueSettings', {index: 0, name: 'Biggest sale'});
  assert.equal(T(t, 'B3'), 'Biggest sale');
});

test('Compact, Outline and Tabular shapes, subtotals, grand totals and collapse', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region', 'Product'], values: ['Sales']});
  const size = () => { const [a, b] = pt(t).lastRange.split(':').map(x => ({col: /[A-Z]+/.exec(x)[0], row: Number(/\d+/.exec(x)[0])})); return {w: b.col.charCodeAt(0) - a.col.charCodeAt(0) + 1, h: b.row - a.row + 1}; };
  assert.deepEqual(size(), {w: 2, h: 1 + 3 + 9 + 1}, 'compact: one label column, subtotals at the top');
  assert.deepEqual([T(t, 'A4'), V(t, 'B4'), T(t, 'A5')], ['East', 415, 'Apples']);
  const si = onReport(t);
  assert.equal(style(t, 'A5', si).align.indent, 1);
  assert.equal(style(t, 'A4', si).font.bold, true);
  await run(t, 'pivot.layout', {layout: 'outline'});
  assert.equal(size().w, 3);
  assert.deepEqual(['A3', 'B3', 'A4', 'B5'].map(a => T(t, a)), ['Region', 'Product', 'East', 'Apples']);
  await run(t, 'pivot.layout', {layout: 'tabular'});
  assert.deepEqual(size(), {w: 3, h: 1 + 9 + 3 + 1});
  assert.deepEqual(['A4', 'B4', 'A5', 'B5', 'A7'].map(a => T(t, a)), ['East', 'Apples', '', 'Pears', 'East Total']);
  assert.equal(V(t, 'C7'), 415);
  await run(t, 'pivot.layout', {subtotals: false, grandTotalsCols: false});
  assert.equal(size().h, 1 + 9);
  await run(t, 'pivot.layout', {layout: 'compact', subtotals: 'top'});
  await run(t, 'pivot.collapse', {field: 'Region', items: ['East']});
  assert.deepEqual([T(t, 'A4'), T(t, 'A5')], ['East', 'North']);
  await run(t, 'pivot.collapse', {field: 'Region', collapse: false});
  assert.equal(T(t, 'A5'), 'Apples');
});

test('change source keeps the fields the new source still has', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region', 'Product'], values: ['Sales', 'Units']});
  const r = await run(t, 'pivot.changeSource', {source: 'Sheet1!B1:E13'});
  assert.deepEqual(r.dropped, ['Region']);
  assert.equal(pt(t).rows.length, 1);
  assert.equal(T(t, 'A4'), 'Apples');
});

test('refresh after source edits, Refresh All, and a smaller source clears the old rows', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  const rep = onReport(t);
  await run(t, 'sheet.activate', {sheet: 'Sheet1'});
  await run(t, 'cell.set', {cell: 'E2', input: '1100'});
  assert.equal(V(t, 'B4'), 415, 'a pivot reads its source only when refreshed');
  const r = await run(t, 'data.refreshAll', {});
  assert.equal(r.refreshed, 1);
  assert.deepEqual([V(t, 'B4'), V(t, 'B7')], [1415, TOTAL + 1000]);
  await run(t, 'pivot.changeSource', {pivot: 'PivotTable1', source: 'Sheet1!A1:E3'});
  assert.equal(text(t, 'A6', rep), 'Grand Total');
  assert.equal(v(t, 'B6', rep), 1150);
  assert.equal(v(t, 'A7', rep), null, 'old rows are cleared');
  await run(t, 'pivot.refresh', {pivot: 'PivotTable1'});
});

test('replace protection: data in the way, overlaps, the source itself, and delete clears the report', async () => {
  const t = await sales();
  await run(t, 'cell.set', {cell: 'H5', input: 'keep me'});
  const e = await fails(t, 'insert.pivotTable', {destination: 'Sheet1!H3', rows: ['Region'], values: ['Sales']});
  assert.match(e.message, /There's already data in Sheet1!H5/);
  assert.equal((t.content.sheets[0].pivots ?? []).length, 0);
  await run(t, 'insert.pivotTable', {destination: 'Sheet1!H3'});
  await fails(t, 'pivot.addField', {field: 'Region', area: 'rows'});
  await run(t, 'pivot.addField', {field: 'Region', area: 'rows', replace: true});
  assert.equal(T(t, 'H5'), 'North');
  const o = await fails(t, 'insert.pivotTable', {source: 'Sheet1!A1:E13', destination: 'Sheet1!H6', replace: true});
  assert.match(o.message, /overlap/);
  const s = await fails(t, 'insert.pivotTable', {source: 'Sheet1!A1:E13', destination: 'Sheet1!B2', replace: true});
  assert.match(s.message, /source data/);
  await run(t, 'pivot.delete', {});
  assert.equal(v(t, 'H5', 0), null);
  assert.equal((t.content.sheets[0].pivots ?? []).length, 0);
});

test('fields move, remove and sort; unknown fields and areas are refused', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  const f = await run(t, 'pivot.fields', {});
  assert.equal(f.fields[0].name, 'Region');
  assert.deepEqual(f.fields[0].samples, ['East', 'North', 'West']);
  assert.deepEqual(f.fields[0].areas, ['rows']);
  assert.equal(f.fields[4].numeric, true);
  assert.equal(f.fields[2].date, true);
  await run(t, 'pivot.sort', {field: 'Region', order: 'desc'});
  assert.equal(T(t, 'A4'), 'West');
  await run(t, 'pivot.moveField', {field: 'Region', from: 'rows', to: 'columns'});
  assert.equal(T(t, 'B4'), 'West');
  await run(t, 'pivot.removeField', {field: 'Sum of Sales', area: 'values'});
  await run(t, 'pivot.addField', {field: 'Region', area: 'values'});
  assert.equal(pt(t).values[0].name, 'Count of Region');
  await run(t, 'pivot.removeField', {field: 'Region'});
  assert.ok(pt(t).columns.length === 0 && pt(t).values.length === 0);
  assert.match(T(t, 'A3'), /choose fields/);
  await fails(t, 'pivot.addField', {field: 'Nope', area: 'rows'});
  await fails(t, 'pivot.addField', {field: 'Region', area: 'sideways'});
});

test('the active cell picks the field Sort, Group, Collapse and Value Field Settings work on', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region', 'Product'], values: ['Sales']});
  const rep = onReport(t);
  const at = cell => run(t, 'selection.set', {range: cell, sheet: t.content.sheets[rep].name});
  await at('A5');
  const f = await run(t, 'pivot.fields', {});
  assert.deepEqual([f.active.area, f.active.field], ['rows', 'Product'], 'an indented compact label is the second row field');
  await run(t, 'pivot.sort', {order: 'desc'});
  assert.equal(pt(t).rows[1].sort, 'desc');
  assert.equal(pt(t).rows[0].sort, 'asc');
  await at('B4');
  assert.equal((await run(t, 'pivot.fields', {})).active.area, 'values');
  await at('A4');
  await run(t, 'pivot.collapse', {});
  assert.deepEqual(pt(t).rows[0].collapsedItems.sort(), ['East', 'North', 'West']);
});

test('Summarize with PivotTable starts from a table; the table name is the source', async () => {
  const t = await sales();
  await run(t, 'insert.table', {range: 'A1:E13'});
  await run(t, 'selection.set', {range: 'B2'});
  const r = await run(t, 'table.summarizePivot', {rows: ['Product'], values: ['Units']});
  assert.equal(pt(t).source, 'Table1');
  assert.equal(r.name, 'PivotTable1');
  assert.equal(V(t, 'B' + findRow(t, 'Grand Total')), 72);
});

test('repeated headers get numbered names', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  const header = ['a', 'A', 'a', 'a2', ...Array.from({length: 300}, () => 'x')];
  await run(t, 'range.setValues', {range: 'A1', values: [header, header.map((_, i) => i)]});
  await run(t, 'selection.set', {range: 'A1'});
  const r = await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:KR2'});
  assert.deepEqual(r.fields.slice(0, 5), ['a', 'A2', 'a3', 'a22', 'x']);
  assert.equal(r.fields.at(-1), 'x300');
});

test('hostile parameters fail cleanly and never leave a half-written report', async () => {
  const t = await sales();
  const cmds = ['insert.pivotTable', 'table.summarizePivot', 'pivot.fields', 'pivot.fieldList', 'pivot.list', 'pivot.addField', 'pivot.removeField', 'pivot.moveField', 'pivot.valueSettings',
    'pivot.filter', 'pivot.sort', 'pivot.group', 'pivot.collapse', 'pivot.layout', 'pivot.grandTotals', 'pivot.subtotals', 'pivot.reportLayout', 'pivot.style', 'pivot.refresh', 'data.refreshAll',
    'pivot.changeSource', 'pivot.delete', 'pivot.options', 'pivot.clear', 'pivot.clearFilters', 'pivot.fieldHeaders'];
  const hostile = [{}, [1, 2], {pivot: 99999, field: 5, area: null}, {source: 'ZZZ999999999', destination: 'Nope!A1'}, {source: 'A:XFD', destination: 'Sheet1!XFD1048576'},
    {source: "''!A1", destination: '!'}, {field: 'Sales', area: 'values', func: 'bogus', position: 4294967295}, {field: 'Region', selected: [null, 1, {x: 1}], index: 1e30, showAs: 'rank'},
    {layout: 'weird', subtotals: 7, style: 'x'.repeat(500)}, {field: 'Date', by: 'decades', items: 'nope', order: 'sideways'}];
  for (const round of [0, 1]) {
    for (const c of cmds) for (const h of hostile) {
      try { await t.exec(c, h); } catch (e) { assert.ok(e && e.code, `${c} ${JSON.stringify(h)} threw a plain error: ${e?.stack}`); }
    }
    if (round === 0) { await run(t, 'selection.set', {range: 'A1', sheet: 'Sheet1'}); await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:E13', rows: ['Region'], values: ['Sales']}); }
  }
});

test('an empty header and a missing table are refused', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [['Region', ''], ['East', 1]]});
  const e = await fails(t, 'insert.pivotTable', {source: 'A1:B2'});
  assert.match(e.message, /field name is not valid/);
  await fails(t, 'insert.pivotTable', {source: 'NoSuchTable'});
});

test('too many value columns are refused', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  const rows = [['Cat', 'Sub', 'V']];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 64; c++) rows.push([`c${r}`, `s${c}`, 1]);
  await run(t, 'range.setValues', {range: 'A1', values: rows});
  const req = n => ({source: 'A1:C129', rows: ['Cat'], columns: ['Sub'], values: Array.from({length: n}, () => ({field: 'V'}))});
  const e = await fails(t, 'insert.pivotTable', req(256));
  assert.match(e.message, /will not fit/);
  await run(t, 'insert.pivotTable', req(128));
});

test('inserting or deleting lines moves the pivot with its cells, and its source with the cells it reads', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:E13', destination: 'Sheet1!H10', rows: ['Region'], values: ['Sales']});
  assert.equal(pt(t).lastRange, 'H10:I14');
  await run(t, 'home.insertRows', {rows: '16:17'});
  await run(t, 'home.insertRows', {rows: '6:7'});
  assert.equal(T(t, 'H12'), 'Row Labels');
  let l = await run(t, 'pivot.list', {});
  assert.deepEqual([l[0].anchor, l[0].range, l[0].source], ['H12', 'H12:I16', 'Sheet1!A1:E15']);
  await run(t, 'home.insertRows', {rows: '1:1'});
  assert.deepEqual([pt(t).source, pt(t).anchor], ['Sheet1!A2:E16', 'H13']);
  await run(t, 'pivot.refresh', {});
  assert.equal(pt(t).lastRange, 'H13:I17');
  assert.equal(T(t, 'H13'), 'Row Labels');
  assert.equal(V(t, 'I17'), TOTAL);
  await run(t, 'home.deleteColumns', {cols: 'F:F'});
  assert.deepEqual([pt(t).anchor, pt(t).lastRange], ['G13', 'G13:H17']);
  await run(t, 'home.deleteRows', {rows: '1:1'});
  assert.deepEqual([pt(t).source, pt(t).anchor], ['Sheet1!A1:E15', 'G12']);
  await run(t, 'pivot.refresh', {});
  assert.equal(T(t, 'G12'), 'Row Labels');
  assert.equal(V(t, 'H16'), TOTAL);
});

test('inserting rows on the source sheet moves the source of a pivot on another sheet', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:E13', rows: ['Region'], values: ['Sales']});
  await run(t, 'sheet.activate', {sheet: 'Sheet1'});
  await run(t, 'home.insertRows', {rows: '1:2'});
  const l = await run(t, 'pivot.list', {});
  assert.deepEqual([l[0].source, l[0].anchor], ['Sheet1!A3:E15', 'A3']);
  await run(t, 'pivot.refresh', {pivot: 'PivotTable1'});
});

test('Clear All, Clear Filters, Field Headers, Options rename, styles and Refresh from the cell', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales'], filters: ['Product']});
  await run(t, 'pivot.filter', {field: 'Product', selected: ['Apples']});
  assert.equal(T(t, 'B1'), 'Apples');
  await run(t, 'pivot.clearFilters', {});
  assert.equal(T(t, 'B1'), '(All)');
  await run(t, 'pivot.options', {name: 'Fruit sales'});
  assert.equal(pt(t).name, 'Fruit sales');
  await fails(t, 'pivot.options', {name: 'fruit SALES', pivot: 'Fruit sales'}).catch(() => null);
  await run(t, 'pivot.style', {style: 'PivotStyleMedium9'});
  assert.equal(pt(t).style, 'PivotStyleMedium9');
  const st = await t.state('pivot.style');
  assert.equal(st.value.length, 84);
  assert.equal(st.value.find(x => x.selected).id, 'PivotStyleMedium9');
  assert.equal(st.value[0].art.kind, 'pivot');
  await run(t, 'pivot.clear', {});
  assert.ok(pt(t).rows.length === 0 && pt(t).values.length === 0 && pt(t).filters.length === 0);
  assert.match(T(t, 'A3'), /choose fields/);
});

test('Use PivotTable & PivotChart in Protect Sheet: a protected sheet refuses a report change unless it is allowed', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  await run(t, 'review.protectSheet', {});
  const e = await fails(t, 'pivot.addField', {field: 'Product', area: 'columns'});
  assert.match(e.message, /protected/);
  await run(t, 'review.unprotectSheet', {});
  await run(t, 'review.protectSheet', {pivotTables: true});
  await run(t, 'pivot.addField', {field: 'Product', area: 'columns'});
  assert.equal(T(t, 'B4'), 'Apples', 'Use PivotTable & PivotChart lets the report change');
});

test('the PivotTable survives an xlsx round trip: cache, definition, fields, layout and style', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region', 'Product'], columns: [{field: 'Date', group: 'quarters'}], values: ['Sales', {field: 'Units', func: 'average'}], filters: []});
  await run(t, 'pivot.layout', {layout: 'tabular', style: 'PivotStyleLight19'});
  await run(t, 'pivot.sort', {field: 'Product', order: 'desc'});
  await run(t, 'pivot.filter', {field: 'Region', selected: ['East', 'West']});
  const content = JSON.parse(JSON.stringify(t.content));
  const bytes = await writeXlsx(content);
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  assert.ok(names.some(n => /pivotTables\/pivotTable1\.xml$/.test(n)), names.join());
  assert.ok(names.some(n => /pivotCache\/pivotCacheDefinition1\.xml$/.test(n)));
  assert.ok(names.some(n => /pivotCache\/pivotCacheRecords1\.xml$/.test(n)));
  const xml = await zip.file(names.find(n => /pivotTables\/pivotTable1\.xml$/.test(n))).async('string');
  assert.match(xml, /dataOnRows|colFields/);
  const back = (await readXlsx(bytes)).content ?? (await readXlsx(bytes));
  const rep = back.sheets.find(s => (s.pivots ?? []).length);
  assert.ok(rep, 'a pivot came back');
  const p = rep.pivots[0];
  assert.equal(p.name, 'PivotTable1');
  assert.deepEqual(p.rows.map(f => f.sourceCol), ['Region', 'Product']);
  assert.equal(p.rows[1].sort, 'desc');
  assert.deepEqual(p.columns.map(f => [f.sourceCol, f.dateGroup]), [['Date', 'quarters']]);
  assert.deepEqual(p.values.map(x => [x.sourceCol, x.func, x.name]), [['Sales', 'sum', 'Sum of Sales'], ['Units', 'average', 'Average of Units']]);
  assert.equal(p.layout, 'tabular');
  assert.equal(p.style, 'PivotStyleLight19');
  assert.deepEqual(p.filters.find(f => f.sourceCol === 'Region')?.selected?.sort(), ['East', 'West']);
  assert.equal(p.source, 'Sheet1!$A$1:$E$13');
  assert.equal(stored({content: back}, 'A1', back.sheets.indexOf(rep)) !== undefined, true);
});

test('Show Details lists the records behind a value cell on a new sheet; totals take every record; options and stale reports refuse', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales'], filters: ['Product']});
  await run(t, 'pivot.filter', {field: 'Product', selected: ['Apples', 'Pears']});
  const east = findRow(t, 'East');
  const back = () => run(t, 'selection.set', {range: 'A1', sheet: t.content.sheets[onReport(t)].name});
  const before = t.content.sheets.length;
  const r = await run(t, 'pivot.showDetails', {cell: 'B' + east});
  // East: Apples 100, Pears 120, Apples 60, Pears 75 (Plums 60 is filtered out by the report filter).
  assert.equal(r.records, 4);
  assert.equal(t.content.sheets.length, before + 1);
  const si = t.content.sheets.findIndex(s => s.name === r.sheet);
  assert.deepEqual(['A1', 'B1', 'E1'].map(a => text(t, a, si)), ['Region', 'Product', 'Sales']);
  assert.deepEqual([2, 3, 4, 5].map(n => v(t, 'E' + n, si)), [100, 120, 60, 75]);
  // The grand total cell takes every record the filter lets through.
  await back();
  const grand = findRow(t, 'Grand Total');
  assert.equal((await run(t, 'pivot.showDetails', {cell: 'B' + grand})).records, 9);
  // A label is not a value cell; the state hides the menu item there.
  await run(t, 'selection.set', {range: 'A' + east, sheet: t.content.sheets[onReport(t)].name});
  assert.equal((await t.state('pivot.showDetails', {})).hidden, true);
  await fails(t, 'pivot.showDetails', {cell: 'A' + east});
  // A report the sheet no longer matches is out of date.
  const src = t.content.sheets.findIndex(s => s.name === 'Sheet1');
  await run(t, 'cell.set', {cell: 'E2', input: '999', sheet: 'Sheet1'});
  assert.ok(src >= 0);
  await back();
  await fails(t, 'pivot.showDetails', {cell: 'B' + east});
  await run(t, 'pivot.refresh', {});
  assert.equal((await run(t, 'pivot.showDetails', {cell: 'B' + east})).records, 4);
  // Enable show details off refuses with its own message.
  await back();
  await run(t, 'pivot.options', {enableShowDetails: false});
  await fails(t, 'pivot.showDetails', {cell: 'B' + east});
});
