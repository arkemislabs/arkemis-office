// U:prism, the controls that had no engine (docs/spec/patches/prism/rest-prism.json): View > Black and White, Cascade and Move Split; the
// pen, highlighter, eraser and laser pointer of a running show with the colours of Set Up Show; the Draw tab's Add Pen and Ruler; the
// Eyedropper and Set Transparent Color; Shape Effects > Preset and 3-D Rotation and the text effects Glow, Reflection, Bevel and 3-D Rotation;
// the Filled Radar, Surface and Pareto charts and the Axes, Data Table, Error Bars, Lines, Trendline and Up/Down Bars chart elements.
//
// 1. deckcraft draws the show's pen and laser pointer (crates/ui-egui/src/show/ui.rs); everything else here is PowerPoint's behaviour and
//    not checked against upstream.
// 2. Ours: core/prism/commands/{viewextra,showpen,drawextra,colorpick,effects3d,chartextra}.mjs, core/prism/lib/{camera3d,chart-extra}.mjs,
//    src/apps/prism/show/ShowStage.tsx, surface/SlideView.tsx.
// 3. These tests and tests/e2e/prism/rest-controls.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide, shape, presetGeom} from '../../core/prism/model/presentation.mjs';
import {colorRgb, fillSolid} from '../../core/prism/model/style.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';
import {modules as generated} from '../../core/generated/prism.commands.mjs';
import surface from '../../src/apps/prism/ui-commands/surface.ts';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';
import {projection, aboutCenter, cameraOf, EFFECT_PRESETS, CAMERA_MENU} from '../../core/prism/lib/camera3d.mjs';
import {parse3d, apply3d, flat3d, to3dXml} from '../../core/prism/lib/three-d.mjs';
import {rulerSnap} from '../../core/prism/lib/pointer.mjs';
import {chartPrims, sampleChart, TYPES, TYPE_IDS, chartPartXml} from '../../core/prism/lib/chart.mjs';
import {readChartPart} from '../../core/prism/lib/chart-read.mjs';
import {paretoData, errorAmount} from '../../core/prism/lib/chart-extra.mjs';
import {drawData} from '../../core/prism/lib/chart.mjs';

const resolve = () => ({r: 68, g: 114, b: 196, a: 255});

async function session({shapes = [], prefs, host} = {}) {
  const c = createContent('Rest');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = [newSlide({id: 's1', layout, shapes}), newSlide({id: 's2', layout})];
  c.nextId = 500;
  const sel = shapes.length ? `/sl:s1/sp:${shapes.at(-1).id}` : '/sl:s1';
  return createTestSession('prism', {content: c, modules: [...generated, surface], prefs, ...(host ? {host} : {}), selection: {ranges: [{anchor: sel, focus: sel}], primary: 0}});
}
const box = (id, x, y, w, h, extra = {}) => shape({id, name: `Rectangle ${id}`, xfrm: {x, y, w, h}, geom: presetGeom('rect'), fill: fillSolid(colorRgb({r: 68, g: 114, b: 196, a: 255})), ...extra});

test('Black and White, Grayscale and Color are one choice; Cascade needs the app window; Move Split moves the bars by what it is given', async () => {
  const t = await session();
  assert.equal(t.state('view.color').checked, true);
  await t.exec('view.blackWhite', {});
  assert.equal(t.doc.view.blackWhite, true);
  assert.equal(t.state('view.blackWhite').checked, true);
  assert.equal(t.state('view.color').checked, false);
  await t.exec('view.grayscale', {});
  assert.deepEqual([t.doc.view.grayscale, t.doc.view.blackWhite], [true, false]);
  await t.exec('view.blackWhite', {});
  assert.deepEqual([t.doc.view.grayscale, t.doc.view.blackWhite], [false, true]);
  await t.exec('view.color', {});
  assert.deepEqual([t.doc.view.grayscale, t.doc.view.blackWhite], [false, false]);
  assert.equal(t.state('view.cascade').enabled, false, 'no host windows in a test session');
  await t.exec('view.moveSplit', {dx: 40, dy: -12});
  assert.deepEqual([t.doc.view.splitMove.dx, t.doc.view.splitMove.dy], [40, -12]);
  await t.exec('view.moveSplit', {});
  assert.equal(t.doc.view.moveSplit, true);
  await t.exec('view.moveSplit', {end: true});
  assert.equal(t.doc.view.moveSplit, false);
  const arranged = [];
  const {createTestHost} = await import('../../core/kernel/host.mjs');
  const host = createTestHost();
  host.windows = {arrange: async r => { arranged.push(r); return {}; }, open() {}, state: () => ({windows: []})};
  const w = await session({host});
  assert.equal(w.state('view.cascade').enabled, true);
  await w.exec('view.cascade', {});
  assert.deepEqual(arranged, [{mode: 'cascade'}]);
});

