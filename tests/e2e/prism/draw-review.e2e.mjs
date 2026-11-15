// Prism Draw > Lasso Select and Review > Hide Ink through the bridge (U:prism/draw, U:prism/review): the Draw tab's Lasso
// toggle arms the tool, a loop drawn with the pointer selects what is inside it, Hide Ink takes the ink off the
// slide and the slide list. Captures in artifacts/e2e/prism/draw-review/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';

test('prism draw and review: lasso select a loop, hide the ink', {timeout: 600_000}, async () => {
  const file = createFile('prism', 'Lasso deck', {schema: 2});
  file.id = 'prism-draw-review';
  const c = file.content;
  c.slides[0].layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const sid = c.slides[0].id;
  c.slides[0].shapes = [
    shape({id: 'a', name: 'Rectangle 1', xfrm: {x: 120, y: 140, w: 120, h: 80}, geom: presetGeom('rect'), fill: fillSolid(colorRgb({r: 68, g: 114, b: 196, a: 255}))}),
    shape({id: 'b', name: 'Rectangle 2', xfrm: {x: 300, y: 140, w: 120, h: 80}, geom: presetGeom('rect'), fill: fillSolid(colorRgb({r: 237, g: 125, b: 49, a: 255}))}),
    shape({id: 'far', name: 'Rectangle 3', xfrm: {x: 600, y: 360, w: 120, h: 80}, geom: presetGeom('rect')}),
    shape({id: 'ink', name: 'Ink 4', xfrm: {x: 480, y: 120, w: 200, h: 120}, kind: {type: 'ink', strokes: [{points: [[10, 10, 0.5], [60, 80, 0.5], [120, 20, 0.5], [180, 100, 0.5]], color: {r: 200, g: 0, b: 0, a: 255}, width: 4, highlighter: false}]}}),
  ];
  c.nextId = 400;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'prism', flow: 'prism/draw-review', files: [file], renderer});
  const doc = file.id;
  const sel = async () => (await app.rpc('selection.get', {doc})).selection.ranges.map(r => r.anchor.split('/sp:')[1]).filter(Boolean);
  const loop = pts => pts.map(([x, y], i) => ({kind: i === 0 ? 'down' : 'drag', x, y})).concat({kind: 'up', x: pts.at(-1)[0], y: pts.at(-1)[1]});
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000});
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc ? ui : null; }, {timeout: 45_000});
    await app.rpc('ui.tab', {doc, tab: 'draw'});
    await app.rpc('ui.activate', {doc, control: 'draw.tools.lasso'});
    await app.rpc('ui.pointer', {doc, events: loop([[100, 110], [450, 110], [450, 250], [100, 250]])});
    assert.deepEqual(await sel(), ['a', 'b']);
    await app.capture('1-lassoed');
    await app.rpc('ui.activate', {doc, control: 'draw.tools.select'});
    await app.rpc('ui.tab', {doc, tab: 'review'});
    await app.capture('2-ink-shown');
    await app.rpc('ui.activate', {doc, control: 'review.ink.hide'});
    await app.capture('3-ink-hidden');
    await app.rpc('ui.activate', {doc, control: 'review.ink.hide'});
  } finally {
    await app.close();
  }
});
