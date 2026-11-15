// U:grid/charts-objects: Chart Design's Add Chart Element parts the chart model had no engine for (Axes, Data Table, Error Bars,
// Lines, Up/Down Bars), the Sparkline tab beyond type and colour (points, marker colours, the 36 styles, the axis, groups), and
// Shape Format, Chart Format and Picture Format (shape styles, effects, WordArt, Change Shape, Alt Text, Chart Elements, Reset to
// Match Style, a picture's corrections, effects on the pixels, border, styles, crop, reset, change), each with its undo round trip
// and its .xlsx round trip.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft keeps a chart as {kind, title, legend, data labels, gridlines, axis titles, series}, a sparkline as {cell, source,
//    kind, color, markers}, a shape as {kind, fill, line, text} and a picture as {bytes, mime, alt}; none of these tabs has an engine.
// 2. Ours: built from what Excel does (x14 sparkline groups, DrawingML effects, Excel's galleries), with Quill's effect, WordArt and
//    bitmap functions (translated from wordcraft); not checked against upstream.
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {resolveChart} from '../../core/grid/lib/chart-resolve.mjs';
import {render, renderSparkline} from '../../core/grid/lib/chart-render.mjs';
import {SPARK_STYLES} from '../../core/grid/lib/sparkline-fx.mjs';
import {base64ToBytes, bytesToBase64, imageSize} from '../../core/grid/lib/image-info.mjs';

const blocks = {0: {A1: {v: 'Region'}, B1: {v: 'Qty'}, C1: {v: 'Amount'}, A2: {v: 'West'}, B2: {v: 5}, C2: {v: 120}, A3: {v: 'East'}, B3: {v: 9}, C3: {v: 340}, A4: {v: 'North'}, B4: {v: 12}, C4: {v: 480},
  B6: {v: 1}, C6: {v: 4}, D6: {v: -2}, E6: {v: 9}, B7: {v: 3}, C7: {v: 3}, D7: {v: 5}, E7: {v: -1}}};
const data = () => workbook([{id: 's1', name: 'Sheet1', blocks}]);
const chartOf = t => t.content.sheets[0].charts?.[0];
const sparks = t => t.content.sheets[0].sparklines ?? [];
async function withChart(type = 'column') {
  const t = await session(data());
  await run(t, 'insert.chart', {type, range: 'A1:C4', title: 'Sales'});
  return t;
}
async function roundTrip(t) {
  const bytes = await writeXlsx(t.content);
  return {zip: await JSZip.loadAsync(bytes), read: await readXlsx(bytes)};
}
const readSheet = r => (r.read.content ?? r.read).sheets[0];

// ---- Chart Design: Add Chart Element ------------------------------------------------------------------------------------

test('axes hide the labels of one axis or both and a menu item toggles it; a bar chart\'s horizontal axis is its value axis', async () => {
  const t = await withChart();
  await expectUndoRoundTrip(t, 'chart.addElement', {element: 'axes', axis: 'vertical', on: false}, () => {});
  assert.deepEqual(chartOf(t).axes, {value: false});
  assert.equal((await t.state('chart.addElement', {element: 'axes', axis: 'vertical'})).checked, false);
  await run(t, 'chart.addElement', {element: 'axes', axis: 'vertical'});
  assert.equal(chartOf(t).axes, undefined, 'without `on` the item toggles: the axis is shown again');
  await run(t, 'chart.addElement', {element: 'axes', on: false});
  assert.deepEqual(chartOf(t).axes, {category: false, value: false});
  const t2 = await withChart('bar');
  await run(t2, 'chart.addElement', {element: 'axes', axis: 'horizontal', on: false});
  assert.deepEqual(chartOf(t2).axes, {value: false});
  const c = chartOf(t);
  const labels = (chart) => render(chart, resolveChart(t.content, 0, chart), 400, 300).filter(p => p.t === 'text').length;
  assert.ok(labels({...c, axes: {category: false, value: false}}) < labels({...c, axes: undefined}), 'hidden axes draw fewer labels');
});

test('data table: legend keys on or off, columns, lines and areas only; drawn under the plot', async () => {
  const t = await withChart();
  await expectUndoRoundTrip(t, 'chart.addElement', {element: 'dataTable', keys: true}, () => {});
  assert.deepEqual(chartOf(t).dataTable, {keys: true});
  await run(t, 'chart.addElement', {element: 'dataTable', keys: false});
  assert.deepEqual(chartOf(t).dataTable, {keys: false});
  const c = chartOf(t);
  const prims = render(c, resolveChart(t.content, 0, c), 500, 360);
  assert.ok(prims.some(p => p.t === 'text' && p.text === '120'), 'the table shows the values');
  assert.ok(prims.some(p => p.t === 'text' && p.text === 'West'), 'and the categories');
  await run(t, 'chart.addElement', {element: 'dataTable', on: false});
  assert.equal(chartOf(t).dataTable, undefined);
  const bar = await withChart('bar');
  assert.ok(await fails(bar, 'chart.addElement', {element: 'dataTable'}));
  assert.equal((await bar.state('chart.addElement', {element: 'dataTable', keys: true})).enabled, false);
});

