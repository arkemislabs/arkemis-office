// U:quill/chart: Insert › Chart and the Chart Design and Chart Format tabs, drawn by Grid's chart renderer, with the data in the chart's
// embedded sheet, and written to and read from a .docx (chart part, embedded workbook).
//
// Behaviour fidelity:
// 1. wordcraft crates/engine/src/cmd/chart.rs (insert.chart, chart.type, chart.editData, chart.title, chart.legend, chart.dataLabels),
//    crates/docx/src/chart_spec.rs (the chart part; see core/quill/lib/chart-part.mjs for where the file differs: an embedded workbook)
//    and ribbon/charts.rs. Word: Insert Chart's types, Edit Data on the chart's sheet, Quick Layouts, Chart Styles, Change Colors.
// 2. Ours: the same edits of the chart model, one undo step each; core/quill/lib/chart-draw.mjs hands the model to Grid's renderer
//    (core/grid/lib/chart-render.mjs) and the page view paints the primitives.
// 3. Proof: this file and tests/e2e/quill/chart-equation.e2e.mjs (captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {submitDialog, openDialogModel, changeDialogValues} from '../../core/kernel/dialog.mjs';
import insertChartDialog from '../../core/quill/dialogs/insertChart.mjs';
import chartTypeDialog from '../../core/quill/dialogs/chartType.mjs';
import chartDataDialog from '../../core/quill/dialogs/chartData.mjs';
import {quill} from './format-fixture.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {read as readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {chartPart, readChartSpec} from '../../core/quill/lib/chart-part.mjs';
import {parseXml} from '../../core/quill/formats/docx-read.mjs';
import {sampleChart, chartTable, chartFromTable, sanitizedChart} from '../../core/quill/model/chart.mjs';
import {chartPrims} from '../../core/quill/lib/chart-draw.mjs';
import * as P from '../../core/quill/model/para.mjs';

const items = q => layout(q.t.content, {view: 'print'}).pages.flatMap(p => p.items);
const charts = content => content.body.chunks.flat().flatMap(b => b.objects ?? []).filter(o => o.type === 'graphic' && o.graphic?.chart);
const chartOf = q => charts(q.t.content)[0]?.graphic.chart;
async function withChart(args = {type: 'column'}) {
  const q = await quill('Before\nAfter');
  q.sel(0, 6);
  await q.exec('insert.chart', args);
  return q;
}

test('insert.chart: a chart at the caret with the sample data, fitted to the text width, drawn by the chart renderer; one undo step', async () => {
  const q = await quill('Before\nAfter');
  q.sel(0, 6);
  await expectUndoRoundTrip(q.t, 'insert.chart', {type: 'columnStacked', title: 'Sales'}, after => {
    const [o] = charts(after.content);
    assert.equal(o.graphic.chart.type, 'columnStacked');
    assert.equal(o.graphic.chart.title, 'Sales');
    assert.equal(o.graphic.chart.series.length, 3);
    assert.ok(o.w > 0 && o.w <= 468 && o.h > 0);
  });
  await q.exec('insert.chart', {type: 'pie'});
  const kinds = items(q).map(i => i.kind);
  assert.ok(kinds.includes('chart'), 'the page has a chart item');
  const chart = items(q).find(i => i.kind === 'chart');
  assert.ok(chart.prims.some(p => p.t === 'wedge'), 'a pie chart is drawn as wedges');
  assert.ok(chart.prims.some(p => p.t === 'text'), 'with its legend text');
  assert.ok(kinds.includes('object'), 'and a selectable frame');
  await assert.rejects(() => q.exec('insert.chart', {type: 'nonsense'}), /unknown chart type/);
});

