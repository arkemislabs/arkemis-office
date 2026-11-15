// U:grid/insert: Table, Pictures, Shapes, Icons, Text Box, Charts (every type, Recommended Charts),
// Sparklines, Link, Comment and Note, Symbol and Checkbox, with the undo round trip of each, the
// chart renderer and the table styles.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/insert.rs and cmd/insert/{table,chart,objects,links}.rs,
//    crates/chart/src (axis, resolve, render, sparkline) and engine/src/tables.rs. Excel: Create Table
//    adds a header row when there is none and gives the block a banded style, Insert Chart plots the
//    selected block (first row and column as names and categories), a picture lands over the cells,
//    a link shows blue and underlined, Recommended Charts rank the types by the shape of the data.
// 2. Ours runs the same commands through the translated model and writes through the kernel, one undo
//    step each; the .xlsx round trip is tests/grid/insert-xlsx.test.mjs.
// 3. These tests; the bridge E2E tests/e2e/grid/insert-*.e2e.mjs drives the same flows from the ribbon.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {session, workbook, v, text, stored, style, run, fails} from './edit-helpers.mjs';
import {resolveChart} from '../../core/grid/lib/chart-resolve.mjs';
import {render, renderSparkline, CHART_KINDS} from '../../core/grid/lib/chart-render.mjs';
import {niceScale} from '../../core/grid/lib/chart-axis.mjs';
import {chartKind} from '../../core/grid/lib/chart-build.mjs';
import {tableCellStyle, tableAt, parseStyleName} from '../../core/grid/lib/table-style.mjs';
import {classify} from '../../core/grid/lib/links.mjs';
import {imageSize} from '../../core/grid/lib/image-info.mjs';
import {objectRect} from '../../core/grid/lib/objects.mjs';
import {resolveStyle} from '../../core/grid/model/style.mjs';

const sales = () => workbook([{id: 's1', name: 'Sheet1', blocks: {0: {
  A1: {v: 'Quarter'}, B1: {v: 'Sales'}, C1: {v: 'Cost'},
  A2: {v: 'Q1'}, B2: {v: 10}, C2: {v: 4},
  A3: {v: 'Q2'}, B3: {v: 25}, C3: {v: 9},
  A4: {v: 'Q3'}, B4: {v: 18}, C4: {v: 11},
  A5: {v: 'Q4'}, B5: {v: 30}, C5: {v: 12},
}}}]);
const sel = (t, range) => run(t, 'selection.set', {range});
const sheet = t => t.content.sheets[0];

// 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('insert.table: a header row of text becomes the table header, banded, with filter buttons', async () => {
  const t = await session(sales());
  await sel(t, 'A1:C5');
  const r = await run(t, 'insert.table', {});
  assert.deepEqual(r, {table: 'Table1', range: 'A1:C5'});
  const tb = sheet(t).tables[0];
  assert.equal(tb.name, 'Table1');
  assert.deepEqual(tb.columns.map(c => c.name), ['Quarter', 'Sales', 'Cost']);
  assert.equal(tb.style.name, 'TableStyleMedium2');
  assert.equal(tb.autoFilter, true);
  await assert.rejects(() => run(t, 'insert.table', {range: 'B2:C3'}), /overlap/);
});

test('insert.table: without headers a row of Column1.. is added above and the data moves down', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 10}, A2: {v: 20}, B1: {f: 'SUM(A1:A2)'}}}}]));
  await run(t, 'insert.table', {range: 'A1:A2', header: false});
  assert.equal(v(t, 'A1'), 'Column1');
  assert.equal(v(t, 'A2'), 10);
  assert.equal(stored(t, 'B1').f, 'SUM(A2:A3)');
  assert.equal(sheet(t).tables[0].range, 'A1:A3');
});

