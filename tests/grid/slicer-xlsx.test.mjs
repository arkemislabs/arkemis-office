// U:grid/slicer: slicers and timelines saved in .xlsx and read back (slicer parts and caches, timeline parts and caches, the drawing frames, the extLst entries).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: none (gridcraft does not save slicers): the parts follow Excel's own structure, not checked against upstream.
// 2. Ours: core/grid/lib/xlsx-slicer.mjs through writeXlsx and readXlsx.
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run} from './edit-helpers.mjs';

const SALES = [
  ['Region', 'Date', 'Sales'],
  ['East', '1/15/2026', 100], ['West', '2/10/2026', 50], ['East', '3/3/2026', 120], ['North', '4/20/2026', 30],
  ['West', '5/5/2026', 70], ['East', '6/30/2026', 60],
];
async function start() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: SALES});
  await run(t, 'selection.set', {range: 'A1'});
  return t;
}
const files = async bytes => { const z = await JSZip.loadAsync(bytes); return {z, names: Object.keys(z.files), text: n => z.file(n).async('string')}; };
const back = async t => { const r = await readXlsx(await writeXlsx(t.content)); return r.content ?? r; };
const slicersOf = c => c.sheets.flatMap(s => s.slicers ?? []);

test('a PivotTable slicer is saved with its cache and read back with its selection, caption, style and place', async () => {
  const t = await start();
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:C7', rows: ['Region'], values: ['Sales']});
  const made = await run(t, 'insert.slicer', {column: ['Region'], at: 'F2', columns: 2});
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'East'});
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'West', multi: true});
  await run(t, 'slicer.style', {slicer: made.slicer, style: 'SlicerStyleDark4'});
  await run(t, 'slicer.set', {slicer: made.slicer, caption: 'Area'});
  const f = await files(await writeXlsx(t.content));
  for (const n of ['xl/slicers/slicer1.xml', 'xl/slicerCaches/slicerCache1.xml']) assert.ok(f.names.includes(n), n);
  const cache = await f.text('xl/slicerCaches/slicerCache1.xml');
  assert.match(cache, /name="Slicer_Region" sourceName="Region"/);
  assert.match(cache, /<pivotTable tabId="\d+" name="PivotTable1"\/>/);
  assert.match(cache, /<tabular pivotCacheId="1"><items count="3">/);
  assert.equal((cache.match(/ s="1"/g) ?? []).length, 2, 'two items are shown');
  assert.match(await f.text('xl/slicers/slicer1.xml'), /<slicer name="Area" cache="Slicer_Region" caption="Area" columnCount="2" style="SlicerStyleDark4"/);
  assert.match(await f.text('xl/workbook.xml'), /<definedName name="Slicer_Region">#N\/A<\/definedName>/);
  assert.match(await f.text('xl/workbook.xml'), /<x14:slicerCache r:id=/);
  const sheetFile = f.names.find(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n) && n.endsWith('sheet1.xml'));
  assert.match(await f.text(sheetFile), /<x14:slicer r:id=/);
  const drawing = await f.text(f.names.find(n => /^xl\/drawings\/drawing\d+\.xml$/.test(n)));
  assert.match(drawing, /sle:slicer[^>]*name="Area"/);
  assert.match(drawing, /<mc:Fallback>/);
  const c = await back(t);
  const sl = slicersOf(c);
  assert.equal(sl.length, 1);
  assert.deepEqual([sl[0].pivot, sl[0].field, sl[0].caption, sl[0].columns, sl[0].style], ['PivotTable1', 'Region', 'Area', 2, 'SlicerStyleDark4']);
  assert.deepEqual([...sl[0].selected].sort(), ['East', 'West']);
  assert.equal(sl[0].anchor.cell, 'F2');
  assert.ok(sl[0].anchor.width > 100);
  assert.ok(!(c.names ?? []).some(n => /^Slicer_/.test(n.name)), 'the cache name is not a visible name');
});

test('a slicer with every item shown is saved with no filter', async () => {
  const t = await start();
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:C7', rows: ['Region'], values: ['Sales']});
  await run(t, 'insert.slicer', {column: ['Region']});
  assert.equal(slicersOf(await back(t))[0].selected, null);
});

test('a table slicer is saved with the table and column of its cache and takes its selection from the table filter', async () => {
  const t = await start();
  await run(t, 'insert.table', {range: 'A1:C7', header: true});
  const made = await run(t, 'insert.slicer', {table: 'Table1', column: ['Region']});
  await run(t, 'slicer.toggle', {slicer: made.slicer, value: 'East'});
  const f = await files(await writeXlsx(t.content));
  const cache = await f.text('xl/slicerCaches/slicerCache1.xml');
  assert.match(cache, /x15:tableSlicerCache tableId="1" column="1"/);
  const sl = slicersOf(await back(t))[0];
  assert.deepEqual([sl.table, sl.column], ['Table1', 'Region']);
  assert.deepEqual(sl.selected, ['East']);
});

test('a timeline is saved with its cache (period and bounds) and read back with level, period and the PivotTable filter', async () => {
  const t = await start();
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:C7', rows: ['Region'], values: ['Sales']});
  const made = await run(t, 'insert.timeline', {pivot: 'PivotTable1', at: 'F2'});
  await run(t, 'timeline.select', {slicer: made.timeline, index: 1});
  await run(t, 'timeline.select', {slicer: made.timeline, index: 3, extend: true});
  await run(t, 'slicer.style', {slicer: made.timeline, style: 'TimeSlicerStyleLight3'});
  const f = await files(await writeXlsx(t.content));
  const cache = await f.text('xl/timelineCaches/timelineCache1.xml');
  assert.match(cache, /name="NativeTimeline_Date" sourceName="Date"/);
  assert.match(cache, /filterType="dateBetween"><selection startDate="2026-02-01T00:00:00" endDate="2026-04-30T00:00:00"\/><bounds startDate="2026-01-15T00:00:00" endDate="2026-06-30T00:00:00"\/>/);
  assert.match(await f.text('xl/timelines/timeline1.xml'), /<timeline name="Date" cache="NativeTimeline_Date" caption="Date" level="2"/);
  assert.match(await f.text(f.names.find(n => /^xl\/drawings\/drawing\d+\.xml$/.test(n))), /tsle:timeslicer[^>]*name="Date"/);
  assert.match(await f.text('xl/workbook.xml'), /<x15:timelineCacheRef r:id=/);
  const c = await back(t);
  const tl = slicersOf(c)[0];
  assert.equal(tl.timeline, true);
  assert.deepEqual([tl.pivot, tl.field, tl.level, tl.style, tl.anchor.cell], ['PivotTable1', 'Date', 'months', 'TimeSlicerStyleLight3', 'F2']);
  assert.equal(tl.until - tl.from, 28 + 31 + 30);
  assert.equal(c.sheets.flatMap(s => s.pivots ?? [])[0].dateFilters.length, 1);
});

test('a workbook with no slicers writes none of these parts, and a deleted PivotTable takes its slicer', async () => {
  const t = await start();
  const f = await files(await writeXlsx(t.content));
  assert.ok(!f.names.some(n => /slicer|timeline/i.test(n)));
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:C7', rows: ['Region'], values: ['Sales']});
  await run(t, 'insert.slicer', {column: ['Region']});
  await run(t, 'pivot.delete', {pivot: 'PivotTable1'});
  assert.equal(slicersOf(t.content).length, 0);
});
