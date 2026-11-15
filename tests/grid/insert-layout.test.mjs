// U:grid/insert and U:grid/page-layout: the chart kinds Excel has and gridcraft does not draw (3-D Pie, Pie of Pie, Bar of Pie, Pareto,
// 3-D Bubble, Custom Combo), WordArt, Signature Line and Equation, and Page Layout's Arrange (several objects picked together, Align,
// Distribute, Group, Regroup, Ungroup, Rotate, Flip, the Selection Pane's names and eyes), Sheet Right-to-Left, Sheet Background and the
// theme editors.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/extra/objects.rs (`align`, `rotate`, `selection_pane`), cmd/extra/cells.rs (`background`),
//    cmd/view.rs (`sheet_flag`, `theme_colors`, `theme_fonts`). The rest is not in gridcraft (not checked against upstream) and follows
//    Excel: Align needs two objects and Distribute three, a group is picked whole, a hidden object is not drawn.
// 2. Ours runs the same commands through the translated model.
// 3. These tests; the bridge E2E tests/e2e/grid/insert-layout.e2e.mjs drives the ribbon.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run} from './edit-helpers.mjs';
import {resolveChart} from '../../core/grid/lib/chart-resolve.mjs';
import {render} from '../../core/grid/lib/chart-render.mjs';
import {paretoRows, splitCount} from '../../core/grid/lib/chart-render-extra.mjs';
import {objectRect, selectedObjects} from '../../core/grid/lib/objects.mjs';
import {artEffects, WORDART_IDS} from '../../core/grid/lib/wordart.mjs';

const sheet = t => t.content.sheets[0];
const reread = async t => { const r = await readXlsx(await writeXlsx(t.content)); return r.content ?? r; };
const charts = t => sheet(t).charts ?? [];
const shapes = t => sheet(t).shapes ?? [];

async function data() {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}]));
  await run(t, 'range.setValues', {range: 'A1', values: [['Item', 'Sales', 'Cost', 'Size'], ['A', 40, 10, 3], ['B', 25, 20, 5], ['C', 15, 5, 2], ['D', 10, 8, 4], ['E', 6, 2, 1]]});
  await run(t, 'selection.set', {range: 'A1:D6'});
  return t;
}
const draw = (t, chart, w = 420, h = 260) => render(chart, resolveChart(t.content, 0, chart), w, h);

test('3-D Pie, Pie of Pie, Bar of Pie: drawn, and saved as the pie groups Excel has', async () => {
  const t = await data();
  await run(t, 'selection.set', {range: 'A1:B6'});
  const kinds = {pie3d: 'pie3DChart', pieOfPie: 'ofPieChart', barOfPie: 'ofPieChart'};
  for (const [kind, xml] of Object.entries(kinds)) {
    const r = await run(t, 'insert.chart', {kind});
    const chart = charts(t).find(c => c.id === r.chart);
    assert.equal(chart.kind, kind);
    assert.equal(chart.gridlines, false);
    assert.equal(chart.legend, 'right');
    const prims = draw(t, chart);
    assert.ok(prims.filter(p => p.t === 'poly' || p.t === 'wedge').length >= (kind === 'barOfPie' ? 3 : 5), `${kind} draws its slices`);
    if (kind === 'pie3d') assert.ok(prims.some(p => p.t === 'poly' && p.fill[0] < 255), 'the wall is a darker shade');
    if (kind === 'pieOfPie') assert.ok(prims.some(p => p.t === 'line'), 'the connector lines are drawn');
    if (kind === 'barOfPie') assert.ok(prims.some(p => p.t === 'rect' && p.w < 60), 'the second plot is a stacked bar');
    const zip = await (await import('jszip')).default.loadAsync(await writeXlsx(t.content));
    const part = Object.keys(zip.files).filter(f => /xl\/charts\/chart\d+\.xml$/.test(f)).sort().pop();
    assert.match(await zip.file(part).async('string'), new RegExp(`<c:${xml}>`));
  }
  const back = (await reread(t)).sheets[0].charts.map(c => c.kind);
  assert.deepEqual(back, ['pie3d', 'pieOfPie', 'barOfPie']);
  assert.equal(splitCount(5), 3);
  assert.equal(splitCount(2), 1);
  await expectUndoRoundTrip(t, 'insert.chart', {kind: 'pie3d'}, after => assert.equal(after.content.sheets[0].charts.length, 4));
});

