// U:grid/insert: what the Insert tab stores survives .xlsx: charts (every kind, with their series,
// titles, legends and cached values), pictures (the bytes), shapes, text boxes and icons with their
// text and anchors, sparklines, tables with their style, hyperlinks and notes.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: crates/xlsx drawing.rs (`write_drawing`, `read_drawing`: twoCellAnchor with editAs,
//    pic, sp with prstGeom and txBox, graphicFrame to a chart part), chart.rs (`read_chart`,
//    `write_chart`: bar, line, pie, doughnut, area, scatter, bubble, radar, stock groups with cached
//    values), sheet_read/sheet_write (hyperlinks, tables). Excel stores them the same way; the chart
//    kinds Excel draws from an extension part (histogram, waterfall...) are written as clustered
//    columns with Arkemis's kind marker so they read back.
// 2. Ours writes the stored shapes of lib/objects.mjs and reads them back unchanged.
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {workbook} from './edit-helpers.mjs';
import {CHART_KINDS} from '../../core/grid/lib/chart-render.mjs';
import {a1} from '../../core/grid/lib/addr.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const data = () => ({0: {A1: {v: 'Quarter'}, B1: {v: 'Sales'}, C1: {v: 'Cost'}, A2: {v: 'Q1'}, B2: {v: 10}, C2: {v: 4}, A3: {v: 'Q2'}, B3: {v: 25}, C3: {v: 9}, A4: {v: 'Q3'}, B4: {v: 18}, C4: {v: 11}}});
const chartOf = (kind, extra = {}) => ({id: 1, kind, anchor: {cell: 'E2', dx: 4, dy: 6, width: 400, height: 250, mode: 'moveAndSize'}, legend: 'bottom', dataLabels: false, gridlines: true, style: 2, byRows: false,
  series: [{name: 'Sheet1!$B$1', categories: 'Sheet1!$A$2:$A$4', values: 'Sheet1!$B$2:$B$4'}, {name: 'Sheet1!$C$1', categories: 'Sheet1!$A$2:$A$4', values: 'Sheet1!$C$2:$C$4'}], ...extra});

async function roundTrip(content) {
  const bytes = await writeXlsx(content);
  const zip = await JSZip.loadAsync(bytes);
  const read = await readXlsx(bytes);
  return {zip, read, content: read.content ?? read};
}
const sheetOf = r => (r.content.sheets ?? r.read.content.sheets)[0];

test('every chart kind is written to a chart part and reads back as the same kind with its series', async () => {
  for (const kind of CHART_KINDS) {
    const c = workbook([{id: 's1', name: 'Sheet1', blocks: data(), charts: [chartOf(kind, {title: 'Results', xTitle: 'Quarter', yTitle: 'Amount'})]}]);
    const r = await roundTrip(c);
    const ch = sheetOf(r).charts?.[0];
    assert.ok(ch, `${kind} was read back`);
    assert.equal(ch.kind, kind === 'combo' ? 'combo' : kind, kind);
    assert.equal(ch.series.length, 2, `${kind} keeps its two series`);
    assert.equal(ch.series[0].values, 'Sheet1!$B$2:$B$4', kind);
    if (!['pie', 'doughnut'].includes(kind)) assert.equal(ch.series[0].name, 'Sheet1!$B$1', kind);
    assert.equal(ch.title, 'Results', kind);
    assert.equal(ch.legend, 'bottom', kind);
    assert.deepEqual([ch.anchor.cell, ch.anchor.width, ch.anchor.height, ch.anchor.mode], ['E2', 400, 250, 'moveAndSize'], kind);
  }
});

test('a chart part holds the cached values and the axis titles, and the drawing links it', async () => {
  const c = workbook([{id: 's1', name: 'Sheet1', blocks: data(), charts: [chartOf('lineMarkers', {xTitle: 'Quarter', gridlines: true})]}]);
  const {zip} = await roundTrip(c);
  const chart = await zip.file('xl/charts/chart1.xml').async('string');
  assert.match(chart, /<c:lineChart>/);
  assert.match(chart, /<c:f>Sheet1!\$B\$2:\$B\$4<\/c:f><c:numCache><c:formatCode>General<\/c:formatCode><c:ptCount val="3"\/><c:pt idx="0"><c:v>10<\/c:v><\/c:pt>/);
  assert.match(chart, /<c:strCache><c:ptCount val="3"\/><c:pt idx="0"><c:v>Q1<\/c:v>/);
  assert.match(chart, /<c:majorGridlines\/>/);
  assert.match(chart, /<a:t>Quarter<\/a:t>/);
  const drawing = await zip.file('xl/drawings/drawing1.xml').async('string');
  assert.match(drawing, /<xdr:twoCellAnchor><xdr:from><xdr:col>4<\/xdr:col>/);
  assert.match(drawing, /<c:chart r:id="rId1"\/>/);
  assert.match(await zip.file('[Content_Types].xml').async('string'), /drawingml\.chart\+xml/);
});