test('insert.table: names refuse cell addresses, R1C1 forms and names in use', async () => {
  const t = await session(sales());
  for (const n of ['R2C3', 'c', 'RC', 'C5', 'A1', 'bad name', '1x']) await assert.rejects(() => run(t, 'insert.table', {range: 'A1:C5', name: n}), /not valid/, n);
  await run(t, 'insert.table', {range: 'A1:C5', name: 'Rates'});
  await assert.rejects(() => run(t, 'insert.table', {range: 'E1:E2', name: 'rates'}), /already exists/);
});

test('table styles: header fill, banded rows and a bold header as in tables.rs', async () => {
  const t = await session(sales());
  await run(t, 'insert.table', {range: 'A1:C5'});
  const sh = sheet(t);
  const own = resolveStyle({});
  const header = tableCellStyle(tableAt(sh, 0, 1), 0, 1, own);
  assert.equal(header.fill.pattern, 'solid');
  assert.equal(header.font.bold, true);
  assert.deepEqual(parseStyleName('TableStyleLight9'), ['Light', 9]);
  const band = tableCellStyle(tableAt(sh, 1, 1), 1, 1, own);
  const plain = tableCellStyle(tableAt(sh, 2, 1), 2, 1, own);
  assert.equal(band.fill.pattern, 'solid');
  assert.equal(plain.fill.pattern, 'none');
});

test('insert.chart: the selected block plots with its first row and column as names and categories', async () => {
  const t = await session(sales());
  await sel(t, 'A1:C5');
  const r = await run(t, 'insert.chart', {type: 'column'});
  assert.equal(r.chart, 1);
  const c = sheet(t).charts[0];
  assert.equal(c.kind, 'columnClustered');
  assert.equal(c.anchor.cell, 'E1', 'two columns right of the data');
  assert.equal(c.series.length, 2);
  assert.equal(c.series[0].name, 'Sheet1!$B$1');
  assert.equal(c.series[0].categories, 'Sheet1!$A$2:$A$5');
  assert.equal(c.series[0].values, 'Sheet1!$B$2:$B$5');
  assert.equal(c.source, 'Sheet1!A1:C5');
  assert.equal(c.title, 'Chart Title', 'several series: the title is a placeholder');
  const data = resolveChart(t.content, 0, c);
  assert.deepEqual(data.categories, ['Q1', 'Q2', 'Q3', 'Q4']);
  assert.deepEqual(data.series.map(s => s.name), ['Sales', 'Cost']);
  assert.deepEqual(data.series[0].values, [10, 25, 18, 30]);
});

test('insert.chart: a column of numbers with a header is one series titled by its name', async () => {
  const t = await session(sales());
  await sel(t, 'B1:B5');
  await run(t, 'insert.chart', {type: 'line', subtype: 'markers'});
  const c = sheet(t).charts[0];
  assert.equal(c.kind, 'lineMarkers');
  assert.equal(c.title, 'Sales');
  assert.equal(c.legend, 'bottom');
});

test('insert.chart: every type the Insert tab lists maps to a kind the renderer draws', async () => {
  const t = await session(sales());
  const types = [['column', ''], ['column', 'stacked'], ['column', 'stacked100'], ['bar', ''], ['bar', 'stacked'], ['bar', 'stacked100'], ['line', ''], ['line', 'markers'], ['line', 'stacked'],
    ['area', ''], ['area', 'stacked'], ['area', 'stacked100'], ['pie', ''], ['doughnut', ''], ['scatter', ''], ['scatter', 'lines'], ['bubble', ''], ['radar', ''], ['histogram', ''], ['waterfall', ''],
    ['funnel', ''], ['treemap', ''], ['sunburst', ''], ['boxWhisker', ''], ['stock', ''], ['combo', '']];
  for (const [type, subtype] of types) {
    assert.ok(CHART_KINDS.includes(chartKind(type, subtype)), `${type} ${subtype}`);
    await sel(t, 'A1:C5');
    await run(t, 'insert.chart', {type, subtype});
  }
  const charts = sheet(t).charts;
  assert.equal(charts.length, types.length);
  assert.deepEqual(new Set(charts.map(c => c.id)).size, types.length, 'every chart has its own id');
  for (const c of charts) {
    const prims = render(c, resolveChart(t.content, 0, c), 480, 288);
    assert.ok(prims.length > 5, `${c.kind} draws something`);
    assert.ok(prims.every(p => p.t !== 'rect' || (p.w > 0 && p.h > 0)), `${c.kind} has no empty rect`);
  }
});