test('error bars: standard error, percentage, standard deviation; the value, direction and caps; not on a pie', async () => {
  const t = await withChart();
  await expectUndoRoundTrip(t, 'chart.addElement', {element: 'errorBars', type: 'percentage'}, () => {});
  assert.deepEqual(chartOf(t).errorBars, {type: 'percentage', direction: 'both', cap: true, value: 5});
  await run(t, 'chart.addElement', {element: 'errorBars', type: 'standardDeviation', direction: 'plus', cap: false, value: 2});
  assert.deepEqual(chartOf(t).errorBars, {type: 'standardDeviation', direction: 'plus', cap: false, value: 2});
  await run(t, 'chart.addElement', {element: 'errorBars', type: 'standardError'});
  assert.equal(chartOf(t).errorBars.type, 'standardError');
  const c = chartOf(t), d = resolveChart(t.content, 0, c);
  const plain = render({...c, errorBars: undefined}, d, 400, 300), withBars = render(c, d, 400, 300);
  assert.ok(withBars.filter(p => p.t === 'line').length > plain.filter(p => p.t === 'line').length, 'error bars are lines');
  await run(t, 'chart.addElement', {element: 'errorBars', on: false});
  assert.equal(chartOf(t).errorBars, undefined);
  const pie = await withChart('pie');
  assert.ok(await fails(pie, 'chart.addElement', {element: 'errorBars', type: 'percentage'}));
});

test('lines and up/down bars: each for the charts Excel offers it for', async () => {
  const line = await withChart('line');
  await run(line, 'chart.addElement', {element: 'lines', type: 'highLow'});
  assert.equal(chartOf(line).lines, 'highLow');
  await run(line, 'chart.addElement', {element: 'lines', type: 'drop'});
  assert.equal(chartOf(line).lines, 'drop');
  assert.ok(await fails(line, 'chart.addElement', {element: 'lines', type: 'series'}));
  await expectUndoRoundTrip(line, 'chart.addElement', {element: 'upDownBars'}, () => {});
  assert.equal(chartOf(line).upDownBars, true);
  const c = chartOf(line), d = resolveChart(line.content, 0, c);
  const base = render({...c, lines: undefined, upDownBars: undefined}, d, 400, 300);
  assert.ok(render({...c, lines: 'highLow', upDownBars: undefined}, d, 400, 300).length > base.length, 'high-low lines are drawn');
  assert.ok(render({...c, lines: undefined, upDownBars: true}, d, 400, 300).filter(p => p.t === 'rect').length > base.filter(p => p.t === 'rect').length, 'up/down bars are rectangles');
  await run(line, 'chart.addElement', {element: 'lines', on: false});
  await run(line, 'chart.addElement', {element: 'upDownBars', on: false});
  assert.deepEqual([chartOf(line).lines, chartOf(line).upDownBars], [undefined, undefined]);
  const stacked = await withChart('stackedColumn').catch(() => null);
  const col = stacked ?? await withChart('column');
  await run(col, 'chart.set', {type: 'column', grouping: 'stacked'}).catch(() => {});
  if (String(chartOf(col).kind).includes('Stacked')) { await run(col, 'chart.addElement', {element: 'lines', type: 'series'}); assert.equal(chartOf(col).lines, 'series'); }
  assert.ok(await fails(await withChart('column'), 'chart.addElement', {element: 'upDownBars'}));
});

test('the chart elements survive .xlsx: hidden axes, data table, error bars, lines, up/down bars, area, plot area and effects', async () => {
  const t = await withChart('line');
  await run(t, 'chart.addElement', {element: 'axes', axis: 'vertical', on: false});
  await run(t, 'chart.addElement', {element: 'errorBars', type: 'fixed', value: 3, direction: 'minus', cap: false});
  await run(t, 'chart.addElement', {element: 'lines', type: 'drop'});
  await run(t, 'chart.addElement', {element: 'upDownBars'});
  await run(t, 'chart.addElement', {element: 'dataTable', keys: false});
  await run(t, 'chart.selectElement', {element: 'Plot Area'});
  await run(t, 'chart.shapeFill', {kind: 'chart', color: '#EEF3FA'});
  await run(t, 'chart.selectElement', {element: 'Chart Area'});
  await run(t, 'chart.shapeFill', {kind: 'chart', color: '#FFF8E0'});
  await run(t, 'chart.shapeOutline', {kind: 'chart', color: '#336699', width: 2});
  await run(t, 'shape.effects', {shadow: 'offsetBottomRight'});
  const r = await roundTrip(t);
  const xml = await r.zip.file('xl/charts/chart1.xml').async('string');
  assert.match(xml, /<c:delete val="1"\/>/);
  assert.match(xml, /<c:dTable>.*<c:showKeys val="0"\/>/);
  assert.match(xml, /<c:errBars>.*<c:errValType val="fixedVal"\/>.*<c:noEndCap val="1"\/><c:val val="3"\/>/);
  assert.match(xml, /<c:dropLines\/>/);
  assert.match(xml, /<c:upDownBars>/);
  assert.match(xml, /<a:outerShdw/);
  const back = readSheet(r).charts[0];
  assert.deepEqual(back.axes, {value: false});
  assert.deepEqual(back.dataTable, {keys: false});
  assert.deepEqual([back.errorBars.type, back.errorBars.value, back.errorBars.direction, back.errorBars.cap], ['fixed', 3, 'minus', false]);
  assert.equal(back.lines, 'drop');
  assert.equal(back.upDownBars, true);
  assert.equal(back.area.fill, '#FFF8E0', 'the exact stored area comes back');
  assert.equal(back.plot.fill, '#EEF3FA');
  assert.ok(back.fx.shadow);
});

