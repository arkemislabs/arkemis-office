// U:grid/pivot: PivotTable Design (Style Options, Repeat All Item Labels, Blank Rows), the Active Field box, PivotTable slicers with Report
// Connections, Filter Connections and Slicer Styles.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: none of these is in gridcraft (its PivotTable style is one name; its slicers filter tables): Excel's behaviour, not checked against upstream.
// 2. Ours: pivot.rowHeaders, pivot.columnHeaders, pivot.bandedRows, pivot.bandedColumns, pivot.repeatLabels, pivot.blankRows (core/grid/commands/pivot/design.mjs),
//    pivot.fieldCaption, pivot.select body (pivot/calc.mjs), insert.slicer pivot, slicer.reportConnections, pivot.filterConnections, slicer.style (commands/slicer.mjs).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run, fails, v, text, style, selection} from './edit-helpers.mjs';
import insertSlicers from '../../core/grid/dialogs/insertSlicers.mjs';
import reportConnections from '../../core/grid/dialogs/reportConnections.mjs';
import filterConnections from '../../core/grid/dialogs/filterConnections.mjs';
import {slicerItems, slicerLook, SLICER_STYLES} from '../../core/grid/lib/slicer.mjs';

const SALES = [
  ['Region', 'Product', 'Units', 'Sales'],
  ['East', 'Apples', 10, 100], ['West', 'Apples', 5, 50], ['East', 'Pears', 8, 120], ['North', 'Pears', 2, 30],
  ['West', 'Plums', 7, 70], ['East', 'Plums', 4, 60], ['North', 'Apples', 9, 90],
];

async function sales() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: SALES});
  await run(t, 'selection.set', {range: 'A1'});
  return t;
}
const report = t => t.content.sheets.findIndex(s => (s.pivots ?? []).length);
const pt = (t, i = 0) => t.content.sheets[report(t)].pivots[i];
const T = (t, ref) => text(t, ref, report(t));
const V = (t, ref) => v(t, ref, report(t));
const S = (t, ref) => style(t, ref, report(t));
const ctxOf = t => t.session.readContext(t.docId);
async function twoLevels(extra = {}) {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region', 'Product'], values: ['Sales'], ...extra});
  await run(t, 'pivot.reportLayout', {layout: 'tabular'});
  return t;
}

test('Style Options: Column Headers off drops the header look, Row Headers off un-bolds group labels, banding shades alternate rows and columns', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region', 'Product'], columns: [], values: ['Sales', 'Units']});
  await run(t, 'pivot.reportLayout', {layout: 'outline'});
  const header = () => S(t, 'A3');
  assert.equal(header().font?.bold, true);
  assert.equal(pt(t).styleOptions, undefined, 'untouched: the defaults');
  await run(t, 'pivot.columnHeaders', {on: false});
  assert.equal(header().font?.bold ?? false, false);
  assert.equal(pt(t).styleOptions.columnHeaders, false);
  await run(t, 'pivot.columnHeaders', {});
  assert.equal(header().font?.bold, true, 'with no `on` it toggles');
  assert.equal(S(t, 'A4').font?.bold, true, 'a group label is bold');
  await run(t, 'pivot.rowHeaders', {on: false});
  assert.equal(S(t, 'A4').font?.bold ?? false, false, 'Row Headers off');
  assert.equal(S(t, 'C4').font?.bold, true, 'its values stay bold');
  await run(t, 'pivot.rowHeaders', {on: true});
  await run(t, 'pivot.bandedRows', {on: true});
  const fill = ref => S(t, ref).fill?.fg;
  assert.ok(fill('B4'), 'the first body row is shaded');
  assert.ok(!fill('B5'), 'the next is not');
  assert.ok(fill('B6'));
  await run(t, 'pivot.bandedRows', {on: false});
  assert.ok(!fill('B4'));
  await run(t, 'pivot.bandedColumns', {on: true});
  assert.ok(fill('C5') && !fill('D5'), 'every other value column is shaded');
});