test('insert.chart with data: categories and series as given, gaps kept; the embedded sheet is the table', async () => {
  const q = await withChart({type: 'line', data: {categories: ['A', 'B', 'C'], series: [{name: 'x', values: [1, 2, 3]}, {name: 'y', values: [3, null, 1]}]}, legend: 'none'});
  const c = chartOf(q);
  assert.deepEqual(c.categories, ['A', 'B', 'C']);
  assert.deepEqual(c.series.map(s => s.values), [[1, 2, 3], [3, null, 1]]);
  assert.equal(c.legend, null);
  assert.deepEqual((await q.exec('chart.table')).result.rows, [['', 'x', 'y'], ['A', 1, 3], ['B', 2, null], ['C', 3, 1]]);
});

test('chart.type, chart.editData, chart.switchRowColumn change the model; the selection is the chart; one undo step each', async () => {
  const q = await withChart();
  await expectUndoRoundTrip(q.t, 'chart.type', {type: 'doughnut'}, after => assert.equal(charts(after.content)[0].graphic.chart.type, 'doughnut'));
  await expectUndoRoundTrip(q.t, 'chart.editData', {rows: [['', 'Sales', 'Costs'], ['2025', '10', '4'], ['2026', 12, ''], ['2027', '', 5]]}, after => {
    const c = charts(after.content)[0].graphic.chart;
    assert.deepEqual(c.categories, ['2025', '2026', '2027']);
    assert.deepEqual(c.series.map(s => [s.name, s.values]), [['Sales', [10, 12, null]], ['Costs', [4, null, 5]]]);
  });
  await q.exec('chart.editData', {rows: [['', 'Sales', 'Costs'], ['2025', '10', '4'], ['2026', 12, '']]});
  await expectUndoRoundTrip(q.t, 'chart.switchRowColumn', {}, after => {
    const c = charts(after.content)[0].graphic.chart;
    assert.deepEqual(c.categories, ['Sales', 'Costs']);
    assert.deepEqual(c.series.map(s => s.name), ['2025', '2026']);
  });
  assert.deepEqual(chartFromTable(sampleChart('column'), chartTable(sampleChart('column'))).series.map(s => s.values), sampleChart('column').series.map(s => s.values));
  await assert.rejects(() => q.exec('chart.editData', {}), /`data` or `rows` is required/);
});

test('Chart Design: title, legend, data labels, Add Chart Element, Quick Layout, Chart Styles, Change Colors', async () => {
  const q = await withChart();
  await q.exec('chart.title', {text: 'Revenue'});
  assert.equal(chartOf(q).title, 'Revenue');
  await q.exec('chart.title', {});
  assert.equal(chartOf(q).title, null, 'a title switches off');
  await q.exec('chart.legend', {pos: 'right'});
  assert.equal(chartOf(q).legend, 'right');
  await q.exec('chart.legend', {pos: 'none'});
  assert.equal(chartOf(q).legend, null);
  await q.exec('chart.dataLabels', {on: true});
  assert.equal(chartOf(q).dataLabels, true);
  await q.exec('chart.addElement', {element: 'axisTitles'});
  assert.deepEqual([chartOf(q).xTitle, chartOf(q).yTitle], ['Axis Title', 'Axis Title']);
  await q.exec('chart.addElement', {element: 'gridlines', on: false});
  assert.equal(chartOf(q).gridlines, false);
  const layouts = q.state('chart.quickLayout').value;
  assert.equal(layouts.length, 6);
  assert.ok(layouts.every(l => l.art?.kind === 'chart'), 'the tiles are drawn charts, never text');
  await q.exec('chart.quickLayout', {layout: 2});
  await q.exec('chart.styleGallery', {style: 5});
  assert.equal(chartOf(q).style, 5);
  const styles = q.state('chart.styleGallery').value;
  assert.equal(styles.length, 16);
  assert.equal(styles.find(s => s.selected).value, 5);
  const palettes = q.state('chart.changeColors').value;
  assert.ok(palettes.length >= 2 && palettes.every(p => p.art?.kind === 'colors'));
  await q.exec('chart.changeColors', {colors: ['#FF0000', '#00FF00']});
  assert.deepEqual(chartOf(q).series.map(s => s.color), ['#FF0000', '#00FF00', '#FF0000']);
  const red = items(q).find(i => i.kind === 'chart').prims.some(p => p.fill?.[0] === 255 && p.fill?.[1] === 0);
  assert.ok(red, 'the series colour reaches the drawing');
});