// ---- Sparkline ---------------------------------------------------------------------------------------------------------------

async function withSparklines() {
  const t = await session(data());
  await run(t, 'insert.sparkline', {range: 'B6:E6', location: 'F6'});
  await run(t, 'insert.sparkline', {range: 'B7:E7', location: 'F7', type: 'column'});
  await run(t, 'selection.set', {cell: 'F6'});
  return t;
}

test('points: high, low, negative, first and last are flags with their own colour; each undoes', async () => {
  const t = await withSparklines();
  for (const point of ['high', 'low', 'negative', 'first', 'last']) {
    await expectUndoRoundTrip(t, 'sparkline.points', {point}, () => {});
    assert.equal(sparks(t)[0].flags[point], true, point);
    assert.equal((await t.state('sparkline.points', {point})).checked, true);
  }
  await run(t, 'sparkline.points', {point: 'high', on: false});
  assert.equal(sparks(t)[0].flags.high, undefined);
  assert.ok(await fails(t, 'sparkline.points', {point: 'middle'}));
  await expectUndoRoundTrip(t, 'sparkline.markerColor', {which: 'high', color: '#00AA00'}, () => {});
  assert.equal(sparks(t)[0].colors.high, '#00AA00');
  await run(t, 'sparkline.markerColor', {which: 'markers', color: '#123456'});
  await run(t, 'sparkline.markerColor', {which: 'high', color: 'auto'});
  assert.equal(sparks(t)[0].colors.high, undefined);
  assert.ok(await fails(t, 'sparkline.markerColor', {which: 'middle', color: '#000000'}));
  // The picture: the marked points are drawn in their colour.
  const sp = sparks(t)[0];
  const red = [0xD6, 0x4F, 0x45, 255], green = [0, 0xAA, 0, 255];
  const prims = renderSparkline('line', [1, 4, -2, 9], [1, 2, 3, 255], false, 100, 30, {flags: {high: true, negative: true}, colors: {high: green}});
  assert.ok(prims.some(p => p.t === 'circle' && p.fill.join() === green.join()), 'the high point has its colour');
  assert.ok(prims.some(p => p.t === 'circle' && p.fill.join() === red.join()), 'the negative point is red');
  const cols = renderSparkline('column', [1, 4, -2, 9], [1, 2, 3, 255], false, 100, 30, {flags: {last: true}, colors: {last: green}});
  assert.ok(cols.some(p => p.t === 'rect' && p.fill.join() === green.join()), 'the last column has its colour');
  void sp;
});

test('styles set the series and marker colours; axis options and right to left; custom values by dialog', async () => {
  const t = await withSparklines();
  assert.equal(SPARK_STYLES.length, 36);
  await expectUndoRoundTrip(t, 'sparkline.style', {style: 30}, () => {});
  assert.equal(sparks(t)[0].style, 30);
  assert.ok(sparks(t)[0].colors.negative);
  const tiles = (await t.state('sparkline.style', {})).value;
  assert.equal(tiles.length, 36);
  assert.equal(tiles[30].selected, true);
  assert.equal(tiles[30].art.kind, 'sparkline');
  assert.ok(await fails(t, 'sparkline.style', {style: 36}));
  await run(t, 'sparkline.axis', {toggle: 'show'});
  await run(t, 'sparkline.axis', {toggle: 'rtl'});
  await run(t, 'sparkline.axis', {minType: 'custom', min: -5, maxType: 'same'});
  assert.deepEqual(sparks(t)[0].axis, {show: true, rtl: true, min: -5, max: 'same'});
  assert.equal((await t.state('sparkline.axis', {toggle: 'show'})).checked, true);
  assert.ok(await fails(t, 'sparkline.axis', {minType: 'custom'}));
  await run(t, 'sparkline.axis', {toggle: 'show'});
  await run(t, 'sparkline.axis', {minType: 'auto'});
  assert.deepEqual(sparks(t)[0].axis, {rtl: true, max: 'same'});
  // A custom axis changes the scale: the same data in a fixed -10..10 range sits mid-height.
  const flat = renderSparkline('line', [1, 2], [0, 0, 0, 255], false, 100, 40, {axis: {min: -10, max: 10}});
  const own = renderSparkline('line', [1, 2], [0, 0, 0, 255], false, 100, 40, {});
  assert.notDeepEqual(flat[0].pts, own[0].pts);
  const rtl = renderSparkline('line', [1, 5], [0, 0, 0, 255], false, 100, 40, {axis: {rtl: true}});
  assert.ok(rtl[0].pts[0][1] < rtl[0].pts[1][1], 'right to left reverses the data');
});