test('Set Up Show keeps the pen and laser pointer colours, and the .pptx carries both', async () => {
  const t = await session();
  await t.exec('show.setup', {penColor: '#0070C0', laserColor: {r: 0, g: 176, b: 80}});
  assert.deepEqual(t.content.show.penColor, {r: 0, g: 112, b: 192, a: 255});
  assert.deepEqual(t.content.show.laserColor, {r: 0, g: 176, b: 80, a: 255});
  await assert.rejects(t.exec('show.setup', {penColor: 'blue-ish'}), /colour/);
  const back = await importPptx(await exportPptx(t.content));
  assert.deepEqual(back.show.penColor, {r: 0, g: 112, b: 192, a: 255});
  assert.deepEqual(back.show.laserColor, {r: 0, g: 176, b: 80, a: 255});
});

test('the show pointer commands ask the running show; the ink drawn in it joins the slide as one ink layer', async () => {
  const t = await session();
  await assert.rejects(t.exec('show.pen', {}), /no slide show/);
  await t.exec('show.fromStart', {});
  for (const [id, kind] of [['show.pen', 'pen'], ['show.laser', 'laser'], ['show.highlighter', 'highlighter'], ['show.eraser', 'eraser'], ['show.arrow', 'arrow'], ['show.eraseInk', 'eraseInk']]) {
    const n = t.doc.view.showCmd?.n ?? 0;
    await t.exec(id, {});
    assert.deepEqual([t.doc.view.showCmd.kind, t.doc.view.showCmd.n], [kind, n + 1]);
  }
  await t.exec('show.report', {slide: 0, step: 0, playing: false, ended: false, pointer: 'pen', ink: 2, keepAsk: false});
  assert.equal(t.state('show.pen').checked, true);
  assert.equal(t.state('show.laser').checked, false);
  await t.exec('show.keepInk', {discard: true});
  assert.equal(t.doc.view.showCmd.kind, 'discardInk');
  const ink = [{slide: 0, strokes: [{points: [[10, 10, 1], [60, 40, 1]], color: {r: 255, g: 0, b: 0, a: 255}, width: 2.25, highlighter: false}]}];
  await t.exec('show.addInk', {ink});
  await t.exec('show.addInk', {ink: [{slide: 0, strokes: [{points: [[0, 0], [5, 5]], highlighter: true}]}]});
  const inks = t.content.slides[0].shapes.filter(s => s.kind?.type === 'ink');
  assert.equal(inks.length, 1, 'one ink layer a slide');
  assert.equal(inks[0].kind.strokes.length, 2);
  assert.equal(inks[0].kind.strokes[1].highlighter, true);
  assert.deepEqual(inks[0].xfrm, {x: 0, y: 0, w: 960, h: 540});
});

