// U:grid/pivot: PivotTable timelines: insert over a date field, periods at each level, picking periods filters every connected PivotTable, styles, Report Connections.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: none (gridcraft has no timelines): Excel's behaviour, not checked against upstream.
// 2. Ours: insert.timeline, timeline.select, timeline.level, timeline.scroll (core/grid/commands/timeline.mjs), slicer.clear and slicer.style for timelines (commands/slicer.mjs).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run, fails, v} from './edit-helpers.mjs';
import insertTimelines from '../../core/grid/dialogs/insertTimelines.mjs';
import {timelinePeriods, timelineLayout, timelineHit, selectionLabel, periodStart, nextStart} from '../../core/grid/lib/timeline.mjs';

const SALES = [
  ['Region', 'Date', 'Sales'],
  ['East', '1/15/2026', 100], ['West', '2/10/2026', 50], ['East', '3/3/2026', 120], ['North', '4/20/2026', 30],
  ['West', '5/5/2026', 70], ['East', '6/30/2026', 60], ['North', '7/4/2027', 90], ['West', '8/8/2027', 45],
];
async function start() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: SALES});
  await run(t, 'selection.set', {range: 'A1'});
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:C9', rows: ['Region'], values: ['Sales']});
  return t;
}
const report = t => t.content.sheets.findIndex(s => (s.pivots ?? []).length);
const total = t => { const si = report(t); const sh = t.content.sheets[si]; const r = sh.pivots[0].lastRange; const last = Number(/(\d+)$/.exec(r)[1]); return v(t, `B${last}`, si); };
const tlOf = t => t.content.sheets.flatMap(s => s.slicers ?? []).find(s => s.timeline);
const ctxOf = t => t.session.readContext(t.docId);

test('a timeline is inserted over a date field of the PivotTable at the selection', async () => {
  const t = await start();
  const d = insertTimelines.init(ctxOf(t));
  assert.deepEqual([d.pivot, d.heads, d.columns], ['PivotTable1', ['Date'], ['Date']]);
  assert.deepEqual(insertTimelines.toCommand(d), {command: 'insert.timeline', params: {pivot: 'PivotTable1', column: ['Date']}});
  const r = await run(t, 'insert.timeline', {});
  const tl = tlOf(t);
  assert.equal(r.timeline, tl.id);
  assert.deepEqual([tl.field, tl.level, tl.from, tl.until, tl.style], ['Date', 'months', null, null, 'TimeSlicerStyleLight1']);
  assert.match((await fails(t, 'insert.timeline', {pivot: 'PivotTable1', column: 'Region'})).message, /not a date field/);
  assert.equal(total(t), 565);
});

test('periods run from the first date to the last at each level', async () => {
  const t = await start();
  await run(t, 'insert.timeline', {});
  const labels = () => timelinePeriods(t.content, tlOf(t)).map(p => `${p.label} ${p.group}`.trim());
  assert.equal(labels().length, 20, 'January 2026 to August 2027');
  assert.equal(labels()[0], 'JAN 2026');
  await run(t, 'timeline.level', {level: 'quarters'});
  assert.deepEqual(labels().slice(0, 2), ['Qtr 1 2026', 'Qtr 2 2026']);
  assert.equal(labels().length, 7);
  await run(t, 'timeline.level', {level: 'years'});
  assert.deepEqual(labels(), ['2026', '2027']);
  await run(t, 'timeline.level', {});
  assert.equal(tlOf(t).level, 'quarters', 'with no level it goes to the next');
  await run(t, 'timeline.level', {level: 'days'});
  assert.ok(timelinePeriods(t.content, tlOf(t)).length > 500);
  await fails(t, 'timeline.level', {level: 'weeks'});
});