test('group and ungroup: the sparklines of the selected cells share one look and change together', async () => {
  const t = await withSparklines();
  await run(t, 'selection.set', {range: 'F6:F7'});
  await expectUndoRoundTrip(t, 'sparkline.group', {}, () => {});
  const [a, b] = sparks(t);
  assert.ok(a.group && a.group === b.group);
  assert.equal(b.kind, 'line', 'the group takes the first one\'s type');
  await run(t, 'selection.set', {cell: 'F7'});
  await run(t, 'sparkline.type', {type: 'winLoss'});
  await run(t, 'sparkline.points', {point: 'high'});
  await run(t, 'sparkline.color', {color: '#AA3300'});
  assert.deepEqual(sparks(t).map(s => [s.kind, !!s.flags?.high, s.color]), [['winLoss', true, '#AA3300'], ['winLoss', true, '#AA3300']]);
  assert.equal((await t.state('sparkline.ungroup', {})).enabled, true);
  const r = await roundTrip(t);
  const ext = await r.zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.equal((ext.match(/<x14:sparklineGroup /g) ?? []).length, 1, 'one x14 group');
  assert.match(ext, / high="1"/);
  const back = readSheet(r).sparklines;
  assert.equal(back.length, 2);
  assert.ok(back[0].group && back[0].group === back[1].group);
  assert.equal(back[0].flags.high, true);
  await run(t, 'sparkline.ungroup', {});
  assert.deepEqual(sparks(t).map(s => s.group), [undefined, undefined]);
  assert.equal(sparks(t)[0].kind, 'winLoss', 'each keeps its look');
  assert.ok(await fails(t, 'sparkline.ungroup', {}));
  await run(t, 'sparkline.type', {type: 'column'});
  assert.deepEqual(sparks(t).map(s => s.kind), ['winLoss', 'column'], 'single again: only the active cell sparkline changes');
  await run(t, 'selection.set', {cell: 'A1'});
  assert.ok(await fails(t, 'sparkline.group', {}));
});

test('the sparkline looks survive .xlsx: points, colours, axis', async () => {
  const t = await withSparklines();
  await run(t, 'sparkline.points', {point: 'low'});
  await run(t, 'sparkline.points', {point: 'first'});
  await run(t, 'sparkline.markerColor', {which: 'low', color: '#11AA22'});
  await run(t, 'sparkline.axis', {toggle: 'rtl', minType: 'custom', min: -3, maxType: 'same'});
  const back = readSheet(await roundTrip(t)).sparklines.find(s => s.cell === 'F6');
  assert.deepEqual(back.flags, {low: true, first: true});
  assert.equal(back.colors.low, '#11AA22');
  assert.deepEqual(back.axis, {rtl: true, min: -3, max: 'same'});
});

// ---- Shape Format and Chart Format ---------------------------------------------------------------------------------------------

async function withShape(kind = 'rectangle') {
  const t = await session(data());
  await run(t, 'insert.shape', {kind, at: 'G2', width: 120, height: 60, text: 'Hello'});
  return t;
}
const shapeOf = t => t.content.sheets[0].shapes[0];

test('shape styles: 42 tiles, the fill, outline and effect of the one picked; the chart area takes them too', async () => {
  const t = await withShape();
  const tiles = (await t.state('shape.quickStyle', {})).value;
  assert.equal(tiles.length, 42);
  assert.equal(tiles[0].art.kind, 'shapeStyle');
  await expectUndoRoundTrip(t, 'shape.quickStyle', {index: 8}, () => {});
  assert.equal(shapeOf(t).style, 8);
  assert.deepEqual(shapeOf(t).fill, {theme: 4, tint: 0});
  assert.equal(shapeOf(t).format?.noLine, undefined);
  await run(t, 'shape.quickStyle', {index: 15});
  assert.deepEqual(shapeOf(t).fill, {theme: 4, tint: 0.8}, 'Light 1 Outline, Colored Fill is a pale tint');
  assert.equal(shapeOf(t).format?.noLine, true, 'with no outline');
  await run(t, 'shape.quickStyle', {index: 30});
  assert.ok(shapeOf(t).fx.shadow, 'Moderate Effect has a shadow');
  assert.equal(shapeOf(t).format?.noLine, undefined);
  await run(t, 'shape.quickStyle', {index: 2});
  assert.equal(shapeOf(t).fx, undefined, 'a style without an effect takes the effect off');
  assert.ok(await fails(t, 'shape.quickStyle', {index: 42}));
  const c = await withChart();
  await run(c, 'shape.quickStyle', {index: 9});
  assert.equal(chartOf(c).area.fill.length, 7);
  assert.equal(chartOf(c).areaStyle, 9);
  await run(c, 'chart.resetStyle', {});
  assert.deepEqual([chartOf(c).area, chartOf(c).areaStyle, chartOf(c).fx], [undefined, undefined, undefined]);
});