test('Repeat All Item Labels writes a group\'s label on every tabular row; Do Not Repeat takes it back', async () => {
  const t = await twoLevels();
  assert.equal(T(t, 'A4'), 'East');
  assert.equal(T(t, 'A5'), '', 'normally only the first row of a group has the label');
  await run(t, 'pivot.repeatLabels', {on: true});
  assert.equal(T(t, 'A5'), 'East');
  assert.equal(T(t, 'A6'), 'East');
  assert.equal(T(t, 'B5'), 'Pears');
  await run(t, 'pivot.repeatLabels', {on: false});
  assert.equal(T(t, 'A5'), '');
  // Outline form repeats on the leaf rows (the groups stay on their own rows).
  await run(t, 'pivot.repeatLabels', {on: true});
  await run(t, 'pivot.reportLayout', {layout: 'outline'});
  assert.equal(T(t, 'A5'), 'East', 'a leaf row names the group above it');
  assert.equal(T(t, 'B5'), 'Apples');
});

test('Blank Rows puts an empty row after each outer item, in the cells and in an .xlsx round trip', async () => {
  const t = await twoLevels();
  const before = pt(t).lastRange;
  await run(t, 'pivot.blankRows', {on: true});
  assert.notEqual(pt(t).lastRange, before, 'the report is longer');
  const col = [];
  for (let r = 4; r <= 16; r++) col.push(T(t, `A${r}`) || T(t, `B${r}`));
  assert.ok(col.includes('East') && col.includes('North') && col.includes('West'));
  const rowOf = name => { for (let r = 3; r <= 20; r++) if (T(t, `A${r}`) === name) return r; return -1; };
  const gap = rowOf('North') - 1;
  assert.equal(T(t, `A${gap}`) + T(t, `B${gap}`) + T(t, `C${gap}`), '', 'an empty row ends East');
  const back = await readXlsx(await writeXlsx(t.content));
  const wb = back.content ?? back;
  const p2 = wb.sheets.flatMap(s => s.pivots ?? [])[0];
  assert.equal(p2.blankRows, true);
  await run(t, 'pivot.blankRows', {on: false});
  assert.equal(pt(t).lastRange, before);
});

test('Style Options, Repeat labels and captions come back from an .xlsx file', async () => {
  const t = await twoLevels();
  await run(t, 'pivot.bandedRows', {on: true});
  await run(t, 'pivot.columnHeaders', {on: false});
  await run(t, 'pivot.repeatLabels', {on: true});
  await run(t, 'selection.set', {range: 'A3'});
  const back = await readXlsx(await writeXlsx(t.content));
  const wb = back.content ?? back;
  const p2 = wb.sheets.flatMap(s => s.pivots ?? [])[0];
  assert.deepEqual(p2.styleOptions, {rowHeaders: true, columnHeaders: false, bandedRows: true, bandedColumns: false});
  assert.equal(p2.repeatLabels, true);
});

test('the Active Field box gives a field a caption the report shows, a value field its name', async () => {
  const t = await twoLevels();
  await run(t, 'selection.set', {range: 'A4'}); // on the Region items
  const q = ctxOf(t);
  assert.ok(q);
  assert.equal(T(t, 'A3'), 'Region');
  await run(t, 'pivot.fieldCaption', {caption: 'Area'});
  assert.equal(T(t, 'A3'), 'Area');
  assert.equal(pt(t).rows[0].caption, 'Area');
  assert.match((await fails(t, 'pivot.fieldCaption', {caption: 'Product'})).message, /already exists/);
  await run(t, 'pivot.fieldCaption', {caption: ''});
  assert.equal(T(t, 'A3'), 'Region');
  await run(t, 'selection.set', {range: 'C4'});
  await run(t, 'pivot.fieldCaption', {caption: 'Revenue'});
  assert.equal(T(t, 'C3'), 'Revenue');
  const back = await readXlsx(await writeXlsx(t.content));
  assert.ok(back);
  await run(t, 'selection.set', {range: 'B4'});
  await run(t, 'pivot.fieldCaption', {caption: 'Fruit'});
  const b2 = await readXlsx(await writeXlsx(t.content));
  const p2 = (b2.content ?? b2).sheets.flatMap(s => s.pivots ?? [])[0];
  assert.equal(p2.rows[1].caption, 'Fruit');
});