test('Chart Format: size, alt text and Arrange work on a chart', async () => {
  const q = await withChart();
  await q.exec('chart.size', {width: 300, height: 180});
  const o = charts(q.t.content)[0];
  assert.deepEqual([o.w, o.h], [300, 180]);
  assert.equal(q.state('chart.size', {width: '<pt>'}).value, 300);
  assert.equal(q.state('chart.size', {height: '<pt>'}).value, 180);
  await q.exec('chart.altText', {text: 'Quarterly sales'});
  assert.equal(charts(q.t.content)[0].alt, 'Quarterly sales');
  assert.equal(q.state('chart.altText').value, 'Quarterly sales');
  await q.exec('arrange.wrap', {wrap: 'square'});
  assert.equal(charts(q.t.content)[0].float.wrap, 'square', 'a chart can be wrapped like a picture');
  await q.exec('arrange.position', {preset: 'topRight'});
  const frame = items(q).find(i => i.kind === 'chart').rect;
  assert.ok(frame.x + frame.w <= 612 - 72 + 1 && frame.y < 120, 'moved to the top right of the margins');
  await assert.rejects(() => q.exec('chart.size', {}), /`width` or `height` is required/);
});

test('the chart commands are off unless a chart is selected', async () => {
  const q = await quill('Plain text');
  q.sel(0, 0);
  for (const id of ['chart.type', 'chart.editData', 'chart.size', 'chart.title', 'chart.quickLayout']) assert.equal(q.state(id).enabled, false, id);
  assert.equal(q.state('insert.chart').enabled, true);
});

test('Insert Chart and Change Chart Type: the list with a preview drawn by the chart renderer; OK inserts or changes', async () => {
  const q = await quill('Before');
  q.sel(0, 6);
  let v = openDialogModel(q.t.session, q.t.docId, insertChartDialog);
  assert.equal(v.type, 'Clustered Column');
  v = changeDialogValues(insertChartDialog, v, 'type', 'Doughnut');
  const view = insertChartDialog.preview(q.t.session.readContext(q.t.docId), v);
  assert.ok(view.prims.some(p => p.t === 'wedge'), 'the preview is the chart that goes in');
  await submitDialog(q.t.session, q.t.docId, insertChartDialog, {type: 'Stacked Bar'});
  assert.equal(chartOf(q).type, 'barStacked');
  const change = openDialogModel(q.t.session, q.t.docId, chartTypeDialog);
  assert.equal(change.type, 'Stacked Bar', 'Change Chart Type opens on the current type');
  await submitDialog(q.t.session, q.t.docId, chartTypeDialog, {type: 'Line with Markers'});
  assert.equal(chartOf(q).type, 'lineMarkers');
});

test('Edit Data: the embedded sheet as a grid of cells; OK writes it back', async () => {
  const q = await withChart({type: 'column', data: {categories: ['A', 'B'], series: [{name: 'x', values: [1, 2]}]}});
  const v = openDialogModel(q.t.session, q.t.docId, chartDataDialog);
  assert.deepEqual(v.rows, [['', 'x'], ['A', '1'], ['B', '2']]);
  assert.ok(chartDataDialog.validate({rows: [['']]}).length, 'a chart needs a series');
  await submitDialog(q.t.session, q.t.docId, chartDataDialog, {rows: [['', 'x', 'y'], ['A', '1', '5'], ['B', '2', '6'], ['C', '3', '7']]});
  assert.deepEqual(chartOf(q).series.map(s => s.values), [[1, 2, 3], [5, 6, 7]]);
});

