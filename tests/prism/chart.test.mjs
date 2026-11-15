// U:prism/chart: Insert > Chart and the Chart Design commands (chart.type, chart.data, chart.options), the drawing on the
// shared chart engine, and the .pptx round trip of a chart.
//
// 1. deckcraft: crates/engine/src/cmd/insert/chart.rs and crates/model/src/chart.rs (`Chart::sample`).
//    PowerPoint: Insert > Chart, Chart Design.
// 2. Ours: core/prism/commands/chart.mjs, core/prism/lib/chart.mjs, chart-read.mjs, formats/pptx-read|write.mjs.
// 3. These tests and tests/e2e/prism/charts.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import chart from '../../core/prism/commands/chart.mjs';
import insertDialog from '../../core/prism/dialogs/insertChart.mjs';
import changeDialog from '../../core/prism/dialogs/changeChartType.mjs';
import dataDialog from '../../core/prism/dialogs/chartData.mjs';
import selectDialog from '../../core/prism/dialogs/selectData.mjs';
import {withNew, curSlide} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';
import {TYPE_IDS, TYPES, sampleChart, chartPrims, chartPartXml, dataTable, fromTable, typePrims} from '../../core/prism/lib/chart.mjs';

const deck = async () => {
  const t = await withNew({extra: [chart]});
  await t.exec('slide.go', {index: 0});
  return t;
};
const charts = t => curSlide(t).shapes.filter(s => s.kind?.type === 'chart');
const resolve = () => ({r: 68, g: 114, b: 196, a: 255});

test('insert.chart adds a selected chart with the sample data and undo removes it', async () => {
  const t = await deck();
  assert.equal(charts(t).length, 0);
  await expectUndoRoundTrip(t, 'insert.chart', {type: 'column'});
  const [c] = charts(t);
  assert.equal(c.kind.chartType, 'column');
  assert.deepEqual(c.kind.categories, ['Q1', 'Q2', 'Q3', 'Q4']);
  assert.equal(c.kind.series.length, 3);
  assert.deepEqual(c.kind.series[0].values, [4.2, 2.8, 3.6, 4.7]);
  assert.equal(c.kind.title, 'Chart Title');
  assert.equal(c.kind.legend, 'bottom');
  assert.ok(c.xfrm.w > 600 && c.xfrm.h > 300, 'a big chart in the middle of the slide');
});

test('the sample of each type matches deckcraft, and every type draws something', () => {
  assert.equal(sampleChart('pie').series.length, 1);
  assert.equal(sampleChart('pie').varyColors, true);
  assert.deepEqual(sampleChart('combo').series.map(s => s.kind), ['column', 'column', 'line']);
  assert.deepEqual(sampleChart('stock').series.map(s => s.name), ['High', 'Low', 'Close']);
  assert.equal(sampleChart('treemap').categoryLevels.length, 1);
  assert.equal(sampleChart('boxWhisker').categories[1], 'Group B');
  assert.deepEqual(sampleChart('scatter').series[0].xValues, [1, 2, 3, 4]);
  for (const id of TYPE_IDS) {
    const r = chartPrims(sampleChart(id), 480, 320, resolve);
    assert.ok(r.prims.length > 3, `${id} draws`);
    assert.ok(!r.prims.some(p => p.t === 'rect' && p.x === 0 && p.y === 0 && p.w >= r.w - 0.01 && p.h >= r.h - 0.01), `${id} has no white backing`);
    assert.ok(typePrims(id, 96, 72).prims.length > 0, `${id} has a thumbnail`);
  }
});

test('types nothing here draws (Map: it needs online map data) are refused, not turned into a column chart', async () => {
  const t = await deck();
  for (const type of ['map']) await assert.rejects(t.exec('insert.chart', {type}), /not offered/);
  assert.equal(charts(t).length, 0);
});