test('Select > Labels and Values is the report without its filters', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales'], filters: ['Product']});
  await run(t, 'selection.set', {range: 'A6'});
  await run(t, 'pivot.select', {part: 'body'});
  const sel = await selection(t);
  assert.match(sel.a1, /^A3:B\d+$/, 'below the filter rows');
  await run(t, 'pivot.select', {part: 'entire'});
  assert.match((await selection(t)).a1, /^A1:B\d+$/);
});

test('PivotTable slicers: tiles are the field items, a click filters the PivotTable, nothing selected shows all again', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  const d = insertSlicers.init(ctxOf(t));
  assert.equal(d.pivot, 'PivotTable1');
  assert.deepEqual(d.heads, ['Region', 'Product', 'Units', 'Sales']);
  assert.deepEqual(insertSlicers.toCommand({...d, columns: ['Product']}), {command: 'insert.slicer', params: {pivot: 'PivotTable1', column: ['Product']}});
  const made = await run(t, 'insert.slicer', {column: ['Product']});
  const si = report(t);
  const sl = () => t.content.sheets[si].slicers[0];
  assert.equal(sl().pivot, 'PivotTable1');
  assert.deepEqual(slicerItems(t.content, si, sl()).map(i => [i.value, i.on]), [['Apples', true], ['Pears', true], ['Plums', true]]);
  assert.equal(V(t, 'B7'), 520, 'the grand total of every item');
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'Pears'});
  assert.deepEqual(pt(t).filters, [{sourceCol: 'Product', selected: ['Pears']}]);
  assert.deepEqual([4, 5, 6].map(r => [T(t, `A${r}`), V(t, `B${r}`)]), [['East', 120], ['North', 30], ['Grand Total', 150]]);
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'Apples', multi: true});
  assert.deepEqual(pt(t).filters[0].selected, ['Pears', 'Apples']);
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'Apples', multi: true});
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'Pears', multi: true});
  assert.equal(sl().selected, null, 'deselecting the last tile clears the filter');
  assert.equal(V(t, 'B7'), 520);
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'Plums'});
  await run(t, 'slicer.clear', {slicer: made.slicer});
  assert.equal(V(t, 'B7'), 520);
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'Plums'});
  await run(t, 'slicer.delete', {slicer: made.slicer});
  assert.equal(V(t, 'B7'), 520, 'deleting the slicer clears its filter');
});

test('Report Connections and Filter Connections share a slicer between PivotTables; renaming and deleting follow', async () => {
  const t = await sales();
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:D8', rows: ['Region'], values: ['Sales']});
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:D8', rows: ['Product'], values: ['Units']});
  assert.equal(t.content.sheets.flatMap(s => s.pivots ?? []).length, 2);
  const sheetOf = n => t.content.sheets.findIndex(s => (s.pivots ?? []).some(p => p.name === n));
  const first = sheetOf('PivotTable1');
  const second = sheetOf('PivotTable2');
  const made = await run(t, 'insert.slicer', {pivot: 'PivotTable1', column: ['Region']});
  assert.deepEqual(t.content.sheets[first].slicers[0].pivots, ['PivotTable1']);
  const rc = reportConnections.init(ctxOf(t));
  assert.deepEqual(rc.pivots.map(p => p.name).sort(), ['PivotTable1', 'PivotTable2']);
  assert.equal(reportConnections.validate({...rc, connected: []}).length, 1);
  assert.deepEqual(reportConnections.toCommand({...rc, connected: ['PivotTable1', 'PivotTable2']}), {command: 'slicer.reportConnections', params: {slicer: made.slicer, pivots: ['PivotTable1', 'PivotTable2']}});
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'East'});
  assert.equal(t.content.sheets[second].pivots[0].filters.length, 0, 'not connected yet');
  await run(t, 'slicer.reportConnections', {slicer: made.slicer, pivots: ['PivotTable1', 'PivotTable2']});
  assert.deepEqual(t.content.sheets[second].pivots[0].filters, [{sourceCol: 'Region', selected: ['East']}], 'the connected PivotTable takes the selection');
  await run(t, 'slicer.reportConnections', {slicer: made.slicer, pivots: ['PivotTable2']});
  assert.equal(t.content.sheets[first].pivots[0].filters.length, 0, 'a dropped PivotTable loses the filter');
  assert.equal(t.content.sheets[first].slicers[0].pivot, 'PivotTable2');
  assert.match((await fails(t, 'slicer.reportConnections', {slicer: made.slicer, pivots: []})).message, /at least one/);
  // Filter Connections from the first PivotTable's side.
  await run(t, 'pivot.filterConnections', {pivot: 'PivotTable1', slicers: [made.slicer]});
  assert.deepEqual(t.content.sheets[first].slicers[0].pivots, ['PivotTable2', 'PivotTable1']);
  assert.deepEqual(t.content.sheets[first].pivots[0].filters, [{sourceCol: 'Region', selected: ['East']}]);
  // A rename follows the slicer; deleting the last PivotTable of a slicer deletes it.
  await run(t, 'pivot.options', {pivot: 'PivotTable1', name: 'Regions'});
  assert.deepEqual(t.content.sheets[first].slicers[0].pivots, ['PivotTable2', 'Regions']);
  await run(t, 'pivot.delete', {pivot: 'PivotTable2'});
  assert.deepEqual(t.content.sheets[first].slicers[0].pivots, ['Regions']);
  assert.equal(filterConnections.id, 'dialog.filterConnections');
  await run(t, 'pivot.delete', {pivot: 'Regions'});
  assert.equal((t.content.sheets[first].slicers ?? []).length, 0);
});