test('Grid chart renderer: every type the dialog offers draws something', async () => {
  const {CHART_LIST} = await import('../../core/quill/dialogs/chartType.mjs');
  for (const [label, type] of CHART_LIST) {
    const prims = chartPrims({...sampleChart(type), title: 'T'}, 300, 190);
    assert.ok(prims.length > 3, `${label} draws`);
  }
});

// ---- .docx --------------------------------------------------------------------------------------------------

async function zipOf(q) { return JSZip.loadAsync(await writeDocx(q.t.content)); }

test('.docx write: the chart part holds the data as references into the embedded workbook with the values cached', async () => {
  const q = await withChart({type: 'columnStacked', title: 'Sales', data: {categories: ['A', 'B', 'C'], series: [{name: 'x', values: [1, 2, 3]}, {name: 'y', values: [3, null, 1]}]}});
  await q.exec('chart.changeColors', {colors: ['#C0504D']});
  const z = await zipOf(q);
  const names = Object.keys(z.files);
  for (const n of ['word/charts/chart1.xml', 'word/charts/_rels/chart1.xml.rels', 'word/embeddings/Microsoft_Excel_Sheet1.xlsx']) assert.ok(names.includes(n), n);
  const types = await z.file('[Content_Types].xml').async('string');
  assert.match(types, /\/word\/charts\/chart1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.drawingml\.chart\+xml"/);
  assert.match(types, /Extension="xlsx"/);
  const xml = await z.file('word/charts/chart1.xml').async('string');
  assert.match(xml, /<c:grouping val="stacked"\/>/);
  assert.match(xml, /<c:f>Sheet1!\$B\$2:\$B\$4<\/c:f><c:numCache>/);
  assert.match(xml, /<c:externalData r:id="rId1">/);
  assert.match(xml, /<a:srgbClr val="C0504D"\/>/);
  const doc = await z.file('word/document.xml').async('string');
  assert.match(doc, /<a:graphicData uri="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/chart"><c:chart [^>]*r:id="rId\d+"\/>/);
  assert.match(await z.file('word/_rels/document.xml.rels').async('string'), /relationships\/chart" Target="charts\/chart1\.xml"/);
  // The workbook is a workbook: Grid reads it back with the table in Sheet1.
  const book = await readXlsx(await z.file('word/embeddings/Microsoft_Excel_Sheet1.xlsx').async('uint8array'));
  const cells = book.sheets[0].blocks[0];
  assert.equal(book.sheets[0].name, 'Sheet1');
  assert.deepEqual([cells.B1.v, cells.A2.v, cells.B3.v, cells.C4.v], ['x', 'A', 2, 1]);
  assert.equal(cells.C3, undefined, 'a gap is an empty cell');
});

test('.docx read: the chart comes back as the same model (type, data, title, legend, labels, colours, axis titles, style), at its size', async () => {
  const q = await withChart({type: 'barStacked', title: 'Sales', data: {categories: ['A', 'B'], series: [{name: 'x', values: [1, 2]}, {name: 'y', values: [3, 4]}]}, legend: 'right', dataLabels: true});
  await q.exec('chart.addElement', {element: 'axisTitles'});
  await q.exec('chart.changeColors', {colors: ['#C0504D', '#9BBB59']});
  await q.exec('chart.styleGallery', {style: 4});
  await q.exec('chart.size', {width: 320, height: 200});
  await q.exec('chart.altText', {text: 'Sales by quarter'});
  const before = charts(q.t.content)[0];
  const back = await readDocx(await writeDocx(q.t.content));
  const [o] = charts(back);
  assert.ok(o, 'the chart is a chart again');
  const keep = c => ({...c, series: c.series.map(s => ({name: s.name, values: s.values, color: s.color}))});
  assert.deepEqual(keep(o.graphic.chart), keep(before.graphic.chart));
  assert.equal(o.graphic.chart.style, 4);
  assert.ok(Math.abs(o.w - 320) < 0.5 && Math.abs(o.h - 200) < 0.5);
  assert.equal(o.alt, 'Sales by quarter');
  assert.equal(items({t: {content: back}}).some(i => i.kind === 'chart'), true);
});

test('.docx read: every type Insert Chart offers survives a save and open', async () => {
  const {CHART_LIST} = await import('../../core/quill/dialogs/chartType.mjs');
  const failed = [];
  for (const [label, type] of CHART_LIST) {
    const q = await withChart({type});
    const back = await readDocx(await writeDocx(q.t.content));
    const got = charts(back)[0]?.graphic.chart;
    if (!got || got.type !== type || got.series.length !== chartOf(q).series.length) failed.push(`${label}: ${got?.type}`);
  }
  assert.deepEqual(failed, []);
});

test('.docx: a chart read from a file is written as it was until a command edits it, moves it or resizes it', async () => {
  const q = await withChart({type: 'pie'});
  const first = await writeDocx(q.t.content);
  const content = await readDocx(first);
  const [o] = charts(content);
  assert.ok(o.graphic.raw, 'kept as read');
  const second = await JSZip.loadAsync(await writeDocx(content));
  const a = await (await JSZip.loadAsync(first)).file('word/charts/chart1.xml').async('string');
  assert.equal(await second.file('word/charts/chart1.xml').async('string'), a, 'the part is the one that was read');
  // Edited here: the part is written from the model, and the kept markup is let go.
  const q2 = await quill('Before', () => content);
  q2.sel(0, 6, 7);
  await q2.exec('chart.title', {text: 'Edited'});
  assert.equal(charts(q2.t.content)[0].graphic.raw, undefined);
  const edited = await JSZip.loadAsync(await writeDocx(q2.t.content));
  assert.match(await edited.file('word/charts/chart1.xml').async('string'), /<a:t>Edited<\/a:t>/);
  // Resized: written from the model too (the frame in the part's markup would be stale).
  const q3 = await quill('Before', () => content);
  q3.sel(0, 6, 7);
  await q3.exec('chart.size', {width: 200});
  const resized = await JSZip.loadAsync(await writeDocx(q3.t.content));
  assert.match(await resized.file('word/document.xml').async('string'), /<wp:extent cx="2540000"/);
});

test('.docx: a chart whose plot the model cannot hold (bubble) stays an opaque drawing and is kept whole', async () => {
  const q = await withChart({type: 'column'});
  const z = await zipOf(q);
  let xml = await z.file('word/charts/chart1.xml').async('string');
  xml = xml.replace(/<c:barChart>[\s\S]*<\/c:barChart>/, '<c:bubble3DChart><c:varyColors val="0"/></c:bubble3DChart>');
  z.file('word/charts/chart1.xml', xml);
  const back = await readDocx(await z.generateAsync({type: 'uint8array'}));
  assert.equal(charts(back).length, 0);
  const objs = back.body.chunks.flat().flatMap(b => b.objects ?? []);
  assert.ok(objs.some(o => o.type === 'opaque' && o.drawing), 'kept whole');
  const again = await JSZip.loadAsync(await writeDocx(back));
  assert.match(await again.file('word/charts/chart1.xml').async('string'), /bubble3DChart/);
});

test('chart part: readChartSpec of a chart written by chartPart is the model; text from outside is cleaned', () => {
  const spec = sanitizedChart({...sampleChart('area'), title: 'A < B & C', categories: ['a', 'b'], series: [{name: 'n', values: [1, 2]}]});
  const {xml} = chartPart(spec, null);
  const root = parseXml(xml.replace('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n', ''));
  const back = readChartSpec(root);
  assert.equal(back.title, 'A < B & C');
  assert.equal(back.type, 'area');
  assert.deepEqual(back.series.map(s => s.values), [[1, 2]]);
  assert.equal(P.isDrawing({type: 'graphic'}), true);
});

test('PDF export draws the chart (shapes and text from the renderer\'s primitives)', async () => {
  const {exportPdf} = await import('../../core/quill/formats/pdf-write.mjs');
  const plain = await quill('Before');
  const q = await withChart({type: 'pie', title: 'Share'});
  const a = await exportPdf(plain.t.content), b = await exportPdf(q.t.content);
  assert.equal(new TextDecoder().decode(b.slice(0, 5)), '%PDF-');
  assert.ok(b.length > a.length + 500, 'the chart adds drawing operators');
});

test('a one-hue style tells its series apart: two series of Style 4 differ clearly in lightness; the style and layout tiles follow the chart type and the colour rows are grouped', async () => {
  const q = await quill('A chart.');
  q.sel(0, 0);
  await q.exec('insert.chart', {type: 'line', data: {categories: ['Q1', 'Q2'], series: [{name: 'Sales', values: [1, 2]}, {name: 'Costs', values: [2, 1]}]}});
  await q.exec('chart.styleGallery', {style: 4});
  const {paletteColorN} = await import('../../core/quill/lib/chart-draw.mjs');
  const [a, b] = [0, 1].map(i => paletteColorN('accent2', i, 2).tint);
  assert.ok(b - a > 0.8, 'dark to light across two series');
  const styles = (await q.state('chart.styleGallery', {})).value;
  assert.ok(styles.every(t => t.art.type === 'line'), 'the tiles are drawn as line charts');
  const colors = (await q.state('chart.changeColors', {})).value;
  assert.deepEqual([...new Set(colors.map(c => c.group))], ['Colorful', 'Monochromatic']);
});

test('Chart Format: Current Selection picks an element, Shape Styles and the area commands format the chart area, saved to .docx and read back; a series takes its own colour', async () => {
  const q = await quill('A chart.');
  q.sel(0, 0);
  await q.exec('insert.chart', {type: 'column', data: {categories: ['Q1', 'Q2'], series: [{name: 'Sales', values: [1, 2]}, {name: 'Costs', values: [2, 1]}]}});
  const get = () => { const found = []; const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.type === 'graphic' && v.graphic?.chart) found.push(v.graphic.chart); else Object.values(v).forEach(walk); } }; walk(q.t.content); return found[0]; };
  assert.equal((await q.exec('chart.element', {element: 'Costs'})).result.id, 'series:1');
  assert.equal((await q.state('chart.element', {})).value, 'Costs');
  await assert.rejects(() => q.exec('chart.element', {element: 'Nonsense'}), /no chart element/);
  await q.exec('chart.shapeStyle', {index: 8});
  const c = get();
  assert.match(c.areaFill, /^#[0-9A-F]{6}$/);
  assert.ok(c.areaLine && c.areaLine !== 'none');
  await q.exec('chart.areaFill', {color: 'FFF2CC'});
  await q.exec('chart.areaOutline', {color: null});
  await q.exec('chart.seriesColor', {series: 1, color: 'C00000'});
  assert.equal(get().areaFill, '#FFF2CC');
  assert.equal(get().areaLine, 'none');
  assert.equal(get().series[1].color, '#C00000');
  const back = await readDocx(await writeDocx(q.t.content));
  const found = []; const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.type === 'graphic' && v.graphic?.chart) found.push(v.graphic.chart); else Object.values(v).forEach(walk); } }; walk(back.body);
  assert.equal(found[0].areaFill, '#FFF2CC');
  assert.equal(found[0].areaLine, 'none');
  const prims = chartPrims(get(), 200, 120);
  assert.equal(prims[0].stroke, null);
  assert.deepEqual(prims[0].fill, [255, 242, 204, 255]);
  const info = (await q.exec('object.info', {})).result.object;
  assert.equal(info.chart.label, 'Costs');
  assert.equal(info.chart.series.length, 2);
});