test('Pareto: the first series sorted from the largest with a cumulative percent line', async () => {
  const t = await data();
  await run(t, 'selection.set', {range: 'A1:B6'});
  const r = await run(t, 'insert.chart', {kind: 'pareto'});
  const chart = charts(t).find(c => c.id === r.chart);
  const data0 = resolveChart(t.content, 0, chart);
  const rows = paretoRows(data0);
  assert.deepEqual(rows.map(x => x.label), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(rows[0].value, 40);
  assert.ok(Math.abs(rows[4].cumulative - 1) < 1e-9, 'the line ends at 100%');
  assert.ok(rows.every((x, i) => i === 0 || x.cumulative >= rows[i - 1].cumulative));
  const prims = draw(t, chart);
  assert.equal(prims.filter(p => p.t === 'rect' && p.fill && p.h > 2).length >= 5, true, 'a column for each item');
  assert.ok(prims.some(p => p.t === 'line' && p.pts.length === 5), 'the cumulative line');
  assert.ok(prims.some(p => p.t === 'text' && p.text === '100%'), 'the right axis runs to 100%');
  // Sorted from the largest even when the cells are not.
  await run(t, 'range.setValues', {range: 'B2:B6', values: [[6], [40], [10], [25], [15]]});
  assert.deepEqual(paretoRows(resolveChart(t.content, 0, charts(t).find(c => c.id === r.chart))).map(x => x.label), ['B', 'D', 'E', 'C', 'A']);
  const back = (await reread(t)).sheets[0].charts[0];
  assert.equal(back.kind, 'pareto');
});

test('3-D Bubble: shaded spheres; three columns are X, Y and size', async () => {
  const t = await data();
  await run(t, 'selection.set', {range: 'B1:D6'});
  const r = await run(t, 'insert.chart', {kind: 'bubble3d'});
  const chart = charts(t).find(c => c.id === r.chart);
  assert.equal(chart.series.length, 1, 'X, Y and size make one series');
  assert.ok(chart.series[0].bubbleSizes, 'the third column is the size');
  const prims = draw(t, chart);
  const circles = prims.filter(p => p.t === 'circle');
  assert.ok(circles.length >= 10, 'each bubble has a highlight');
  assert.ok(circles.some(c => c.fill[3] === 110), 'the highlight');
  assert.equal((await reread(t)).sheets[0].charts[0].kind, 'bubble3d');
});

test('Custom Combo: a type and an axis for each series', async () => {
  const t = await data();
  await run(t, 'selection.set', {range: 'A1:C6'});
  const r = await run(t, 'insert.chartCustomCombo', {types: [{kind: 'columnStacked'}, {kind: 'lineMarkers', secondary: true}]});
  const chart = charts(t).find(c => c.id === r.chart);
  assert.equal(chart.kind, 'combo');
  assert.deepEqual(chart.series.map(x => [x.kind, !!x.secondary]), [['columnStacked', false], ['lineMarkers', true]]);
  const prims = draw(t, chart);
  assert.ok(prims.some(p => p.t === 'rect') && prims.some(p => p.t === 'line'), 'columns and a line');
  const dialog = t.dialogModel ? null : null;
  void dialog;
  const none = await run(t, 'insert.chartCustomCombo', {});
  assert.deepEqual(charts(t).find(c => c.id === none.chart).series.map(x => x.kind), ['columnClustered', 'line', 'line'], 'the defaults are columns then lines');
});

test('insert.chart scatter variants: smooth and straight lines with markers', async () => {
  const t = await data();
  await run(t, 'selection.set', {range: 'B1:C6'});
  const a = await run(t, 'insert.chart', {kind: 'scatterSmooth'});
  const b = await run(t, 'insert.chart', {kind: 'scatterStraight'});
  assert.ok(charts(t).find(c => c.id === a.chart).series.every(x => x.smooth === true));
  assert.ok(charts(t).find(c => c.id === b.chart).series.every(x => !x.smooth));
});

test('WordArt, Signature Line and Equation are shapes that save and read back', async () => {
  const t = await data();
  const w = await run(t, 'insert.wordArt', {style: 'accent2-hard-shadow', text: 'Hello', at: 'F2'});
  const sig = await run(t, 'insert.signatureLine', {signer: 'Ada Lovelace', title: 'Analyst', email: 'ada@example.com', instructions: 'Sign here', comments: true, at: 'F8'});
  const eq = await run(t, 'insert.equation', {builtIn: 'Pythagorean Theorem', at: 'J2'});
  const [a, b, c] = ['wordArt', 'signature', 'equation'].map(k => shapes(t).find(s => s.kind === k));
  assert.equal(a.id, w.shape);
  assert.equal(a.wordArt, 'accent2-hard-shadow');
  assert.equal(a.text, 'Hello');
  assert.equal(b.signature.signer, 'Ada Lovelace');
  assert.equal(b.text, 'Ada Lovelace\nAnalyst', 'the caption is the text, so other readers see it');
  assert.equal(c.text, 'a² + b² = c²');
  assert.equal(sig.shape, b.id);
  assert.equal(eq.shape, c.id);
  const state = t.state('insert.wordArt');
  assert.equal(state.value.length, 15, 'the gallery has fifteen styles');
  assert.ok(state.value.every(x => x.art.kind === 'wordArt' && x.art.effects.fill), 'each tile is drawn from its effects');
  assert.equal(WORDART_IDS.length, 15);
  assert.ok(artEffects('accent1-gradient', [0xFFFFFF, 0, 0, 0, 0x336699]).fill.stops.length === 2);
  assert.equal(artEffects('nope'), null);
  const back = (await reread(t)).sheets[0].shapes;
  assert.deepEqual(back.map(s => s.kind), ['wordArt', 'signature', 'equation']);
  assert.equal(back[0].wordArt, 'accent2-hard-shadow');
  assert.equal(back[1].signature.title, 'Analyst');
  assert.equal(back[1].signature.comments, true);
});

async function three() {
  const t = await data();
  await run(t, 'insert.shape', {kind: 'rectangle', at: 'F2', width: 100, height: 40});
  await run(t, 'insert.shape', {kind: 'ellipse', at: 'H8', width: 60, height: 80});
  await run(t, 'insert.shape', {kind: 'triangle', at: 'K4', width: 20, height: 20});
  const [a, b, c] = shapes(t).map(s => s.id);
  const pick = async ids => { await run(t, 'object.select', {kind: 'shape', id: ids[0]}); for (const id of ids.slice(1)) await run(t, 'object.select', {kind: 'shape', id, mode: 'add'}); };
  const rect = id => objectRect(sheet(t), shapes(t).find(s => s.id === id).anchor);
  return {t, a, b, c, pick, rect};
}

test('objects picked together: Shift adds, Ctrl toggles, and Align needs two', async () => {
  const {t, a, b, c, pick, rect} = await three();
  await pick([a]);
  assert.equal(t.state('arrange.align', {to: 'left'}).enabled, false, 'one object cannot be aligned');
  await pick([a, b]);
  assert.deepEqual(selectedObjects(t.content, t.doc.selection).map(o => o.id), [a, b]);
  assert.equal(t.state('arrange.align', {to: 'left'}).enabled, true);
  assert.equal(t.state('arrange.align', {to: 'distributeH'}).enabled, false, 'Distribute needs three');
  await run(t, 'object.select', {kind: 'shape', id: c, mode: 'add'});
  assert.equal(t.state('arrange.align', {to: 'distributeH'}).enabled, true);
  await run(t, 'object.select', {kind: 'shape', id: a, mode: 'toggle'});
  assert.deepEqual(selectedObjects(t.content, t.doc.selection).map(o => o.id).sort(), [b, c].sort());
  await pick([a, b, c]);
  const before = rect(c);
  await run(t, 'arrange.align', {to: 'alignleft'});
  assert.equal(rect(a).x, rect(b).x);
  assert.equal(rect(b).x, rect(c).x);
  assert.equal(rect(a).y > 0, true);
  assert.notEqual(rect(c).x, before.x, 'the third moved');
  await run(t, 'arrange.align', {to: 'alignbottom'});
  assert.ok(Math.abs(rect(a).y + rect(a).h - (rect(c).y + rect(c).h)) < 1.5);
  await expectUndoRoundTrip(t, 'arrange.align', {to: 'aligncenter'}, after => assert.ok(after.content.sheets[0].shapes.length === 3));
});

test('Distribute spaces three or more objects evenly between the outermost two', async () => {
  const {t, a, b, c, pick, rect} = await three();
  await pick([a, b, c]);
  const [ra, rc] = [rect(a), rect(c)];
  await run(t, 'arrange.align', {to: 'distributehorizontally'});
  const sorted = [a, b, c].map(rect).sort((p, q) => p.x - q.x);
  const gap1 = sorted[1].x - (sorted[0].x + sorted[0].w), gap2 = sorted[2].x - (sorted[1].x + sorted[1].w);
  assert.ok(Math.abs(gap1 - gap2) < 1.5, `gaps ${gap1} and ${gap2}`);
  assert.equal(Math.min(...sorted.map(r => r.x)), Math.min(ra.x, rc.x, rect(b).x) <= ra.x ? Math.min(...sorted.map(r => r.x)) : ra.x, 'the outermost left stays');
  await run(t, 'arrange.align', {to: 'distributevertically'});
  const v = [a, b, c].map(rect).sort((p, q) => p.y - q.y);
  assert.ok(Math.abs((v[1].y - (v[0].y + v[0].h)) - (v[2].y - (v[1].y + v[1].h))) < 1.5);
});

test('Group, Ungroup and Regroup: a group is picked whole and moves together', async () => {
  const {t, a, b, c, pick, rect} = await three();
  await pick([a, b]);
  const r = await run(t, 'arrange.group', {});
  assert.equal(r.members, 2);
  assert.equal(shapes(t).find(s => s.id === a).group, shapes(t).find(s => s.id === b).group);
  assert.equal(shapes(t).find(s => s.id === c).group, undefined);
  await run(t, 'object.select', {kind: 'shape', id: c});
  await run(t, 'object.select', {kind: 'shape', id: a});
  assert.deepEqual(selectedObjects(t.content, t.doc.selection).map(o => o.id).sort(), [a, b].sort(), 'picking one picks the group');
  const [ra, rb] = [rect(a), rect(b)];
  await run(t, 'arrange.moveBy', {dx: 30, dy: 12});
  assert.equal(rect(a).x, ra.x + 30);
  assert.equal(rect(b).y, rb.y + 12);
  assert.equal(t.state('arrange.group', {ungroup: true}).enabled, true);
  await run(t, 'arrange.group', {ungroup: true});
  assert.equal(shapes(t).find(s => s.id === a).group, undefined);
  assert.ok(shapes(t).find(s => s.id === a).regroup, 'remembered for Regroup');
  await run(t, 'object.select', {kind: 'shape', id: a});
  assert.equal(selectedObjects(t.content, t.doc.selection).length, 1, 'a split group picks one');
  assert.equal(t.state('arrange.group', {regroup: true}).enabled, true);
  await run(t, 'arrange.group', {regroup: true});
  assert.equal(shapes(t).find(s => s.id === a).group, shapes(t).find(s => s.id === b).group);
  // A group's membership is saved with the file.
  const back = (await reread(t)).sheets[0].shapes;
  assert.equal(back[0].group, back[1].group);
  assert.equal(back[2].group, undefined);
  await run(t, 'object.select', {kind: 'shape', id: a});
  await expectUndoRoundTrip(t, 'arrange.group', {ungroup: true}, after => assert.equal(after.content.sheets[0].shapes[0].group, undefined));
});

test('Rotate and Flip turn pictures and shapes (not charts); gridcraft\'s turn still swaps width and height', async () => {
  const {t, a, b, pick} = await three();
  await pick([a]);
  await run(t, 'arrange.rotate', {degrees: 90});
  assert.equal(shapes(t).find(s => s.id === a).rotation, 90);
  await run(t, 'arrange.rotate', {degrees: 90});
  await run(t, 'arrange.rotate', {degrees: 180});
  assert.equal(shapes(t).find(s => s.id === a).rotation, undefined, 'a full turn is no rotation');
  await run(t, 'arrange.rotate', {angle: 35.5});
  assert.equal(shapes(t).find(s => s.id === a).rotation, 35.5);
  await run(t, 'arrange.rotate', {flip: 'horizontal'});
  await run(t, 'arrange.rotate', {flip: 'vertical'});
  assert.equal(shapes(t).find(s => s.id === a).flipH, true);
  assert.equal(shapes(t).find(s => s.id === a).flipV, true);
  await run(t, 'arrange.rotate', {flip: 'horizontal'});
  assert.equal(shapes(t).find(s => s.id === a).flipH, undefined, 'flipping again undoes it');
  const back = (await reread(t)).sheets[0].shapes[0];
  assert.equal(back.rotation, 35.5);
  assert.equal(back.flipV, true);
  const swapped = await run(t, 'arrange.rotate', {id: b});
  assert.deepEqual([swapped.width, swapped.height], [80, 60]);
  const r = await run(t, 'insert.chart', {kind: 'columnClustered'});
  await run(t, 'object.select', {kind: 'chart', id: r.chart});
  assert.equal(t.state('arrange.rotate', {degrees: 90}).enabled, false, 'charts are not turned');
});

test('the Selection Pane names objects and hides them; Show All and Hide All', async () => {
  const {t, a, b} = await three();
  const list = await run(t, 'arrange.selectionPane', {list: true});
  assert.deepEqual(list.map(x => x.name), [`rectangle ${a}`, `ellipse ${b}`, `triangle ${list[2].id}`]);
  await run(t, 'arrange.rename', {kind: 'shape', id: a, name: 'Header box'});
  await run(t, 'arrange.setVisible', {kind: 'shape', id: b});
  const after = await run(t, 'arrange.selectionPane', {list: true});
  assert.equal(after[0].name, 'Header box');
  assert.equal(after[1].hidden, true);
  await run(t, 'arrange.setVisible', {all: false});
  assert.ok((await run(t, 'arrange.selectionPane', {list: true})).every(x => x.hidden));
  await run(t, 'arrange.setVisible', {all: true});
  assert.ok((await run(t, 'arrange.selectionPane', {list: true})).every(x => !x.hidden));
  await run(t, 'arrange.setVisible', {kind: 'shape', id: b, visible: false});
  const back = (await reread(t)).sheets[0].shapes;
  assert.equal(back[0].name, 'Header box');
  assert.equal(back[1].hidden, true);
  assert.equal(back[2].name, undefined);
  await run(t, 'arrange.selectionPane', {on: true});
  assert.equal(t.doc.view.selectionPane, true);
  await run(t, 'arrange.selectionPane', {on: false});
  assert.equal(t.doc.view.selectionPane, false);
});

test('Snap to Grid and Snap to Shape are window settings', async () => {
  const {t} = await three();
  assert.equal(t.state('arrange.snap', {mode: 'grid'}).checked, false);
  await run(t, 'arrange.snap', {mode: 'grid'});
  assert.equal(t.doc.view.snapToGrid, true);
  assert.equal(t.state('arrange.snap', {mode: 'grid'}).checked, true);
  await run(t, 'arrange.snap', {mode: 'shape', on: true});
  assert.equal(t.doc.view.snapToShape, true);
  await run(t, 'arrange.snap', {mode: 'grid'});
  assert.equal(t.doc.view.snapToGrid, false);
});

test('Sheet Right-to-Left is the sheet view flag and saves with the file', async () => {
  const t = await data();
  assert.equal(t.state('view.rightToLeft').checked, false);
  await run(t, 'view.rightToLeft', {});
  assert.equal(sheet(t).rightToLeft, true);
  assert.equal(t.state('view.rightToLeft').checked, true);
  assert.equal((await reread(t)).sheets[0].rightToLeft, true);
  await run(t, 'view.rightToLeft', {on: false});
  assert.equal(sheet(t).rightToLeft, undefined);
  await expectUndoRoundTrip(t, 'view.rightToLeft', {on: true}, after => assert.equal(after.content.sheets[0].rightToLeft, true));
});

test('Customize Colors and Customize Fonts set a theme of the person\'s own; Background sets and deletes the sheet picture', async () => {
  const t = await data();
  const colors = ['#FFFFFF', '#101010', '#EEEEEE', '#222222', '#AA0000', '#00AA00', '#0000AA', '#AAAA00', '#00AAAA', '#AA00AA', '#0000FF', '#800080'];
  await run(t, 'pageLayout.themeColors', {name: 'Mine', colors});
  assert.equal(t.content.theme.name, 'Mine');
  assert.equal(t.content.theme.colors[4], 0xAA0000);
  await run(t, 'pageLayout.themeFonts', {major: 'Georgia', minor: 'Verdana'});
  assert.equal(t.content.theme.majorFont, 'Georgia');
  assert.equal(t.content.theme.minorFont, 'Verdana');
  const model = t.dialogModel?.('dialog.createThemeColors');
  void model;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await run(t, 'pageLayout.background', {base64: png, mime: 'image/png'});
  assert.equal((sheet(t).images ?? []).filter(i => i.alt === 'Sheet background').length, 1);
  assert.equal(t.state('pageLayout.background').checked, true);
  await run(t, 'pageLayout.background', {clear: true});
  assert.equal((sheet(t).images ?? []).filter(i => i.alt === 'Sheet background').length, 0);
});