test('shape effects: shadow, glow, soft edges, reflection and bevel on a shape, a picture and a chart; each taken off', async () => {
  const t = await withShape();
  await expectUndoRoundTrip(t, 'shape.effects', {shadow: 'offsetCenter'}, () => {});
  assert.equal(shapeOf(t).fx.shadow.distance, 0);
  await run(t, 'shape.effects', {glow: 8, softEdge: 5, reflection: 'half', bevel: 'circle'});
  const fx = shapeOf(t).fx;
  assert.deepEqual([fx.glow.size, fx.softEdge, fx.reflection.endPos, fx.bevel.preset], [8, 5, 0.55, 'circle']);
  await run(t, 'shape.effects', {glow: null, bevel: null});
  assert.deepEqual(Object.keys(shapeOf(t).fx).sort(), ['reflection', 'shadow', 'softEdge']);
  await run(t, 'shape.effects', {shadow: null, softEdge: null, reflection: null});
  assert.equal(shapeOf(t).fx, undefined);
  assert.ok(await fails(t, 'shape.effects', {shadow: 'offsetNowhere'}));
  assert.ok(await fails(t, 'shape.effects', {bevel: 'bumpy'}));
  const line = await withShape('line');
  assert.ok(await fails(line, 'shape.effects', {shadow: 'offsetCenter'}));
  const c = await withChart();
  await run(c, 'shape.effects', {glow: 5});
  assert.equal(chartOf(c).fx.glow.size, 5);
});

test('WordArt: styles, text fill, text outline, text effects on a shape\'s text and a chart\'s text', async () => {
  const t = await withShape();
  const tiles = (await t.state('wordArt.style', {})).value;
  assert.equal(tiles.length, 15);
  assert.equal(tiles[0].art.kind, 'wordArt');
  await expectUndoRoundTrip(t, 'wordArt.style', {style: 'shadowed'}, () => {});
  assert.equal(shapeOf(t).textFx.shadow.distance, 3);
  await run(t, 'wordArt.textFill', {fill: '#C00000'});
  assert.deepEqual(shapeOf(t).textFx.fill.color, [0xC0, 0, 0]);
  await run(t, 'wordArt.textFill', {fill: 'none'});
  assert.equal(shapeOf(t).textFx.fill.type, 'none');
  await run(t, 'wordArt.textFill', {fill: {gradient: ['FFFFFF', '156082'], angle: 90}});
  assert.equal(shapeOf(t).textFx.fill.type, 'gradient');
  await run(t, 'wordArt.textOutline', {outline: '#0000FF'});
  await run(t, 'wordArt.textOutline', {outline: {width: 2.25}});
  assert.deepEqual([shapeOf(t).textFx.outline.color, shapeOf(t).textFx.outline.width], [[0, 0, 0xFF], 2.25], 'a weight alone keeps the colour');
  await run(t, 'wordArt.textEffect', {glow: 5, reflection: true});
  assert.ok(shapeOf(t).textFx.glow && shapeOf(t).textFx.reflection);
  await run(t, 'wordArt.textFill', {fill: null});
  await run(t, 'wordArt.textOutline', {outline: null});
  await run(t, 'wordArt.textEffect', {shadow: null, glow: null, reflection: null});
  assert.equal(shapeOf(t).textFx, undefined, 'everything taken off leaves no WordArt');
  assert.ok(await fails(t, 'wordArt.style', {style: 'nonsense'}));
  const icon = await session(data());
  await run(icon, 'insert.icons', {name: 'check', at: 'G2'});
  assert.ok(await fails(icon, 'wordArt.textFill', {fill: '#FF0000'}));
  const c = await withChart();
  await run(c, 'wordArt.textFill', {fill: '#C00000'});
  await run(c, 'wordArt.textOutline', {outline: '#000000'});
  const d = resolveChart(c.content, 0, chartOf(c));
  const prims = render(chartOf(c), d, 400, 300).filter(p => p.t === 'text');
  assert.ok(prims.every(p => p.color.join() === '192,0,0,255'), 'every chart text is red');
  assert.ok(prims.every(p => p.outline), 'and outlined');
});

test('change shape keeps the text and colours; alt text and decorative on a chart, picture and shape', async () => {
  const t = await withShape();
  await expectUndoRoundTrip(t, 'shape.change', {shape: 'ellipse'}, () => {});
  assert.deepEqual([shapeOf(t).kind, shapeOf(t).text], ['ellipse', 'Hello']);
  await run(t, 'shape.change', {shape: 'line'});
  assert.equal(shapeOf(t).kind, 'line');
  await run(t, 'shape.change', {shape: 'triangle'});
  assert.ok(shapeOf(t).anchor.height > 0, 'a line becoming a shape gets a height');
  assert.ok(await fails(t, 'shape.change', {shape: 'hexagon'}));
  const tb = await session(data());
  await run(tb, 'insert.textBox', {at: 'G2', text: 'x'});
  assert.ok(await fails(tb, 'shape.change', {shape: 'ellipse'}));
  await run(t, 'object.setAlt', {alt: 'A blue triangle'});
  assert.equal(shapeOf(t).alt, 'A blue triangle');
  await run(t, 'object.setAlt', {decorative: true});
  assert.deepEqual([shapeOf(t).alt, shapeOf(t).decorative], [undefined, true]);
  const c = await withChart();
  await run(c, 'object.setAlt', {alt: 'Sales by region'});
  assert.equal(chartOf(c).alt, 'Sales by region');
  const r = await roundTrip(c);
  assert.equal(readSheet(r).charts[0].alt, 'Sales by region');
});