test('insert.chart: scatter takes the first of two plain columns as the X values (#428)', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}, B1: {v: 2}, A2: {v: 2}, B2: {v: 4}, A3: {v: 3}, B3: {v: 6}}}}]));
  await sel(t, 'A1:B3');
  await run(t, 'insert.chart', {type: 'scatter'});
  const c = sheet(t).charts[0];
  assert.equal(c.series.length, 1);
  assert.equal(c.series[0].categories, 'Sheet1!$A$1:$A$3');
  assert.equal(c.series[0].values, 'Sheet1!$B$1:$B$3');
});

test('insert.recommendedCharts: the type with no choice is the first recommendation; the list follows the data shape', async () => {
  const t = await session(sales());
  await sel(t, 'A1:B5');
  const list = await run(t, 'insert.chartRecommendations', {});
  assert.deepEqual(list.map(x => x.label), ['Clustered Column', 'Clustered Bar', 'Pie', 'Doughnut', 'Line with Markers']);
  await sel(t, 'A1:C5');
  const two = await run(t, 'insert.chartRecommendations', {});
  assert.equal(two[0].label, 'Clustered Column');
  assert.ok(two.some(x => x.label === 'Stacked Column'));
  await sel(t, 'A1:B5');
  await run(t, 'insert.recommendedCharts', {});
  assert.equal(sheet(t).charts[0].kind, 'columnClustered');
  const empty = await session(workbook());
  await assert.rejects(() => run(empty, 'insert.recommendedCharts', {}), /Select data/);
});

test('chart.set, chart.switchRowColumn and chart.delete change the selected chart', async () => {
  const t = await session(sales());
  await sel(t, 'A1:C5');
  await run(t, 'insert.chart', {type: 'column'});
  await run(t, 'chart.set', {title: 'Results', legend: 'right', dataLabels: true, xTitle: 'Quarter', width: 300, height: 200, type: 'bar', subtype: 'stacked'});
  let c = sheet(t).charts[0];
  assert.deepEqual([c.title, c.legend, c.dataLabels, c.xTitle, c.anchor.width, c.kind], ['Results', 'right', true, 'Quarter', 300, 'barStacked']);
  await run(t, 'chart.switchRowColumn', {});
  c = sheet(t).charts[0];
  assert.equal(c.byRows, true);
  assert.equal(c.series.length, 4, 'a series per quarter');
  assert.equal(c.series[0].name, 'Sheet1!$A$2');
  await run(t, 'chart.switchRowColumn', {});
  assert.equal(sheet(t).charts[0].series.length, 2);
  await run(t, 'chart.delete', {});
  assert.equal(sheet(t).charts.length, 0);
  await fails(t, 'chart.delete', {});
});

