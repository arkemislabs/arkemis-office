// Prism controls that had no engine, through the real window (docs/spec/patches/prism/rest-prism.json): View > Black and White and
// Move Split; the Draw tab's Add Pen and Ruler (ink along the ruler's edge runs straight); the Eyedropper (the colour is read from the slide
// as the app draws it); Shape Effects > Preset and 3-D Rotation and the text effects; the Filled Radar, Surface and Pareto charts and the
// chart elements; Set Up Show's pen and laser colours and the pen, laser pointer and keep-ink question of a running show.
// deckcraft draws the show's pen and laser pointer; the rest is PowerPoint's behaviour, not checked against upstream.
// Captures in artifacts/e2e/prism/rest-controls/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';
import {bodyFromText} from '../../../core/prism/model/text.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rgb = (id, name, [x, y, w, h], c, extra = {}) => shape({id, name, xfrm: {x, y, w, h}, geom: presetGeom('rect'), fill: fillSolid(colorRgb({r: c[0], g: c[1], b: c[2], a: 255})), ...extra});

test('prism rest controls: view, draw, eyedropper, effects, charts, show pointers', {timeout: 900_000}, async () => {
  const file = createFile('prism', 'Rest controls', {schema: 2});
  file.id = 'prism-rest-controls';
  const c = file.content;
  const blank = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides[0].layout = blank;
  c.slides[0].shapes = [
    rgb('a', 'Pick me', [80, 90, 240, 130], [68, 114, 196], {text: bodyFromText('Pick me')}),
    rgb('b', 'Red', [380, 90, 200, 130], [216, 63, 63]),
    rgb('c', 'Glow words', [80, 300, 480, 110], [237, 125, 49], {text: bodyFromText('Quarterly results')}),
  ];
  c.nextId = 600;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/rest-controls', files: [file], renderer});
  const doc = file.id;
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  const run = (command, params = {}) => app.rpc('engine.execute', {doc, command, params});
  const deck = async () => (await app.rpc('document.read', {doc, address: '/', as: 'json'})).value;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const activate = (control, extra = {}) => app.rpc('ui.activate', {doc, control, ...extra});
  const pick = async ids => { const d = await deck(); const s = d.slides[0].id; await app.rpc('selection.set', {doc, ranges: ids.map(id => ({anchor: `/sl:${s}/sp:${id}`, focus: `/sl:${s}/sp:${id}`}))}); };
  const sp = (d, id, slide = 0) => d.slides[slide].shapes.find(x => x.id === id);
  const control = async id => (await inspect()).controls.find(x => x.id === id);
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});

    // ---- View: Black and White, Move Split ----
    await app.rpc('ui.tab', {doc, tab: 'view'});
    for (const id of ['view.color.black-white', 'view.window.cascade', 'view.window.move-split']) assert.ok(await control(id), `${id} is on the View tab`);
    await app.capture('1-view-tab');
    await activate('view.color.black-white');
    await sleep(500);
    assert.equal((await control('view.color.black-white')).checked, true);
    await app.capture('2-black-and-white');
    await activate('view.color.grayscale');
    assert.equal((await control('view.color.black-white')).checked, false, 'Grayscale takes Black and White off');
    await activate('view.color.color');
    await activate('view.window.move-split');
    assert.equal((await run('view.moveSplit', {dx: 70})).ok !== false, true);
    await sleep(400);
    await app.capture('3-move-split');
    await run('view.moveSplit', {end: true});

    // ---- Draw: Add Pen, the gallery, the Ruler with ink along its edge ----
    await app.rpc('ui.tab', {doc, tab: 'draw'});
    for (const id of ['draw.pens.add-pen', 'draw.pens.gallery', 'draw.stencils.ruler']) assert.ok(await control(id), `${id} is on the Draw tab`);
    await activate('draw.pens.add-pen.highlighter');
    await activate('draw.pens.add-pen.pen');
    await run('draw.addPen', {kind: 'pen', color: '#00B050', width: 3});
    assert.equal((await run('draw.usePen', {index: 2})).result.pen.color, '00B050', 'three pens are in the gallery');
    let ui = await inspect();
    await activate('draw.stencils.ruler');
    await run('draw.ruler', {x: 120, y: 400, angle: 8});
    await run('tool.ink', {mode: 'pen', color: '#C00000', width: 3});
    const drag = pts => pts.map(([x, y], i) => ({kind: i === 0 ? 'down' : 'drag', x, y})).concat({kind: 'up', x: pts.at(-1)[0], y: pts.at(-1)[1]});
    await app.rpc('ui.pointer', {doc, events: drag([[160, 398], [260, 372], [380, 412], [520, 384], [640, 402]])});
    await app.rpc('ui.pointer', {doc, events: drag([[160, 470], [300, 450], [420, 475], [560, 455]])});
    let d = await deck();
    const ink = d.slides[0].shapes.find(x => x.kind?.type === 'ink');
    assert.ok(ink && ink.kind.strokes.length === 2, 'two strokes');
    const edgeY = x => 400 + (x - 120) * Math.tan((8 * Math.PI) / 180);
    assert.ok(ink.kind.strokes[0].points.every(([x, y]) => Math.abs(y - edgeY(x)) < 0.5), 'the first stroke runs along the ruler');
    assert.ok(ink.kind.strokes[1].points.some(([x, y]) => Math.abs(y - edgeY(x)) > 10), 'the second, drawn away from it, is free');
    await sleep(500);
    await app.capture('4-draw-ruler-ink');
    await run('tool.select');
    await run('draw.ruler', {on: false});

    // ---- Eyedropper: the colour under the click, read from the slide as drawn ----
    await pick(['c']);
    await app.rpc('ui.tab', {doc, tab: 'home'});
    await app.rpc('ui.menu', {doc, control: 'home.font.color'});
    await sleep(500);
    await app.capture('5a-font-color-eyedropper');
    await app.rpc('ui.menu', {doc, control: 'home.font.color', open: false});
    // The ribbon's Eyedropper (Font Color): the click on the red shape makes the text of the selected shape red.
    await activate('home.font.color.eyedropper');
    assert.equal((await run('tool.eyedropper', {target: 'text'})).result.armed, false, 'it was armed by the ribbon (a second ask puts it away)');
    await activate('home.font.color.eyedropper');
    await app.rpc('ui.pointer', {doc, events: [{kind: 'down', x: 480, y: 150}, {kind: 'up', x: 480, y: 150}]});
    await app.until(async () => { const dd = await deck(); const f = sp(dd, 'c').text.paragraphs[0].runs[0].props?.fill; return f?.color?.base?.rgb?.r === 216 ? f : null; }, {timeout: 20_000, message: 'the text took the red under the click'});
    await pick(['a']);
    await run('tool.eyedropper', {target: 'fill'});
    await app.rpc('ui.pointer', {doc, events: [{kind: 'down', x: 480, y: 150}, {kind: 'up', x: 480, y: 150}]});
    await app.until(async () => { const dd = await deck(); const f = sp(dd, 'a').fill; return f?.color?.base?.rgb?.r === 216 ? f : null; }, {timeout: 20_000, message: 'the fill took the red under the click'});
    d = await deck();
    assert.deepEqual(sp(d, 'a').fill.color.base.rgb, {r: 216, g: 63, b: 63, a: 255});
    assert.equal(d.slides[0].shapes.filter(x => x.id === 'a').length, 1);
    await app.capture('5-eyedropper-picked');

    // ---- Effects: Preset, 3-D Rotation, the text effects ----
    await pick(['b']);
    await app.rpc('ui.tab', {doc, tab: 'shape-format'});
    for (const id of ['shapeformat.styles.effects', 'shapeformat.wordart.text-effects']) assert.ok(await control(id), `${id} is on Shape Format`);
    await app.rpc('ui.menu', {doc, control: 'shapeformat.styles.effects'});
    await sleep(500);
    await app.capture('6-shape-effects-menu');
    await app.rpc('ui.menu', {doc, control: 'shapeformat.styles.effects', open: false});
    await app.rpc('ui.menu', {doc, control: 'shapeformat.styles.effects.preset'});
    await sleep(500);
    await app.capture('6a-preset-gallery');
    await app.rpc('ui.menu', {doc, control: 'shapeformat.styles.effects.preset', open: false});
    await activate('shapeformat.styles.effects.preset', {value: 9});
    d = await deck();
    assert.match(sp(d, 'b').effects.raw3d, /isometricRightUp/);
    await pick(['a']);
    await app.rpc('ui.menu', {doc, control: 'shapeformat.styles.effects.3-d-rotation'});
    await sleep(500);
    await app.capture('6b-3d-rotation-gallery');
    await app.rpc('ui.menu', {doc, control: 'shapeformat.styles.effects.3-d-rotation', open: false});
    await activate('shapeformat.styles.effects.3-d-rotation', {value: 'isometricLeftDown'});
    d = await deck();
    assert.match(sp(d, 'a').effects.raw3d, /isometricLeftDown/);
    await run('shape.effects', {threeD: {depth: 16}});
    await pick(['c']);
    await run('format.textEffects', {glow: 11, reflection: 'half', bevel: 'circle'});
    await run('shape.effects', {threeD: {camera: 'perspectiveAbove'}});
    await sleep(700);
    await app.capture('7-effects-on-the-slide');
    d = await deck();
    assert.equal(sp(d, 'c').text.paragraphs[0].runs[0].props.glow.radius, 11);
    await app.rpc('ui.menu', {doc, control: 'shapeformat.wordart.text-effects'});
    await sleep(400);
    await app.capture('8-text-effects-menu');
    await app.rpc('ui.menu', {doc, control: 'shapeformat.wordart.text-effects', open: false});

    // ---- Charts: each new type on its own slide, then the chart elements ----
    const oneChart = async (type, name) => {
      await run('slide.new', {layout: 'blank'});
      const n = (await deck()).slides.length - 1;
      await run('slide.go', {index: n});
      const id = (await run('insert.chart', {type, rect: [60, 40, 840, 460]})).result.id;
      await sleep(700);
      await app.capture(name);
      return {id, slide: n};
    };
    const surface = await oneChart('surface', '9a-surface-chart');
    const radar = await oneChart('filledRadar', '9b-filled-radar-chart');
    const pareto = await oneChart('pareto', '9c-pareto-chart');
    const line = await oneChart('lineMarkers', '9d-line-chart');
    await pick2(line.id, line.slide);
    await run('chart.element', {trendline: 'linear', upDownBars: true, lines: 'highLow', errorBars: 'percentage', id: line.id});
    await sleep(900);
    await app.capture('9e-line-chart-with-elements');
    await pick2(line.id, line.slide);
    await app.rpc('ui.tab', {doc, tab: 'chart-design'});
    await app.rpc('ui.menu', {doc, control: 'chartdesign.layouts.add-element'});
    await sleep(500);
    await app.capture('10-add-chart-element-menu');
    await app.rpc('ui.menu', {doc, control: 'chartdesign.layouts.add-element', open: false});
    await run('chart.element', {dataTable: true, axesV: false, id: line.id});
    await run('chart.element', {errorBars: 'none', lines: 'none', upDownBars: false, trendline: 'none', id: line.id});
    await sleep(700);
    await app.capture('11-data-table-no-value-axis');
    d = await deck();
    assert.equal(sp(d, pareto.id, pareto.slide).kind.chartType, 'pareto');
    assert.deepEqual([surface.slide, radar.slide].map(i => d.slides[i].shapes.filter(x => x.kind?.type === 'chart').length), [1, 1], 'one chart on each slide');
    // ---- Texture and Sketched outlines, Language Preferences ----
    let dlg;
    await run('slide.new', {layout: 'blank'});
    const texSlide = (await deck()).slides.length - 1;
    await run('slide.go', {index: texSlide});
    const tex = [];
    for (const [i, name] of ['green-marble', 'oak', 'denim', 'granite'].entries()) {
      const id = (await run('shape.insert', {preset: 'roundRect', rect: [60 + i * 225, 90, 195, 160]})).result.id;
      tex.push(id);
      await pick3(id);
      await activate('shapeformat.styles.fill.texture', {value: name});
    }
    for (const [i, style] of ['curved', 'freehand', 'scribble', 'none'].entries()) {
      const id = (await run('shape.insert', {preset: i % 2 ? 'ellipse' : 'rect', rect: [60 + i * 225, 300, 195, 150]})).result.id;
      await pick3(id);
      await run('shape.line', {width: 3, color: '#1F3864'});
      await activate(`shapeformat.styles.outline.sketched.${style}`);
    }
    await pick3(tex[0]);
    await app.rpc('ui.menu', {doc, control: 'shapeformat.styles.fill.texture'});
    await sleep(600);
    await app.capture('12c-texture-gallery');
    await app.rpc('ui.menu', {doc, control: 'shapeformat.styles.fill.texture', open: false});
    await sleep(900);
    await app.capture('12a-textures-and-sketched-outlines');
    d = await deck();
    assert.equal(sp(d, tex[0], texSlide).fill.kind, 'picture');
    assert.equal(sp(d, tex[0], texSlide).fill.mode.kind, 'tile');
    assert.deepEqual(d.slides[texSlide].shapes.slice(4).map(x => x.line.sketch ?? null), ['curved', 'freehand', 'scribble', null]);
    await app.rpc('ui.tab', {doc, tab: 'review'});
    await activate('review.language.language.language-preferences');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.languagePreferences');
    await app.rpc('ui.dialog.set', {field: 'language', value: 'fr-FR'});
    await sleep(400);
    await app.capture('12b-language-preferences');
    await app.rpc('ui.dialog.submit', {});
    assert.equal((await run('review.languagePreferences', {})).result.language, 'fr-FR');
    await run('slide.go', {index: 0});

    // ---- Set Up Show: the colours; the show's pen, laser pointer and ink ----
    await app.rpc('ui.tab', {doc, tab: 'slide-show'});
    await activate('slideshow.setup.setup');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.setupShow');
    assert.ok('penColor' in dlg.values && 'laserColor' in dlg.values, 'the dialog carries the pen and laser colours');
    await app.rpc('ui.dialog.set', {field: 'penColor', value: '#0070C0'});
    await app.rpc('ui.dialog.set', {field: 'laserColor', value: '#00B050'});
    await sleep(400);
    await app.capture('12-set-up-show-colours');
    await app.rpc('ui.dialog.submit', {});
    d = await deck();
    assert.deepEqual([d.show.penColor, d.show.laserColor].map(x => [x.r, x.g, x.b]), [[0, 112, 192], [0, 176, 80]]);

    await run('show.fromStart');
    await app.until(async () => ((await run('show.status')).result?.slide === 0 ? true : null), {timeout: 20_000});
    await run('show.pen');
    await run('show.stroke', {points: [[100, 80], [180, 120], [260, 70], [340, 130], [420, 90]]});
    await run('show.stroke', {points: [[100, 440], [500, 440]], highlighter: true});
    await run('show.laser', {x: 640, y: 250});
    await sleep(600);
    let st = (await run('show.status')).result;
    assert.equal(st.pointer, 'laser');
    assert.equal(st.ink, 2);
    await app.capture('13-show-laser-and-ink');
    await run('show.pen');
    await run('show.pointerOptions');
    await sleep(500);
    await app.capture('14-show-pointer-menu');
    await run('show.pointerOptions');
    await run('show.end');
    await sleep(500);
    d = await deck();
    assert.equal(d.slides[0].shapes.find(x => x.kind?.type === 'ink').kind.strokes.length, 2, 'End Show discards the ink drawn in the show (the two ruler strokes stay)');

    await run('show.fromStart');
    await app.until(async () => ((await run('show.status')).result?.slide === 0 ? true : null), {timeout: 20_000});
    await run('show.pen');
    await run('show.stroke', {points: [[100, 80], [260, 150], [420, 90]]});
    await run('show.stroke', {points: [[100, 440], [500, 440]], highlighter: true});
    await sleep(400);
    // Esc of the keyboard asks "Do you want to keep your ink annotations?": the same ask the stage makes on its own end.
    await run('show.keepInk', {ask: true});
    await sleep(500);
    assert.equal((await run('show.status')).result.keepAsk, true, 'the end of a show with ink asks');
    await app.capture('15-keep-ink-question');
    await run('show.keepInk', {});
    await app.until(async () => { const dd = await deck(); const k = dd.slides[0].shapes.find(x => x.kind?.type === 'ink'); return k && k.kind.strokes.length === 4 ? true : null; }, {timeout: 15_000, message: 'the kept ink joined the slide'});
    await sleep(600);
    await app.capture('16-ink-kept-on-the-slide');

    // ---- Export to Video: the dialog, then a recording from the app's own canvas ----
    await app.rpc('ui.tab', {doc, tab: 'record'});
    await activate('record.save.export-video');
    dlg = await app.rpc('ui.dialog.get', {});
    assert.equal(dlg.id, 'dialog.exportVideo');
    assert.deepEqual(dlg.values.quality, '720');
    await app.rpc('ui.dialog.set', {field: 'timings', value: 'dont'});
    await app.rpc('ui.dialog.set', {field: 'seconds', value: 2});
    await sleep(400);
    await app.capture('17-export-to-video-dialog');
    await app.rpc('ui.dialog.cancel', {});
    const v = (await run('file.exportVideo', {quality: '480', seconds: 1, useTimings: false, slides: [0, 1]})).result;
    assert.ok(['mp4', 'webm'].includes(v.format), 'a video format: ' + v.format);
    assert.ok(v.bytes > 3000 && typeof v.data === 'string' && v.data.length > 4000, 'the recording has bytes: ' + v.bytes);
    assert.deepEqual([v.slides, v.height], [2, 480]);
    assert.ok(Math.abs(v.seconds - 2) < 0.01);
  } finally {
    await app.close();
  }

  async function pick3(id) {
    const d = await deck();
    const s = d.slides.at(-1).id;
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s}/sp:${id}`, focus: `/sl:${s}/sp:${id}`}]});
  }
  async function pick2(id, slide) {
    const d = await deck();
    const s = d.slides[slide].id;
    await app.rpc('selection.set', {doc, ranges: [{anchor: `/sl:${s}/sp:${id}`, focus: `/sl:${s}/sp:${id}`}]});
  }
});