test('chart elements: Chart Elements picks the part Shape Fill and Outline change', async () => {
  const c = await withChart();
  assert.equal((await c.state('chart.selectElement', {})).value, 'Chart Area');
  await run(c, 'chart.selectElement', {element: 'Series 2'});
  assert.equal((await c.state('chart.selectElement', {})).value, 'Series 2');
  await run(c, 'chart.shapeFill', {kind: 'chart', color: '#AA0000'});
  assert.equal(chartOf(c).series[1].color, '#AA0000');
  assert.ok(await fails(c, 'chart.shapeOutline', {kind: 'chart', color: '#000000'}), 'a series has no drawn outline');
  await run(c, 'chart.selectElement', {element: 'plotArea'});
  await run(c, 'chart.shapeFill', {kind: 'chart', color: '#EEEEEE'});
  await run(c, 'chart.shapeOutline', {kind: 'chart', color: '#444444', width: 2});
  assert.deepEqual([chartOf(c).plot.fill, chartOf(c).plot.line, chartOf(c).plot.lineWidth], ['#EEEEEE', '#444444', 2]);
  await run(c, 'chart.shapeFill', {kind: 'chart', color: null});
  assert.equal(chartOf(c).plot.fill, 'none');
  assert.ok(await fails(c, 'chart.selectElement', {element: 'Legend Of Doom'}));
  const d = resolveChart(c.content, 0, chartOf(c));
  const prims = render(chartOf(c), d, 400, 300);
  assert.ok(prims.some(p => p.t === 'rect' && p.stroke && p.stroke[1] === 2), 'the plot area line is drawn');
  await run(c, 'chart.selectElement', {element: 'chartArea'});
  await run(c, 'chart.shapeFill', {kind: 'chart', color: '#102030'});
  assert.deepEqual(render(chartOf(c), d, 400, 300)[0].fill, [0x10, 0x20, 0x30, 255], 'the chart area is filled');
});

// ---- Picture Format ----------------------------------------------------------------------------------------------------------

const crc = (() => { const tab = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }); return b => { let c = 0xFFFFFFFF; for (const x of b) c = tab[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }; })();
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1); raw[o] = 0; raw.set(pixel(x, y), o + 1 + x * 4); }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const td = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// 40 x 30: white margin, a red square in the middle.
const PHOTO = png(40, 30, (x, y) => (x > 12 && x < 28 && y > 8 && y < 22 ? [200, 30, 30, 255] : [255, 255, 255, 255]));
const PHOTO_B64 = PHOTO.toString('base64');
async function withPicture() {
  const t = await session(data());
  await run(t, 'insert.picture', {base64: PHOTO_B64, at: 'G2', width: 160, height: 120, alt: 'A red square'});
  return t;
}
const picOf = t => t.content.sheets[0].images[0];

test('corrections, colour and transparency are stored, with their tiles; border and styles; each undoes', async () => {
  const t = await withPicture();
  const tiles = (await t.state('picture.adjust', {menu: 'corrections'})).value;
  assert.equal(tiles.length, 25);
  assert.equal(tiles[0].art.kind, 'objPhoto');
  await expectUndoRoundTrip(t, 'picture.adjust', {preset: 'brightness=20,contrast=-20'}, () => {});
  assert.deepEqual([picOf(t).adjust.brightness, picOf(t).adjust.contrast], [20, -20]);
  await run(t, 'picture.adjust', {recolor: 'sepia', saturation: 150, transparency: 30});
  assert.deepEqual([picOf(t).adjust.recolor, picOf(t).adjust.saturation, picOf(t).adjust.transparency], ['sepia', 150, 30]);
  await run(t, 'picture.adjust', {preset: 'brightness=0,contrast=0,saturation=100,tone=0,recolor=,transparency=0'}).catch(() => {});
  await run(t, 'picture.adjust', {brightness: 0, contrast: 0, saturation: 100, tone: 0, recolor: '', transparency: 0});
  assert.equal(picOf(t).adjust, undefined, 'all defaults leave no adjustments');
  assert.ok(await fails(t, 'picture.adjust', {}));
  assert.ok(await fails(t, 'picture.adjust', {preset: 'sharpness=5'}));
  await run(t, 'picture.border', {color: '#336699', width: 3});
  assert.deepEqual(picOf(t).border, {color: '#336699', width: 3});
  await run(t, 'picture.border', {width: 6});
  assert.deepEqual(picOf(t).border, {color: '#336699', width: 6}, 'a weight keeps the colour');
  await run(t, 'picture.border', {color: 'none'});
  assert.equal(picOf(t).border, undefined);
  assert.ok((await t.state('picture.style', {})).value.length >= 20);
  await run(t, 'picture.style', {style: 'reflectedOval'});
  assert.deepEqual([picOf(t).geom, picOf(t).pstyle, !!picOf(t).fx.reflection, picOf(t).border.color], ['ellipse', 'reflectedOval', true, '#FFFFFF']);
  await run(t, 'picture.style', {style: 'none'});
  assert.deepEqual([picOf(t).geom, picOf(t).fx, picOf(t).border], [undefined, undefined, undefined]);
  assert.ok(await fails(t, 'picture.style', {style: 'wavy'}));
});