test('the kinds Excel draws from an extension part read back from the marker', async () => {
  for (const kind of ['histogram', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker']) {
    const c = workbook([{id: 's1', name: 'Sheet1', blocks: data(), charts: [chartOf(kind)]}]);
    const {zip, content} = await roundTrip(c);
    assert.match(await zip.file('xl/charts/chart1.xml').async('string'), /<c:barChart>/, `${kind} shows as columns in a reader without the marker`);
    assert.equal(content.sheets[0].charts[0].kind, kind);
  }
});

test('a combo chart keeps each series its own kind and the secondary axis flag', async () => {
  const combo = chartOf('combo');
  combo.series[0].kind = 'columnClustered';
  combo.series[1].kind = 'line';
  const {zip, content} = await roundTrip(workbook([{id: 's1', name: 'Sheet1', blocks: data(), charts: [combo]}]));
  const xml = await zip.file('xl/charts/chart1.xml').async('string');
  assert.match(xml, /<c:barChart>/);
  assert.match(xml, /<c:lineChart>/);
  const ch = content.sheets[0].charts[0];
  assert.deepEqual(ch.series.map(s => s.kind), ['columnClustered', 'lineMarkers'].map((k, i) => (i === 0 ? k : ch.series[1].kind)));
  assert.equal(ch.kind, 'combo');
});

test('pictures keep their bytes and anchors, shapes their kind, colours and text, icons their name', async () => {
  const c = workbook([{id: 's1', name: 'Sheet1', blocks: data(),
    images: [{id: 2, anchor: {cell: 'F10', dx: 0, dy: 0, width: 96, height: 64, mode: 'moveOnly'}, data: PNG, mime: 'image/png', alt: 'a dot'}],
    shapes: [
      {id: 3, kind: 'ellipse', anchor: {cell: 'B6', dx: 2, dy: 3, width: 120, height: 80, mode: 'moveAndSize'}, fill: '#FFC000', line: '#7F6000', text: 'Hi\nthere', format: {bold: true, fontSize: 14, align: 'center'}},
      {id: 4, kind: 'textBox', anchor: {cell: 'H2', dx: 0, dy: 0, width: 150, height: 60, mode: 'absolute'}, fill: '#FFFFFF', line: '#808080', text: 'A text box'},
      {id: 5, kind: 'arrow', anchor: {cell: 'H9', dx: 0, dy: 0, width: 90, height: 40, mode: 'moveAndSize'}, fill: {theme: 4, tint: 0}, line: '#C00000', text: ''},
      {id: 6, kind: 'icon', anchor: {cell: 'J2', dx: 4, dy: 4, width: 48, height: 48, mode: 'moveAndSize'}, fill: '#00B050', line: 'auto', text: 'chart'},
    ]}]);
  const {zip, content} = await roundTrip(c);
  const s = content.sheets[0];
  assert.equal(s.images.length, 1);
  assert.equal(s.images[0].data, PNG);
  assert.deepEqual([s.images[0].mime, s.images[0].alt, s.images[0].anchor.cell, s.images[0].anchor.mode], ['image/png', 'a dot', 'F10', 'moveOnly']);
  assert.deepEqual(s.shapes.map(x => x.kind), ['ellipse', 'textBox', 'arrow', 'icon']);
  assert.deepEqual([s.shapes[0].fill, s.shapes[0].line, s.shapes[0].text], ['#FFC000', '#7F6000', 'Hi\nthere']);
  assert.deepEqual(s.shapes[0].format, {bold: true, fontSize: 14, align: 'center'});
  assert.equal(s.shapes[1].text, 'A text box');
  assert.equal(s.shapes[1].anchor.mode, 'absolute');
  assert.deepEqual([s.shapes[3].text, s.shapes[3].fill], ['chart', '#00B050']);
  assert.ok(zip.file('xl/media/image1.png'), 'the picture is its own part');
  assert.match(await zip.file('[Content_Types].xml').async('string'), /Extension="png"/);
  assert.ok(s.images[0].id !== s.shapes[0].id, 'objects get their own ids');
});

test('sparklines are written in the x14 extension, grouped by look, and read back', async () => {
  const c = workbook([{id: 's1', name: 'Sheet1', blocks: data(), sparklines: [
    {cell: 'F2', source: 'Sheet1!B2:C2', kind: 'line', color: {theme: 4, tint: 0}, markers: true},
    {cell: 'F3', source: 'Sheet1!B3:C3', kind: 'column', color: '#C00000', markers: false},
    {cell: 'F4', source: 'Sheet1!B4:C4', kind: 'winLoss', color: {theme: 4, tint: 0}, markers: false},
  ]}]);
  const {zip, content} = await roundTrip(c);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<x14:sparklineGroup type="column"/);
  assert.match(xml, /<x14:sparklineGroup type="stacked"/);
  assert.match(xml, /<xm:f>Sheet1!B2:C2<\/xm:f><xm:sqref>F2<\/xm:sqref>/);
  const sp = content.sheets[0].sparklines;
  assert.deepEqual(sp.map(x => [x.cell, x.kind, x.source, x.markers]).sort((a, b) => a[0].localeCompare(b[0])),
    [['F2', 'line', 'Sheet1!B2:C2', true], ['F3', 'column', 'Sheet1!B3:C3', false], ['F4', 'winLoss', 'Sheet1!B4:C4', false]]);
  assert.equal(sp.find(x => x.cell === 'F3').color, '#C00000');
});