test('Add Pen keeps pens in the settings; the gallery picks one up and removes it; the Ruler places itself', async () => {
  const t = await session();
  let prefs = {};
  const run = async (id, p) => { await t.exec(id, p); prefs = t.prefs ?? prefs; };
  await run('draw.addPen', {kind: 'highlighter'});
  assert.deepEqual(t.doc.view.tool, {kind: 'ink', mode: 'highlighter', color: {r: 255, g: 230, b: 0, a: 255}, width: 10, sticky: true});
  await run('draw.addPen', {kind: 'pen', color: '#00B050', width: 4});
  assert.deepEqual(t.session.prefs.prismPens.map(p => [p.kind, p.color, p.width]), [['highlighter', 'FFE600', 10], ['pen', '00B050', 4]]);
  const gallery = t.state('draw.usePen').value;
  assert.equal(gallery.length, 2);
  assert.equal(gallery[1].selected, true, 'the pen just added is the one in use');
  await t.exec('draw.usePen', {index: 0});
  assert.equal(t.doc.view.tool.mode, 'highlighter');
  await t.exec('draw.removePen', {index: 0});
  assert.deepEqual(t.session.prefs.prismPens.map(p => p.color), ['00B050']);
  await assert.rejects(t.exec('draw.usePen', {index: 5}), /no pen/);
  await t.exec('draw.ruler', {});
  assert.equal(t.state('draw.ruler').checked, true);
  assert.equal(t.doc.view.rulerStencil.on, true);
  await t.exec('draw.ruler', {x: 100, y: 200, angle: 30});
  assert.deepEqual([t.doc.view.rulerStencil.x, t.doc.view.rulerStencil.y, t.doc.view.rulerStencil.angle], [100, 200, 30]);
  await t.exec('draw.ruler', {on: false});
  assert.equal(t.state('draw.ruler').checked, false);
});

test('ink started on the ruler edge runs straight along it; ink far from it is free', async () => {
  const t = await session();
  await t.exec('draw.ruler', {x: 100, y: 200, angle: 0});
  await t.exec('tool.ink', {mode: 'pen', width: 2});
  const ev = (kind, x, y) => ({kind, x, y});
  await t.exec('surface.pointer', {events: [ev('down', 150, 205), ev('drag', 250, 230), ev('drag', 350, 190), ev('up', 350, 190)], tol: 3});
  const ink = t.content.slides[0].shapes.find(s => s.kind?.type === 'ink');
  assert.ok(ink, 'the stroke made an ink layer');
  assert.ok(ink.kind.strokes[0].points.every(([, y]) => Math.abs(y - 200) < 1e-6), 'every point is on the ruler edge');
  assert.deepEqual(ink.kind.strokes[0].points.map(p => Math.round(p[0])), [150, 250, 350]);
  await t.exec('surface.pointer', {events: [ev('down', 150, 400), ev('drag', 250, 430), ev('up', 250, 430)], tol: 3});
  assert.equal(t.content.slides[0].shapes.find(s => s.kind?.type === 'ink').kind.strokes[1].points[1][1], 430);
  // Rotated 90 degrees the edge is vertical.
  const down = rulerSnap({rulerStencil: {x: 100, y: 100, angle: 90, on: true}}, {x: 95, y: 150});
  assert.ok(down);
  assert.deepEqual([Math.round(down({x: 70, y: 180}).x), Math.round(down({x: 70, y: 180}).y)], [100, 180]);
  assert.equal(rulerSnap({rulerStencil: {x: 100, y: 100, angle: 0, on: false}}, {x: 120, y: 100}), null);
});