test('Slicer Styles: Excel\'s names, their colours, the gallery and the stored style', async () => {
  assert.equal(SLICER_STYLES.length, 14);
  assert.notEqual(slicerLook('SlicerStyleLight1').header, slicerLook('SlicerStyleLight2').header);
  assert.equal(slicerLook('nonsense').header, slicerLook('SlicerStyleLight1').header);
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region'], values: ['Sales']});
  const made = await run(t, 'insert.slicer', {column: ['Region']});
  await run(t, 'slicer.style', {slicer: made.slicer, style: 'SlicerStyleDark3'});
  assert.equal(t.content.sheets[report(t)].slicers[0].style, 'SlicerStyleDark3');
  assert.match((await fails(t, 'slicer.style', {slicer: made.slicer, style: 'Pretty'})).message, /./);
  const listed = await run(t, 'slicer.list', {});
  assert.equal(listed[0].style, 'SlicerStyleDark3');
  assert.equal(listed[0].pivot, 'PivotTable1');
});

test('+/- buttons sit on items that have another field inside; a click collapses and expands; they can be turned off and are kept in .xlsx', async () => {
  const {pivotButtons} = await import('../../core/grid/lib/pivot.mjs');
  const t = await sales();
  await run(t, 'insert.pivotTable', {rows: ['Region', 'Product'], values: ['Sales']});
  const si = report(t);
  const list = () => pivotButtons(t.content, si);
  assert.deepEqual(list().map(b => [b.label, b.collapsed]).sort(), [['East', false], ['North', false], ['West', false]], 'only the outer field has buttons');
  const east = list().find(b => b.label === 'East');
  assert.equal(T(t, `A${east.row + 1}`), 'East');
  const before = pt(t).lastRange;
  const r = await run(t, 'pivot.toggleItem', {cell: `A${east.row + 1}`});
  assert.deepEqual([r.item, r.collapsed], ['East', true]);
  assert.deepEqual(pt(t).rows[0].collapsedItems, ['East']);
  assert.notEqual(pt(t).lastRange, before, 'the report is shorter');
  assert.equal(list().find(b => b.label === 'East').collapsed, true);
  await run(t, 'pivot.toggleItem', {cell: `A${east.row + 1}`});
  assert.deepEqual(pt(t).rows[0].collapsedItems, []);
  assert.match((await fails(t, 'pivot.toggleItem', {cell: 'B6'})).message, /another field inside/);
  const on = await run(t, 'pivot.showButtons', {on: false});
  assert.equal(on.on, false);
  assert.deepEqual(list(), []);
  const back = await readXlsx(await writeXlsx(t.content));
  assert.equal((back.content ?? back).sheets.flatMap(s => s.pivots ?? [])[0].showButtons, false);
  await run(t, 'pivot.showButtons', {});
  assert.ok(list().length);
});