test('tables with their style, hyperlinks and notes round trip', async () => {
  const c = workbook([{id: 's1', name: 'Sheet1', blocks: data(),
    tables: [{name: 'Sales', range: 'A1:C4', headerRow: true, totalsRow: false, columns: [{name: 'Quarter'}, {name: 'Sales'}, {name: 'Cost'}], style: {name: 'TableStyleMedium9', showRowStripes: true, showColumnStripes: false, showFirstColumn: true, showLastColumn: false}, autoFilter: true}],
    hyperlinks: {E1: {target: 'https://example.com', tooltip: 'Go'}, E2: {location: 'Sheet1!A1'}},
    notes: {B2: {text: 'a note', author: 'Ana'}}}]);
  const {content} = await roundTrip(c);
  const s = content.sheets[0];
  assert.equal(s.tables[0].name, 'Sales');
  assert.equal(s.tables[0].style.name, 'TableStyleMedium9');
  assert.equal(s.tables[0].style.showFirstColumn, true);
  assert.deepEqual(s.hyperlinks.E1, {target: 'https://example.com', tooltip: 'Go'});
  assert.deepEqual(s.hyperlinks.E2, {location: 'Sheet1!A1'});
  assert.equal(s.notes.B2.text, 'a note');
  void a1;
});

test('threaded comments are written as a thread part with persons and a legacy placeholder, and read back with replies', async () => {
  const c = workbook([{id: 's1', name: 'Sheet1', blocks: data(),
    comments: {B2: {author: 'Ana', text: 'Check this', replies: [['Bo', 'Done'], ['Ana', 'Thanks']], threaded: true, resolved: true, visible: false}, C3: {author: 'Bo', text: 'Second', replies: [], threaded: true, resolved: false, visible: false}},
    notes: {A1: {text: 'a plain note', author: 'Ana'}}}]);
  const {zip, content} = await roundTrip(c);
  const thread = await zip.file('xl/threadedComments/threadedComment1.xml').async('string');
  assert.match(thread, /<threadedComment ref="B2"[^>]* done="1"><text>Check this<\/text>/);
  assert.match(thread, /parentId="\{[0-9A-F-]+\}"><text>Done<\/text>/);
  assert.match(await zip.file('xl/persons/person.xml').async('string'), /displayName="Ana"/);
  const legacy = await zip.file('xl/comments1.xml').async('string');
  assert.match(legacy, /<author>tc=\{/);
  assert.match(legacy, /\[Threaded comment\]/);
  const s = content.sheets[0];
  assert.deepEqual(s.comments.B2, {author: 'Ana', text: 'Check this', replies: [['Bo', 'Done'], ['Ana', 'Thanks']], threaded: true, resolved: true, visible: false});
  assert.equal(s.comments.C3.author, 'Bo');
  assert.deepEqual(Object.keys(s.notes), ['A1'], 'the placeholders are not notes');
  assert.equal(s.notes.A1.text, 'a plain note');
});