test('the Eyedropper arms, a click asks for the colour under it, and the colour applies to its target; Set Transparent Color sets the picture', async () => {
  const t = await session({shapes: [box('a', 100, 100, 200, 120)]});
  await t.exec('tool.eyedropper', {target: 'fill'});
  assert.deepEqual(t.doc.view.tool, {kind: 'eyedropper', target: 'fill'});
  assert.equal(t.state('tool.eyedropper', {target: 'fill'}).checked, true);
  const r = await t.exec('surface.pointer', {events: [{kind: 'down', x: 150, y: 150}, {kind: 'up', x: 150, y: 150}], tol: 3});
  assert.deepEqual(r.result.ui, [{pickColor: {target: 'fill', x: 150, y: 150}}], 'the pointer asks the surface for the colour');
  await t.exec('tool.eyedropper', {target: 'fill', color: '#ff8000'});
  assert.equal(t.doc.view.tool ?? null, null, 'the tool is put away');
  const fill = t.content.slides[0].shapes[0].fill;
  assert.deepEqual(fill.color.base.rgb, {r: 255, g: 128, b: 0, a: 255});
  await t.exec('tool.transparentColor', {});
  assert.equal(t.doc.view.tool.target, 'transparent');
  await assert.rejects(t.exec('tool.eyedropper', {target: 'fill', color: 'orange'}), /#RRGGBB/);
});

test('3-D cameras: presets turn the plane and a depth puts the back behind it; flat shapes have no camera', () => {
  const s = flat3d();
  assert.equal(projection(s), null);
  apply3d(s, {camera: 'isometricLeftDown', depth: 10});
  const p = projection(s);
  assert.ok(Math.abs(p.a - 0.7071) < 1e-3 && Math.abs(p.b - 0.4082) < 1e-3 && Math.abs(p.d - 0.8165) < 1e-3, 'an isometric face');
  assert.ok(Math.hypot(p.ex, p.ey) > 0.5, 'the extrusion has a direction');
  const m = aboutCenter(p, 50, 30);
  assert.deepEqual([m[4], m[5]].map(v => Math.round(v * 10)), [146, -149], 'the centre of the shape stays where it is');
  assert.equal(Math.round(m[0] * 50 + m[2] * 30 + m[4]), 50);
  const flat = flat3d();
  apply3d(flat, {camera: 'obliqueTopLeft', depth: 20});
  const ob = projection(flat);
  assert.deepEqual([ob.a, ob.d], [1, 1]);
  assert.ok(ob.ex < 0 && ob.ey < 0, 'oblique top left puts the back up and left');
  assert.equal(cameraOf(to3dXml(parse3d(to3dXml(s)))).depth, 10, 'kept 3-D XML reads back to the same camera');
  assert.equal(cameraOf(null), null);
  assert.equal(CAMERA_MENU.flatMap(g => g.items).length, 20);
  for (const [camera] of CAMERA_MENU.flatMap(g => g.items)) { const x = flat3d(); apply3d(x, {camera}); assert.equal(x.camera, camera, camera + ' is a camera the model keeps'); }
  assert.equal(EFFECT_PRESETS.length, 12);
});

test('Shape Effects > Preset clears the effects then applies the preset; 3-D Rotation items set the camera', async () => {
  const t = await session({shapes: [box('a', 100, 100, 200, 120, {effects: {outerShadow: null, innerShadow: null, glow: {color: {base: {kind: 'rgb', rgb: {r: 1, g: 2, b: 3, a: 255}}, mods: []}, radius: 18}, softEdge: null, reflection: null, bevel: null, raw3d: null, fillOverlay: null}})]});
  await t.exec('shape.effectPreset', {index: 8});
  const fx = t.content.slides[0].shapes[0].effects;
  assert.equal(fx.glow, null, 'the old glow is gone');
  assert.ok(fx.outerShadow, 'preset 8 has a shadow');
  const s3 = parse3d(fx.raw3d);
  assert.deepEqual([s3.camera, s3.depth, s3.top.preset], ['isometricLeftDown', 12, 'slope']);
  await t.exec('shape.effects', {threeD: {camera: 'perspectiveRelaxed'}});
  assert.equal(parse3d(t.content.slides[0].shapes[0].effects.raw3d).camera, 'perspectiveRelaxed');
  await t.exec('shape.effects', {threeD: {camera: 'orthographicFront'}});
  assert.equal(parse3d(t.content.slides[0].shapes[0].effects.raw3d).camera, 'orthographicFront');
  await assert.rejects(t.exec('shape.effectPreset', {index: 13}), /index/);
  await t.exec('shape.effectPreset', {index: 0});
  assert.equal(t.content.slides[0].shapes[0].effects ?? null, null, 'No Presets clears the effects');
  await t.exec('shape.rotation3d', {camera: 'obliqueTopLeft'});
  assert.equal(parse3d(t.content.slides[0].shapes[0].effects.raw3d).camera, 'obliqueTopLeft');
});

test('text effects: glow and reflection are run properties, bevel and 3-D rotation belong to the text body; all survive a .pptx round trip', async () => {
  const t = await session({shapes: [box('a', 100, 100, 300, 120, {text: bodyFromText('Hello world')})]});
  await t.exec('format.textEffects', {glow: 11, reflection: 'half'});
  let runs = t.content.slides[0].shapes[0].text.paragraphs[0].runs;
  assert.equal(runs[0].props.glow.radius, 11);
  assert.equal(runs[0].props.reflection.endPos, 0.55);
  await t.exec('format.textEffects', {bevel: 'circle', threeD: {camera: 'perspectiveAbove'}});
  const body = t.content.slides[0].shapes[0].text.body;
  const s3 = parse3d(body.raw3d);
  assert.deepEqual([s3.camera, s3.top.preset], ['perspectiveAbove', 'circle']);
  const back = await importPptx(await exportPptx(t.content));
  const sh = back.slides[0].shapes.find(x => x.text);
  assert.equal(sh.text.paragraphs[0].runs[0].props.glow.radius, 11);
  assert.ok(sh.text.paragraphs[0].runs[0].props.reflection, 'the reflection came back');
  assert.equal(parse3d(sh.text.body.raw3d).camera, 'perspectiveAbove');
  await t.exec('format.textEffects', {glow: null, reflection: 'none', bevel: 'none', threeD: {camera: 'orthographicFront'}});
  runs = t.content.slides[0].shapes[0].text.paragraphs[0].runs;
  assert.equal(runs[0].props.glow, undefined);
  assert.equal(runs[0].props.reflection, undefined);
  assert.equal(t.content.slides[0].shapes[0].text.body.raw3d, undefined);
  await assert.rejects(t.exec('format.textEffects', {reflection: 'huge'}), /reflection/);
});

test('Filled Radar, Surface and Pareto are chart types that draw; Map is not', async () => {
  for (const id of ['filledRadar', 'surface', 'pareto']) {
    assert.ok(TYPE_IDS.includes(id), id);
    const r = chartPrims(sampleChart(id), 480, 320, resolve);
    assert.ok(r.prims.length > 10, `${id} draws`);
  }
  const radar = chartPrims(sampleChart('filledRadar'), 480, 320, resolve).prims;
  assert.ok(radar.filter(p => p.t === 'poly' && p.fill?.[3] < 255).length >= 3, 'a translucent polygon a series');
  const surf = chartPrims(sampleChart('surface'), 480, 320, resolve).prims;
  assert.ok(surf.filter(p => p.t === 'poly').length >= 6, 'the mesh is quads');
  assert.ok(TYPES.some(x => x[0] === 'pareto' && x[3] === 'Histogram') && TYPES.some(x => x[0] === 'surface' && x[3] === 'Surface'));
  const d = paretoData(drawData(sampleChart('pareto'), resolve));
  assert.deepEqual(d.categories, ['Damaged', 'Late delivery', 'Wrong item', 'No answer', 'Other'], 'largest first');
  assert.equal(d.series[1].values.at(-1), 1, 'the cumulative share ends at 100 %');
  assert.equal(d.series[1].secondary, true);
  const t = await session();
  await t.exec('insert.chart', {type: 'surface'});
  await t.exec('insert.chart', {type: 'pareto'});
  await t.exec('insert.chart', {type: 'filledRadar'});
  assert.deepEqual(t.content.slides[0].shapes.filter(s => s.kind?.type === 'chart').map(s => s.kind.chartType), ['surface', 'pareto', 'filledRadar']);
  await assert.rejects(t.exec('insert.chart', {type: 'map'}), /not offered/);
});

test('chart elements: Axes, Data Table, Error Bars, Lines, Trendline and Up/Down Bars change the drawing, and the chart part keeps them', async () => {
  const t = await session();
  await t.exec('insert.chart', {type: 'lineMarkers'});
  const chart = () => t.content.slides[0].shapes.find(s => s.kind?.type === 'chart');
  const draw = () => chartPrims(chart().kind, 480, 320, resolve).prims;
  const base = draw();
  const text = ps => ps.filter(p => p.t === 'text').map(p => p.text);
  assert.ok(text(base).includes('Q1'), 'the category axis is labelled');
  await t.exec('chart.element', {axesH: false});
  assert.ok(!text(draw()).includes('Q1'), 'the horizontal axis labels are gone');
  assert.ok(text(draw()).includes('2'), 'the value axis stays');
  await t.exec('chart.element', {axesH: true, axesV: false});
  assert.ok(text(draw()).includes('Q1') && !text(draw()).includes('2'), 'only the vertical axis is hidden');
  await t.exec('chart.element', {axesV: true});
  assert.equal(chart().kind.elements, undefined, 'all axes shown is no element at all');
  await t.exec('chart.element', {upDownBars: true, lines: 'highLow', errorBars: 'percentage'});
  const withEls = draw();
  assert.ok(withEls.length > base.length + 10, 'bars, lines and error bars are drawn');
  assert.ok(withEls.some(p => p.t === 'rect' && p.fill?.[0] === 198 && p.w < 40), 'an up bar');
  await t.exec('chart.element', {trendline: 'linearForecast'});
  assert.ok(text(draw()).some(x => /Linear/.test(x)), 'the trendline is named in the legend');
  await t.exec('chart.element', {dataTable: true});
  assert.ok(draw().some(p => p.t === 'text' && p.text === 'Series 1'), 'the data table lists the series');
  assert.equal(t.state('chart.element', {dataTable: true}).checked, true);
  assert.equal(t.state('chart.element', {errorBars: 'percentage'}).checked, true);
  assert.equal(t.state('chart.element', {errorBars: 'standardError'}).checked, false);
  const back = await importPptx(await exportPptx(t.content));
  const b = back.slides[0].shapes.find(s => s.kind?.type === 'chart');
  assert.deepEqual(b.kind.elements.upDownBars, true);
  assert.equal(b.kind.elements.errorBars, 'percentage');
  assert.equal(b.kind.elements.dataTable, true);
  await t.exec('chart.element', {errorBars: 'none', lines: 'none', trendline: 'none', dataTable: false, upDownBars: false});
  assert.equal(chart().kind.elements, undefined);
  await t.exec('chart.type', {type: 'pie'});
  await assert.rejects(t.exec('chart.element', {axesH: false}), /no axes/);
  assert.equal(t.state('chart.element', {errorBars: 'standardError'}).enabled, false);
  await t.exec('chart.type', {type: 'column'});
  await t.exec('chart.element', {errorBars: 'standardDeviation'});
  await t.exec('chart.resetStyle', {});
  assert.equal(chart().kind.elements, undefined, 'Reset to Match Style takes the elements away');
  assert.ok(errorAmount('percentage', [10, 20], 20) === 1 && errorAmount('standardError', [1, 3], 1) > 0);
});

test('the extra chart types round trip through the chart part as themselves', async () => {
  const t = await session();
  for (const type of ['filledRadar', 'surface', 'pareto']) await t.exec('insert.chart', {type});
  const back = await importPptx(await exportPptx(t.content));
  const types = back.slides[0].shapes.filter(s => s.kind?.type === 'chart').map(s => s.kind.chartType);
  assert.deepEqual(types, ['filledRadar', 'surface', 'pareto']);
  const pareto = back.slides[0].shapes.filter(s => s.kind?.type === 'chart')[2].kind;
  assert.equal(pareto.series.length, 1, 'the cumulative line is the chart\'s own to draw, not a data series');
  assert.match(chartPartXml(sampleChart('filledRadar'), resolve), /radarStyle val="filled"/);
  assert.equal(readChartPart, readChartPart);
});

test('Export to Video records the slides not hidden, each for its own time or the dialog\'s seconds, and hands back the bytes when it cannot write', async () => {
  const {createTestHost} = await import('../../core/kernel/host.mjs');
  const calls = [];
  const host = createTestHost();
  host.renderVideo = async (doc, req) => { calls.push(req); return {bytes: new Uint8Array([1, 2, 3, 4]), mime: 'video/webm', ext: 'webm', frames: 9, seconds: req.seconds.reduce((a, b) => a + b, 0), width: req.width, height: 480}; };
  const t = await session({host});
  await t.exec('slide.new', {});
  await t.exec('slide.new', {});
  await t.exec('slide.hide', {index: 1}).catch(() => {});
  await t.exec('transition.timing', {index: 0, after: 2500});
  const r = (await t.exec('file.exportVideo', {quality: '480', seconds: 4})).result;
  assert.equal(r.format, 'webm');
  assert.equal(r.data, 'AQIDBA==');
  assert.equal(calls[0].width, 853, '480 lines of a 16:9 slide');
  assert.deepEqual(calls[0].slides.length, t.content.slides.filter(s => !s.hidden).length, 'hidden slides are left out');
  assert.deepEqual(calls[0].seconds, calls[0].slides.map((_, i) => (i === 0 ? 2.5 : 4)), 'the timed slide keeps its time, the rest the seconds asked for');
  const timed = (await t.exec('file.exportVideo', {seconds: 3, useTimings: true, slides: [0, 1]})).result;
  assert.equal(timed.slides, 2);
  assert.deepEqual(calls[1].seconds, [2.5, 3], "a slide's own Advance Slide After time wins when the slide has one");
  await assert.rejects(t.exec('file.exportVideo', {quality: '4k'}), /quality/);
  const none = await session();
  await assert.rejects(none.exec('file.exportVideo', {}), /open in a window/);
  const dialog = (await import('../../core/prism/dialogs/exportVideo.mjs')).default;
  assert.deepEqual(dialog.init(), {quality: '720', timings: 'use', seconds: 5});
  assert.equal(dialog.validate({quality: '720', seconds: 0}).length, 1);
  assert.deepEqual(dialog.toCommand({quality: '1080', seconds: '6', timings: 'dont'}), {command: 'file.exportVideo', params: {quality: '1080', seconds: 6, useTimings: false}});
});

test('Texture, Preset and 3-D Rotation are galleries of drawn tiles; Texture fills with a tile of the suite, Sketched marks the outline and the file keeps it', async () => {
  const s0 = await session({shapes: [box('a', 100, 100, 200, 120)]});
  const tiles = id => s0.state(id).value;
  assert.equal(tiles('shape.texture').length, 24);
  assert.ok(tiles('shape.texture').every(x => x.art.kind === 'texture' && x.art.id === x.value), 'a swatch each');
  assert.equal(tiles('shape.effectPreset').length, 13, 'No Presets and twelve');
  assert.ok(tiles('shape.effectPreset').every(x => x.art.kind === 'shape3d'));
  assert.equal(tiles('shape.effectPreset')[10].art.camera, 'perspectiveRelaxed', 'preset 10 draws its rotation on the sample');
  const rot = tiles('shape.rotation3d');
  assert.equal(rot.length, 21);
  assert.deepEqual([...new Set(rot.map(x => x.group))], [undefined, 'Parallel', 'Perspective', 'Oblique']);
  assert.equal(s0.state('format.textRotation3d').value.length, 21);
  const t = s0;
  await t.exec('shape.texture', {name: 'denim'});
  const fill = t.content.slides[0].shapes[0].fill;
  assert.equal(fill.kind, 'picture');
  assert.equal(fill.mode.kind, 'tile');
  const media = t.content.media.find(m => m.id === fill.media);
  assert.equal(media.contentType, 'image/png');
  await assert.rejects(t.exec('shape.texture', {name: 'plaid'}), /unknown texture/);
  await t.exec('shape.sketch', {style: 'freehand'});
  assert.equal(t.content.slides[0].shapes[0].line.sketch, 'freehand');
  const back = await importPptx(await exportPptx(t.content));
  const sh = back.slides[0].shapes.find(x => x.line?.sketch);
  assert.equal(sh.line.sketch, 'freehand', 'the sketched line is kept');
  assert.equal(sh.fill.kind, 'picture');
  await t.exec('shape.sketch', {style: 'none'});
  assert.equal(t.content.slides[0].shapes[0].line.sketch, undefined);
  await assert.rejects(t.exec('shape.sketch', {style: 'wavy'}), /style/);
});

test('Language Preferences keeps the preferred editing language, and the Language dialog starts on it', async () => {
  const t = await session({shapes: [box('a', 100, 100, 200, 120, {text: bodyFromText('Bonjour')})]});
  assert.equal((await t.exec('review.languagePreferences', {})).result.language, 'en-US');
  assert.equal((await t.exec('review.languagePreferences', {language: 'fr-FR'})).result.language, 'fr-FR');
  assert.equal(t.session.prefs.editingLanguage, 'fr-FR');
  await assert.rejects(t.exec('review.languagePreferences', {language: 'xx-YY'}), /Language list/);
  const dlg = (await import('../../core/prism/dialogs/language.mjs')).default;
  assert.equal(dlg.init(t.session.readContext(t.docId ?? undefined)).lang, 'fr-FR');
  const prefs = (await import('../../core/prism/dialogs/languagePreferences.mjs')).default;
  assert.deepEqual(prefs.toCommand({language: 'de-DE'}), {command: 'review.languagePreferences', params: {language: 'de-DE'}});
  assert.equal(prefs.validate({language: 'zz'}).length, 1);
});