test('a chart is a sheet object: selected, moved, resized, mode set and deleted by id, each undone', async () => {
  const t = await session(sales());
  await sel(t, 'A1:C5');
  await expectUndoRoundTrip(t, 'insert.chart', {type: 'pie'}, (after, r) => assert.equal(r.result.chart, 1));
  const id = sheet(t).charts[0].id;
  assert.equal(t.doc.selection.ranges[0].anchor, `/sh:s1/chart:${id}`, 'a new chart is selected');
  await run(t, 'object.select', {});
  await run(t, 'object.select', {kind: 'chart', id});
  await expectUndoRoundTrip(t, 'object.move', {kind: 'chart', id, at: 'H3', dx: 6, dy: 4, width: 400, height: 250}, () => {});
  await run(t, 'object.move', {kind: 'chart', id, at: 'H3', dx: 6, dy: 4, width: 400, height: 250});
  assert.deepEqual(sheet(t).charts[0].anchor, {cell: 'H3', dx: 6, dy: 4, width: 400, height: 250, mode: 'moveAndSize'});
  const rect = objectRect(sheet(t), sheet(t).charts[0].anchor);
  assert.equal(rect.w, 400);
  assert.ok(rect.x > 6 * 64 && rect.y > 2 * 20);
  await run(t, 'object.setAnchorMode', {kind: 'chart', id, mode: 'absolute'});
  assert.equal(sheet(t).charts[0].anchor.mode, 'absolute');
  const list = await run(t, 'object.list', {});
  assert.deepEqual(list.map(o => [o.kind, o.id]), [['chart', id]]);
  await expectUndoRoundTrip(t, 'object.delete', {kind: 'chart', id}, () => {});
  assert.equal(sheet(t).charts.length, 0);
  await fails(t, 'object.move', {kind: 'chart', id: 999, at: 'A1'});
});

test('insert.picture: over the cells (Move but do not size) or in a cell, PNG or JPEG bytes only', async () => {
  const t = await session(sales());
  await sel(t, 'B2');
  const r = await run(t, 'insert.picture', {base64: PNG, alt: 'a dot'});
  assert.equal(r.image, 1);
  const img = sheet(t).images[0];
  assert.deepEqual([img.anchor.cell, img.anchor.mode, img.mime, img.alt, img.anchor.width, img.anchor.height], ['B2', 'moveOnly', 'image/png', 'a dot', 1, 1]);
  assert.deepEqual(imageSize(Uint8Array.from(Buffer.from(PNG, 'base64'))), [1, 1]);
  await sel(t, 'D4');
  await run(t, 'insert.picture', {base64: PNG, placement: 'cell'});
  assert.equal(sheet(t).cellPictures.D4.mime, 'image/png');
  await assert.rejects(() => run(t, 'insert.picture', {base64: '!!!'}), /invalid base64/);
  await assert.rejects(() => run(t, 'insert.picture', {base64: PNG, placement: 'cell', mime: 'image/gif'}), /PNG and JPEG/);
});

test('insert.shape, insert.textBox, shape.setText and insert.icons put drawing objects on the sheet', async () => {
  const t = await session(sales());
  await sel(t, 'E2');
  const a = await run(t, 'insert.shape', {kind: 'oval', width: 120, height: 80});
  const b = await run(t, 'insert.textBox', {text: 'Hello'});
  const c = await run(t, 'insert.icons', {name: 'Chart', size: 32, color: '#C00000'});
  const shapes = sheet(t).shapes;
  assert.deepEqual(shapes.map(s => s.kind), ['ellipse', 'textBox', 'icon']);
  assert.equal(shapes[1].fill, '#FFFFFF');
  assert.equal(shapes[2].text, 'chart');
  assert.equal(shapes[2].fill, '#C00000');
  assert.deepEqual([a.shape, b.shape, c.shape], [1, 2, 3]);
  await run(t, 'shape.setText', {id: b.shape, text: 'Changed'});
  assert.equal(sheet(t).shapes[1].text, 'Changed');
  await assert.rejects(() => run(t, 'shape.setText', {id: a.shape, text: 'x'}), /not a text box/);
  await assert.rejects(() => run(t, 'insert.icons', {name: 'nope'}), /no icon/);
  await expectUndoRoundTrip(t, 'insert.shape', {kind: 'rectangle'}, () => {});
});