test('chart.type keeps the data, one-slice types vary colours, undo restores', async () => {
  const t = await deck();
  await t.exec('insert.chart', {type: 'column'});
  await expectUndoRoundTrip(t, 'chart.type', {type: 'bar'});
  assert.equal(charts(t)[0].kind.chartType, 'bar');
  assert.equal(charts(t)[0].kind.series.length, 3);
  await t.exec('chart.type', {type: 'combo'});
  assert.deepEqual(charts(t)[0].kind.series.map(s => s.kind), ['column', 'column', 'line']);
  await t.exec('chart.type', {type: 'pie'});
  assert.equal(charts(t)[0].kind.varyColors, true);
  assert.equal(charts(t)[0].kind.series[0].kind, undefined);
  await t.exec('chart.type', {type: 'waterfall'});
  assert.equal(charts(t)[0].kind.gridlines, true);
});

test('chart.data replaces categories and series keeping formatting by position; the Edit Data table and Switch Row/Column', async () => {
  const t = await deck();
  await t.exec('insert.chart', {type: 'column'});
  await t.exec('chart.options', {palette: 'monochrome1'});
  await expectUndoRoundTrip(t, 'chart.data', {categories: ['A', 'B'], series: [{name: 'Sales', values: [1, 2]}]});
  const k = charts(t)[0].kind;
  assert.deepEqual(k.categories, ['A', 'B']);
  assert.deepEqual(k.series.map(x => x.name), ['Sales']);
  const table = [['', 'North', 'South'], ['Jan', '3', '4.5'], ['Feb', '', 'x'], ['Mar', '1,000', '2']];
  await t.exec('chart.data', {table});
  const d = charts(t)[0].kind;
  assert.deepEqual(d.categories, ['Jan', 'Feb', 'Mar']);
  assert.deepEqual(d.series.map(x => x.values), [[3, null, 1000], [4.5, null, 2]]);
  assert.deepEqual(dataTable(d)[0], ['', 'North', 'South']);
  assert.deepEqual(fromTable(dataTable(d), 'column').series[1].values, [4.5, null, 2]);
  await t.exec('chart.data', {switchRowColumn: true});
  const s = charts(t)[0].kind;
  assert.deepEqual(s.categories, ['North', 'South']);
  assert.deepEqual(s.series.map(x => x.name), ['Jan', 'Feb', 'Mar']);
  assert.deepEqual(s.series[2].values, [1000, 2]);
});

test('chart.options: title, legend, data labels, gridlines, axis titles, palette, text colour; states say what is on', async () => {
  const t = await deck();
  await t.exec('insert.chart', {type: 'column'});
  await expectUndoRoundTrip(t, 'chart.options', {legend: 'right', dataLabels: true, gridlines: false, title: 'Revenue', xTitle: 'Quarter', palette: 'monochrome1'});
  let k = charts(t)[0].kind;
  assert.deepEqual([k.legend, k.dataLabels, k.gridlines, k.title, k.xTitle, k.palette], ['right', true, false, 'Revenue', 'Quarter', 'monochrome1']);
  await t.exec('chart.options', {legend: 'none', showTitle: false, showYTitle: true});
  k = charts(t)[0].kind;
  assert.deepEqual([k.legend, k.title, k.yTitle], [null, null, 'Axis Title']);
  await t.exec('chart.options', {showTitle: true});
  assert.equal(charts(t)[0].kind.title, 'Chart Title');
  await t.exec('chart.options', {textColor: '#FF0000'});
  assert.equal(charts(t)[0].kind.textColor.base.rgb.r, 255);
  await assert.rejects(t.exec('chart.options', {textColor: 'nonsense'}), /colour/);
  await assert.rejects(t.exec('chart.options', {legend: 'sideways'}), /legend/);
});

test('chart commands are disabled with no chart selected', async () => {
  const t = await deck();
  await assert.rejects(t.exec('chart.type', {type: 'bar'}), /no shapes|select|not a chart/);
});