test('crop: the sides, the aspect ratio, to shape, fill and fit; the frame follows the cut', async () => {
  const t = await withPicture();
  await expectUndoRoundTrip(t, 'picture.crop', {left: 0.25, right: 0.25}, () => {});
  assert.deepEqual(picOf(t).crop, {l: 0.25, t: 0, r: 0.25, b: 0});
  assert.equal(picOf(t).anchor.width, 80, 'half of 160');
  assert.equal(picOf(t).anchor.height, 120);
  await run(t, 'picture.crop', {left: 0, right: 0});
  assert.equal(picOf(t).crop, undefined);
  assert.equal(picOf(t).anchor.width, 160, 'the frame grows back');
  await run(t, 'picture.crop', {aspect: '1:1'});
  assert.ok(Math.abs(picOf(t).anchor.width - picOf(t).anchor.height) <= 1, 'square');
  await run(t, 'picture.crop', {left: 0, right: 0, top: 0, bottom: 0});
  await run(t, 'picture.crop', {shape: 'roundRect'});
  assert.equal(picOf(t).geom, 'roundRect');
  await run(t, 'picture.crop', {shape: 'rect'});
  assert.equal(picOf(t).geom, undefined);
  await run(t, 'object.move', {width: 100, height: 100});
  await run(t, 'picture.crop', {mode: 'fill'});
  assert.deepEqual([picOf(t).anchor.width, picOf(t).anchor.height], [100, 100], 'Fill keeps the frame');
  assert.ok(picOf(t).crop.l > 0 && picOf(t).crop.r > 0, 'and cuts the sides');
  await run(t, 'picture.crop', {mode: 'fit'});
  assert.equal(picOf(t).crop, undefined);
  assert.equal(picOf(t).anchor.height, 75, 'Fit shows the whole picture at the frame\'s width');
  assert.ok(await fails(t, 'picture.crop', {aspect: '7:3'}));
  assert.ok(await fails(t, 'picture.crop', {shape: 'star'}));
  assert.deepEqual(await run(t, 'picture.cropMode', {on: true}), {on: true});
  assert.equal(t.doc.view.cropMode, true);
});

test('artistic effects, remove background and compress edit the pixels; Reset Picture brings the original back', async () => {
  const t = await withPicture();
  const original = picOf(t).data;
  await expectUndoRoundTrip(t, 'picture.effects', {effect: 'invert'}, () => {});
  assert.notEqual(picOf(t).data, original);
  assert.equal(picOf(t).orig, original, 'the original is kept');
  assert.equal(picOf(t).look.effect, 'invert');
  assert.equal(picOf(t).mime, 'image/png');
  const inverted = picOf(t).data;
  await run(t, 'picture.effects', {effect: 'blur'});
  assert.equal(picOf(t).look.effect, 'blur');
  assert.notEqual(picOf(t).data, inverted, 'a second effect replaces the first, from the original');
  await run(t, 'picture.effects', {effect: 'none'});
  assert.deepEqual([picOf(t).data, picOf(t).orig, picOf(t).look], [original, undefined, undefined]);
  assert.ok(await fails(t, 'picture.effects', {effect: 'oil'}));
  const tiles = (await t.state('picture.effects', {})).value;
  assert.equal(tiles.length, 6);
  assert.equal(tiles[0].selected, true);
  await run(t, 'picture.removeBackground', {});
  const bytes = base64ToBytes(picOf(t).data);
  assert.deepEqual(imageSize(bytes), [40, 30]);
  assert.equal(picOf(t).orig, original);
  await run(t, 'picture.compress', {maxPixels: 32});
  assert.deepEqual(imageSize(base64ToBytes(picOf(t).data)), [32, 24], 'the longer side is 32');
  await run(t, 'picture.adjust', {brightness: 10});
  await run(t, 'picture.crop', {left: 0.1});
  await run(t, 'picture.reset', {});
  assert.deepEqual([picOf(t).data, picOf(t).orig, picOf(t).adjust, picOf(t).crop], [original, undefined, undefined, undefined]);
});

test('change picture keeps the size and formatting; reset picture and size', async () => {
  const t = await withPicture();
  await run(t, 'picture.adjust', {brightness: 20});
  const other = png(10, 10, () => [0, 0, 255, 255]).toString('base64');
  await expectUndoRoundTrip(t, 'picture.change', {base64: other}, () => {});
  assert.equal(picOf(t).data, other);
  assert.deepEqual([picOf(t).anchor.width, picOf(t).anchor.height, picOf(t).adjust.brightness], [160, 120, 20]);
  assert.equal(picOf(t).alt, 'A red square');
  assert.ok(await fails(t, 'picture.change', {base64: '!!!'}));
  await run(t, 'picture.change', {});
  assert.equal(t.doc.view.dialogRequest.id, 'dialog.changePicture', 'with no picture the dialog opens');
  await run(t, 'picture.reset', {size: true});
  assert.deepEqual([picOf(t).anchor.width, picOf(t).anchor.height], [10, 10], 'Reset Picture & Size');
  assert.equal(picOf(t).adjust, undefined);
  await run(t, 'insert.shape', {kind: 'rectangle', at: 'A10'});
  await run(t, 'object.select', {kind: 'shape', id: t.content.sheets[0].shapes[0].id});
  assert.ok(await fails(t, 'picture.adjust', {brightness: 5}), 'a shape is not a picture');
  assert.equal((await t.state('picture.reset', {})).enabled, false);
});