test('insert.sparkline: a sparkline in a cell from a range, replaced by a second one on that cell', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}, B1: {v: 5}, C1: {v: 3}}}}]));
  await run(t, 'insert.sparkline', {range: 'A1:C1', location: 'E1', type: 'column'});
  await run(t, 'insert.sparkline', {range: 'A1:C1', location: 'E1', type: 'winLoss', markers: true});
  assert.equal(sheet(t).sparklines.length, 1);
  assert.deepEqual([sheet(t).sparklines[0].kind, sheet(t).sparklines[0].markers], ['winLoss', true]);
  await expectUndoRoundTrip(t, 'insert.sparkline', {range: 'A1:C1', location: 'F1'}, () => {});
  await assert.rejects(() => run(t, 'insert.sparkline', {range: 'nonsense', location: 'F1'}), /not a range/);
  const prims = renderSparkline('column', [1, 5, 3], [21, 96, 130, 255], false, 60, 20);
  assert.equal(prims.length, 3);
  assert.equal(renderSparkline('line', [1, null, 3, 4], [0, 0, 0, 255], true, 60, 20).filter(p => p.t === 'line').length, 1, 'a gap breaks the line, one run has two points');
});

test('insert.link: external and internal links, shown as links, followed only for http, https and mailto', async () => {
  const t = await session(sales());
  await sel(t, 'E1');
  await run(t, 'insert.link', {target: 'https://example.com', text: 'Example', tooltip: 'Go'});
  assert.equal(v(t, 'E1'), 'Example');
  assert.deepEqual(sheet(t).hyperlinks.E1, {target: 'https://example.com', tooltip: 'Go'});
  const st = style(t, 'E1');
  assert.equal(st.font.underline, 'single');
  assert.deepEqual(st.font.color, {theme: 10, tint: 0});
  await run(t, 'insert.link', {cell: 'E2', target: 'Sheet1!A1'});
  assert.deepEqual(sheet(t).hyperlinks.E2, {location: 'Sheet1!A1'});
  assert.equal(v(t, 'E2'), 'Sheet1!A1', 'an empty cell shows the target');
  assert.equal((await run(t, 'link.open', {cell: 'E1'})).opened, 'https://example.com');
  await assert.rejects(() => run(t, 'link.open', {url: 'javascript:alert(1)'}), /aren't opened/);
  await assert.rejects(() => run(t, 'link.open', {url: 'file:///c:/x'}), /aren't opened/);
  await assert.rejects(() => run(t, 'link.open', {cell: 'G9'}), /no hyperlink/);
  await run(t, 'insert.link', {cell: 'E1', remove: true});
  assert.equal(sheet(t).hyperlinks.E1, undefined);
  assert.equal(classify('mailto:a@b.example').kind, 'external');
  assert.equal(classify('C:\\Windows\\calc.exe').kind, 'refused');
  assert.equal(classify('Sheet2!A1').kind, 'internal');
});

test('review.newComment and friends: threads with replies, resolve, show and delete; a note replaces a comment', async () => {
  const t = await session(sales());
  await sel(t, 'B2');
  await run(t, 'review.newComment', {text: 'Check this', author: 'Ana'});
  assert.deepEqual(sheet(t).comments.B2, {author: 'Ana', text: 'Check this', replies: [], threaded: true, resolved: false, visible: false});
  await run(t, 'review.replyComment', {text: 'Done', author: 'Bo'});
  await run(t, 'review.resolveComment', {});
  assert.deepEqual([sheet(t).comments.B2.replies, sheet(t).comments.B2.resolved], [[['Bo', 'Done']], true]);
  await run(t, 'review.showNote', {});
  assert.equal(sheet(t).comments.B2.visible, true);
  await run(t, 'review.newNote', {text: 'A note', author: 'Ana'});
  assert.equal(sheet(t).comments?.B2, undefined, 'the note replaced the comment');
  assert.deepEqual(sheet(t).notes.B2, {text: 'A note', author: 'Ana'});
  await run(t, 'review.deleteComment', {range: 'B2'});
  assert.equal(sheet(t).notes?.B2, undefined);
});

test('insert.symbol appends to the cell text; insert.checkbox and cell.toggleCheckbox draw and flip TRUE/FALSE', async () => {
  const t = await session(sales());
  await sel(t, 'A2');
  await run(t, 'insert.symbol', {char: '€'});
  assert.equal(v(t, 'A2'), 'Q1€');
  await sel(t, 'E1:E3');
  await run(t, 'insert.checkbox', {});
  assert.deepEqual([v(t, 'E1'), v(t, 'E2'), v(t, 'E3')], [false, false, false]);
  assert.equal(style(t, 'E1').numFmt, 'checkbox');
  await run(t, 'cell.toggleCheckbox', {});
  assert.deepEqual([v(t, 'E1'), v(t, 'E2'), v(t, 'E3')], [true, true, true]);
  await run(t, 'cell.toggleCheckbox', {cell: 'E2'});
  assert.deepEqual([v(t, 'E1'), v(t, 'E2'), v(t, 'E3')], [true, false, true]);
  await expectUndoRoundTrip(t, 'insert.checkbox', {range: 'G1'}, () => {});
});

test('chart axis: nice scales (ported from chart tests)', () => {
  const s = niceScale(0, 38, true);
  assert.deepEqual([s.min, s.max, s.step], [0, 40, 5]);
  assert.deepEqual(niceScale(0, 0, true).ticks().length, 6);
  const neg = niceScale(-3, 10, false);
  assert.ok(neg.min <= -3 && neg.max >= 10);
});

test('inserting and deleting rows and columns moves objects by their anchor mode and the cells charts and sparklines plot', async () => {
  const t = await session(sales());
  await sel(t, 'A1:C5');
  await run(t, 'insert.chart', {type: 'column', at: 'E2', width: 200, height: 100});
  const id = sheet(t).charts[0].id;
  await run(t, 'insert.picture', {base64: PNG, at: 'E2', width: 50, height: 40, mode: 'moveOnly'});
  await run(t, 'insert.shape', {kind: 'rectangle', at: 'E2', width: 50, height: 40, mode: 'absolute'});
  await run(t, 'insert.sparkline', {range: 'B2:C2', location: 'G1'});
  await sel(t, 'A3');
  await run(t, 'home.insertRows', {});
  let s = sheet(t);
  assert.equal(s.charts[0].anchor.cell, 'E2', 'the chart starts above the new row');
  assert.equal(s.charts[0].anchor.height, 120, 'a new row inside a move-and-size chart makes it one row taller');
  assert.equal(s.charts[0].series[0].values, 'Sheet1!$B$2:$B$6', 'the plotted block grew');
  assert.equal(s.charts[0].series[0].categories, 'Sheet1!$A$2:$A$6');
  assert.equal(s.sparklines[0].source, 'B2:C2');
  assert.equal(s.images[0].anchor.cell, 'E2');
  await sel(t, 'A1');
  await run(t, 'home.insertRows', {});
  s = sheet(t);
  assert.equal(s.charts[0].anchor.cell, 'E3', 'a row above moves the chart down');
  assert.equal(s.images[0].anchor.cell, 'E3', 'a move-only picture follows its cell and keeps its size');
  assert.equal(s.shapes[0].anchor.cell, 'E2', 'an absolute shape stays where it is');
  assert.equal(s.sparklines[0].cell, 'G2');
  assert.equal(s.sparklines[0].source, 'B3:C3');
  assert.equal(s.charts[0].series[0].values, 'Sheet1!$B$3:$B$7');
  await sel(t, 'E3');
  await run(t, 'home.insertColumns', {});
  assert.equal(sheet(t).charts[0].anchor.cell, 'F3');
  assert.equal(sheet(t).charts[0].anchor.width, 200);
  await sel(t, 'B1:C1');
  await run(t, 'home.deleteColumns', {});
  assert.match(sheet(t).charts[0].series[0].values, /#REF!/, 'the plotted column was deleted');
  void id;
});