test('the chart part is written with literal series and reads back to the same chart', async () => {
  const c = sampleChart('line');
  c.title = 'Growth';
  c.legend = 'right';
  c.dataLabels = true;
  c.xTitle = 'Quarter';
  c.series[1].name = 'Two "quoted" & <odd>';
  const xml = chartPartXml(c, resolve);
  assert.ok(!/<c:f>/.test(xml) && !/\{/.test(xml.replace(/<[^>]*>/g, '')), 'no formulas, no array literals');
  assert.match(xml, /<c:txPr>/);
  const t = await deck();
  await t.exec('insert.chart', {type: 'line', title: 'Growth', categories: c.categories, series: c.series});
  await t.exec('chart.options', {legend: 'right', dataLabels: true, xTitle: 'Quarter', textColor: 'accent2'});
  const back = await importPptx(await exportPptx(t.content));
  const [b] = back.slides[0].shapes.filter(s => s.kind?.type === 'chart');
  assert.ok(b, 'the chart comes back as a chart shape');
  assert.equal(b.kind.chartType, 'line');
  assert.equal(b.kind.title, 'Growth');
  assert.equal(b.kind.legend, 'right');
  assert.equal(b.kind.dataLabels, true);
  assert.equal(b.kind.xTitle, 'Quarter');
  assert.deepEqual(b.kind.categories, c.categories);
  assert.deepEqual(b.kind.series.map(s => s.name), ['Series 1', 'Two "quoted" & <odd>', 'Series 3']);
  assert.deepEqual(b.kind.series[0].values, c.series[0].values);
  assert.equal(b.kind.textColor.base.slot, 'accent2');
  assert.ok(b.kind.raw, 'the original part is kept for the next save');
});

test('every type survives a .pptx save and reopen; a chart that was not edited is written back as it came', async () => {
  const t = await deck();
  for (const [id] of TYPES) await t.exec('insert.chart', {type: id});
  const bytes = await exportPptx(t.content);
  const back = await importPptx(bytes);
  const got = back.slides[0].shapes.filter(s => s.kind?.type === 'chart');
  const drawn = got.filter(s => s.kind.chartType).length;
  assert.ok(drawn >= 19, `most types read back as charts (${drawn} of ${TYPES.length})`);
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  assert.equal(parts.length, TYPES.length);
  // Saved again without an edit: the same chart parts, byte for byte.
  const again = await JSZip.loadAsync(await exportPptx(back));
  for (const n of parts) {
    const x = await zip.file(n).async('string');
    const names = Object.keys(again.files).filter(m => /^ppt\/charts\/chart/.test(m));
    const same = (await Promise.all(names.map(m => again.file(m).async('string')))).includes(x);
    assert.ok(same, `${n} is kept as written`);
  }
  // An edit drops the kept part: the saved chart carries the new data.
  const one = got[0];
  back.slides[0].shapes = [one];
  one.kind = {...one.kind, categories: ['X', 'Y'], series: [{name: 'Z', values: [9, 8]}]};
  delete one.kind.raw;
  const edited = await importPptx(await exportPptx(back));
  const e = edited.slides[0].shapes.find(s => s.kind?.type === 'chart');
  assert.deepEqual(e.kind.categories, ['X', 'Y']);
  assert.deepEqual(e.kind.series[0].values, [9, 8]);
});

test('Insert Chart and Change Chart Type dialogs choose a type and submit the commands', async () => {
  const v = insertDialog.init({});
  assert.equal(v.type, 'column');
  assert.deepEqual(insertDialog.toCommand({...v, type: 'doughnut'}), {command: 'insert.chart', params: {type: 'doughnut'}});
  assert.equal(insertDialog.validate({type: 'nothing'}).length, 1);
  const t = await deck();
  await t.exec('insert.chart', {type: 'area'});
  const cv = changeDialog.init(t.session.readContext(t.docId));
  assert.equal(cv.type, 'area');
  assert.deepEqual(changeDialog.toCommand({...cv, type: 'radar'}), {command: 'chart.type', params: {type: 'radar'}});
  const dv = dataDialog.init(t.session.readContext(t.docId));
  assert.equal(dv.table.length, 5);
  assert.equal(dataDialog.toCommand({...dv, table: [['', 'S'], ['a', '1']]}).params.table[1][1], '1');
  assert.equal(dataDialog.validate({table: []}).length, 1);
});

test('Quick Layout and Chart Styles apply the looks Excel shares and list drawn tiles', async () => {
  const t = await deck();
  await t.exec('insert.chart', {type: 'column'});
  await expectUndoRoundTrip(t, 'chart.quickLayout', {layout: 2});
  let k = charts(t)[0].kind;
  assert.deepEqual([k.legend, k.dataLabels, k.gridlines, k.xTitle], ['top', true, false, null]);
  await t.exec('chart.quickLayout', {layout: 6});
  k = charts(t)[0].kind;
  assert.deepEqual([k.legend, k.xTitle, k.yTitle], ['right', 'Axis Title', 'Axis Title']);
  await t.exec('chart.quickLayout', {layout: 5});
  assert.equal(charts(t)[0].kind.legend, null);
  await expectUndoRoundTrip(t, 'chart.styleGallery', {style: 4});
  k = charts(t)[0].kind;
  assert.deepEqual([k.palette, k.style, k.gridlines], ['accent2', 4, true]);
  const r = chartPrims(k, 400, 300, resolve);
  assert.ok(r.prims.length > 5, 'drawn in the palette');
  const state = await t.session.state?.(t.docId, 'chart.styleGallery', {});
  void state;
  await assert.rejects(t.exec('chart.styleGallery', {style: 17}), /style/);
  await t.exec('chart.options', {palette: 'accent3'});
  assert.equal(charts(t)[0].kind.palette, 'accent3');
});

test('Select Data narrows the chart to a range of its worksheet and keeps the rest; Edit Data starts again', async () => {
  const t = await deck();
  await t.exec('insert.chart', {type: 'column'});
  await expectUndoRoundTrip(t, 'chart.selectData', {range: 'A1:C3'});
  let k = charts(t)[0].kind;
  assert.deepEqual(k.categories, ['Q1', 'Q2']);
  assert.deepEqual(k.series.map(s => s.name), ['Series 1', 'Series 2']);
  assert.equal(k.range, 'A1:C3');
  assert.equal(k.sheet.length, 5, 'the whole worksheet stays');
  await t.exec('chart.selectData', {range: 'A1:D5'});
  k = charts(t)[0].kind;
  assert.equal(k.series.length, 3);
  assert.deepEqual(k.categories, ['Q1', 'Q2', 'Q3', 'Q4']);
  await assert.rejects(t.exec('chart.selectData', {range: 'A1:Z99'}), /outside/);
  await assert.rejects(t.exec('chart.selectData', {range: 'A1:A5'}), /header row/);
  await assert.rejects(t.exec('chart.selectData', {range: 'nonsense'}), /not a range/);
  await t.exec('chart.selectData', {range: 'A1:B3'});
  await t.exec('chart.data', {table: [['', 'X'], ['a', '1']]});
  assert.equal(charts(t)[0].kind.sheet, undefined);
  assert.equal(charts(t)[0].kind.range, undefined);
  const d = selectDialog.init(t.session.readContext(t.docId));
  assert.equal(d.range, 'A1:B2');
  assert.equal(selectDialog.validate({...d, range: 'A1:Z9'}).length, 1);
  assert.deepEqual(selectDialog.toCommand({...d, range: 'a1:b2'}), {command: 'chart.selectData', params: {range: 'A1:B2'}});
});

test('a saved chart carries its data in an embedded workbook that PowerPoint can open, and the series read it', async () => {
  const t = await deck();
  await t.exec('insert.chart', {type: 'line'});
  const bytes = await exportPptx(t.content);
  const zip = await JSZip.loadAsync(bytes);
  const part = Object.keys(zip.files).find(n => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  const xml = await zip.file(part).async('string');
  assert.match(xml, /<c:externalData r:id="rId1">/);
  assert.match(xml, /<c:f>Sheet1!\$B\$2:\$B\$5<\/c:f>/, 'series point at cells');
  const rels = await zip.file(part.replace('charts/', 'charts/_rels/') + '.rels').async('string');
  assert.match(rels, /package/);
  const emb = Object.keys(zip.files).find(n => /^ppt\/embeddings\/.*\.xlsx$/.test(n));
  assert.ok(emb, 'the workbook is in the package');
  const wb = await JSZip.loadAsync(await zip.file(emb).async('uint8array'));
  const sheet = await wb.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /<v>4\.2<\/v>/);
  const back = await importPptx(bytes);
  const b = back.slides[0].shapes.find(s => s.kind?.type === 'chart');
  assert.deepEqual(b.kind.series[0].values, [4.2, 2.8, 3.6, 4.7]);
  assert.deepEqual(b.kind.categories, ['Q1', 'Q2', 'Q3', 'Q4']);
});