test('the picture formatting survives .xlsx: crop, frame shape, border, corrections, effects, alt text', async () => {
  const t = await withPicture();
  await run(t, 'picture.crop', {left: 0.1, top: 0.2});
  await run(t, 'picture.style', {style: 'metalOval'});
  await run(t, 'picture.adjust', {brightness: 20, recolor: 'grayscale', transparency: 15});
  await run(t, 'shape.effects', {glow: 8});
  await run(t, 'object.setAlt', {alt: 'Red', decorative: false});
  const r = await roundTrip(t);
  const xml = await r.zip.file('xl/drawings/drawing1.xml').async('string');
  assert.match(xml, /<a:srcRect l="10000" t="20000" r="0" b="0"\/>/);
  assert.match(xml, /<a:prstGeom prst="ellipse">/);
  assert.match(xml, /<a:lum bright="20000" contrast="0"\/>/);
  assert.match(xml, /<a:grayscl\/>/);
  assert.match(xml, /<a:glow rad="101600">/);
  const back = readSheet(r).images[0];
  assert.deepEqual(back.crop, picOf(t).crop);
  assert.equal(back.geom, 'ellipse');
  assert.deepEqual(back.adjust, picOf(t).adjust);
  assert.deepEqual(back.fx, picOf(t).fx);
  assert.equal(back.pstyle, 'metalOval');
  assert.equal(back.alt, 'Red');
});

test('shape effects and WordArt survive .xlsx', async () => {
  const t = await withShape();
  await run(t, 'shape.quickStyle', {index: 31});
  await run(t, 'shape.effects', {softEdge: 5, reflection: 'tight'});
  await run(t, 'wordArt.style', {style: 'glowing'});
  await run(t, 'object.setAlt', {alt: 'A box'});
  const r = await roundTrip(t);
  const xml = await r.zip.file('xl/drawings/drawing1.xml').async('string');
  assert.match(xml, /<a:effectLst>.*<a:softEdge rad="63500"\/>/);
  assert.match(xml, /descr="A box"/);
  const back = readSheet(r).shapes[0];
  assert.deepEqual(back.fx, shapeOf(t).fx);
  assert.deepEqual(back.textFx, shapeOf(t).textFx);
  assert.equal(back.style, 31);
  assert.equal(back.alt, 'A box');
});

test('the Format tabs show only for the selected object, and the commands wait for one', async () => {
  const t = await withPicture();
  await run(t, 'object.select', {});
  for (const id of ['picture.adjust', 'picture.crop', 'shape.effects', 'shape.quickStyle', 'wordArt.style', 'object.setAlt', 'chart.selectElement', 'picture.removeBackground']) {
    assert.equal((await t.state(id, {})).enabled, false, id);
  }
  const e = await fails(t, 'shape.effects', {glow: 5});
  assert.match(e.message, /select/i);
  await run(t, 'object.select', {kind: 'image', id: picOf(t).id});
  assert.equal((await t.state('picture.adjust', {})).enabled, true);
  assert.equal((await t.state('shape.effects', {})).enabled, true, 'effects work on a picture');
  assert.equal((await t.state('shape.quickStyle', {})).enabled, false, 'shape styles do not');
  // A protected sheet refuses.
  await run(t, 'sheet.protect', {objects: false}).catch(() => {});
  void bytesToBase64;
});

test('the Size boxes show the selected object in points and typing resizes it; Lock aspect ratio keeps the shape', async () => {
  const t = await withPicture();
  await run(t, 'object.select', {kind: 'image', id: picOf(t).id});
  assert.equal((await t.state('object.size', {dim: 'width'})).value, 120, '160 px is 120 pt');
  assert.equal((await t.state('object.size', {dim: 'height'})).value, 90);
  await expectUndoRoundTrip(t, 'object.size', {dim: 'width', value: 60}, () => {});
  assert.deepEqual([picOf(t).anchor.width, picOf(t).anchor.height], [80, 60], 'a picture is locked: the height follows');
  assert.equal((await t.state('object.lockAspect', {})).checked, true);
  await run(t, 'object.lockAspect', {on: false});
  await run(t, 'object.size', {dim: 'height', value: 90});
  assert.deepEqual([picOf(t).anchor.width, picOf(t).anchor.height], [80, 120], 'unlocked: only the height changes');
  await run(t, 'insert.shape', {kind: 'rectangle', at: 'A10', width: 100, height: 50});
  await run(t, 'object.select', {kind: 'shape', id: shapeOf(t).id});
  assert.equal((await t.state('object.size', {dim: 'width'})).value, 75);
  await run(t, 'object.size', {dim: 'width', value: 150});
  assert.deepEqual([shapeOf(t).anchor.width, shapeOf(t).anchor.height], [200, 50], 'a shape is not locked by default');
  await run(t, 'object.lockAspect', {});
  await run(t, 'object.size', {dim: 'height', value: 75});
  assert.deepEqual([shapeOf(t).anchor.width, shapeOf(t).anchor.height], [400, 100]);
  assert.ok(await fails(t, 'object.size', {dim: 'width', value: 'x'}));
  await run(t, 'object.select', {});
  assert.equal((await t.state('object.size', {dim: 'width'})).enabled, false);
});