test('picking periods filters the report; Shift extends; Clear shows everything; a level change keeps the period', async () => {
  const t = await start();
  await run(t, 'insert.timeline', {});
  await run(t, 'timeline.select', {index: 1});
  assert.equal(total(t), 50, 'February 2026');
  assert.deepEqual(t.content.sheets[report(t)].pivots[0].dateFilters.map(d => d.field), ['Date']);
  await run(t, 'timeline.select', {index: 3, extend: true});
  assert.equal(total(t), 50 + 120 + 30, 'February to April');
  assert.equal(selectionLabel(timelinePeriods(t.content, tlOf(t)), tlOf(t)), 'FEB 2026 - APR 2026');
  await run(t, 'timeline.level', {level: 'years'});
  assert.equal(total(t), 100 + 50 + 120 + 30 + 70 + 60, 'the period is snapped to the year 2026');
  await run(t, 'timeline.select', {index: 1});
  assert.equal(total(t), 135);
  await run(t, 'slicer.clear', {slicer: tlOf(t).id});
  assert.equal(total(t), 565);
  assert.equal(t.content.sheets[report(t)].pivots[0].dateFilters, undefined);
  assert.equal(tlOf(t).from, null);
  await run(t, 'timeline.level', {level: 'months'});
  await run(t, 'timeline.select', {from: '5/1/2026', until: '6/30/2026'});
  assert.equal(total(t), 130);
  assert.match((await fails(t, 'timeline.select', {index: 500})).message, /index/);
  assert.match((await fails(t, 'slicer.toggle', {slicer: tlOf(t).id, value: 'x'})).message, /period/);
  await run(t, 'timeline.scroll', {by: 5});
  assert.equal(tlOf(t).scroll, 5);
});

test('one timeline filters every PivotTable it is connected to; its style is a TimeSlicerStyle; the filter is saved in the PivotTable', async () => {
  const t = await start();
  await run(t, 'insert.pivotTable', {source: 'Sheet1!A1:C9', rows: ['Region'], values: ['Sales']});
  const made = await run(t, 'insert.timeline', {pivot: 'PivotTable1'});
  await run(t, 'slicer.reportConnections', {slicer: made.timeline, pivots: ['PivotTable1', 'PivotTable2']});
  await run(t, 'timeline.select', {slicer: made.timeline, index: 0});
  const all = t.content.sheets.flatMap(s => s.pivots ?? []);
  assert.deepEqual(all.map(p => (p.dateFilters ?? []).length), [1, 1]);
  await run(t, 'slicer.style', {slicer: made.timeline, style: 'TimeSlicerStyleDark2'});
  assert.equal(tlOf(t).style, 'TimeSlicerStyleDark2');
  await fails(t, 'slicer.style', {slicer: made.timeline, style: 'SlicerStyleNope'});
  const back = await readXlsx(await writeXlsx(t.content));
  const pts = (back.content ?? back).sheets.flatMap(s => s.pivots ?? []);
  assert.equal(pts[0].dateFilters.length, 1);
  assert.equal(pts[0].dateFilters[0].field, 'Date');
  assert.equal(pts[0].dateFilters[0].until - pts[0].dateFilters[0].from, 31);
});

test('the layout puts the clear button, the level button, the arrows and the period cells where a click finds them', () => {
  const rect = {x: 100, y: 50, w: 400, h: 130};
  const tl = {level: 'months', scroll: 0, from: null, until: null};
  const periods = Array.from({length: 20}, (_, i) => ({start: i, end: i + 1, label: 'P' + i, group: ''}));
  const lay = timelineLayout(rect, tl, periods, 1);
  assert.ok(lay.cells.length >= 5 && lay.cells.length < 20);
  const center = r => [r.x + r.w / 2, r.y + r.h / 2];
  assert.deepEqual(timelineHit(lay, ...center(lay.clear)), {clear: true});
  assert.deepEqual(timelineHit(lay, ...center(lay.level)), {level: true});
  assert.deepEqual(timelineHit(lay, ...center(lay.right)), {scroll: 1});
  assert.deepEqual(timelineHit(lay, ...center(lay.left)), {scroll: -1});
  assert.deepEqual(timelineHit(lay, ...center(lay.cells[2].rect)), {period: 2});
  assert.equal(timelineHit(lay, 101, 51), null);
  assert.equal(nextStart(1900, periodStart(1900, 46040.5, 'quarters'), 'quarters') - periodStart(1900, 46040.5, 'quarters'), 90);
});
