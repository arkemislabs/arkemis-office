// U:prism/draw: Lasso Select (PowerPoint's; deckcraft's Select button only carries its icon, not checked against
// upstream): a loop drawn through the pointer selects the objects whose centre is inside it and the ink with a point
// inside it; the tool stays on; Select turns it off.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {shape, presetGeom, slide as newSlideObj} from '../../core/prism/model/presentation.mjs';
import surface from '../../src/apps/prism/ui-commands/surface.ts';
import tool from '../../core/prism/commands/tool.mjs';

function deck() {
  const c = createContent('Lasso');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const box = (id, x, y) => shape({id, name: id, xfrm: {x, y, w: 60, h: 40}, geom: presetGeom('rect')});
  const ink = shape({id: 'ink', name: 'Ink', xfrm: {x: 400, y: 100, w: 100, h: 100}, kind: {type: 'ink', strokes: [{points: [[10, 10, 0.5], [50, 50, 0.5]], color: {r: 0, g: 0, b: 0, a: 255}, width: 2, highlighter: false}]}});
  c.slides = [newSlideObj({id: 'sb', layout, shapes: [box('a', 100, 100), box('b', 200, 100), box('far', 600, 400), ink]})];
  return c;
}
const ev = (kind, x, y) => ({kind, x, y});
const loop = pts => pts.map(([x, y], i) => ev(i === 0 ? 'down' : 'drag', x, y)).concat(ev('up', pts.at(-1)[0], pts.at(-1)[1]));
const selected = t => t.doc.selection.ranges.map(r => r.anchor.split('/sp:')[1]).filter(Boolean);

test('Lasso Select: a loop selects what is inside it, ink by a point, and the tool stays on until Select', async () => {
  const t = await createTestSession('prism', {content: deck(), modules: [surface, tool], prefs: {prism: {snapToGrid: false, smartGuides: false}},
    selection: {ranges: [{anchor: '/sl:sb', focus: '/sl:sb'}], primary: 0}});
  await t.exec('tool.lasso', {});
  assert.equal(t.doc.view.tool.kind, 'lasso');
  assert.equal((await t.state('tool.lasso')).checked, true);
  assert.equal((await t.state('tool.select')).checked, false);
  // Around a and b (centres (130, 120) and (230, 120)) and the ink's stroke start (410, 110).
  await t.exec('surface.pointer', {events: loop([[80, 80], [300, 80], [300, 160], [80, 160]])});
  assert.deepEqual(selected(t), ['a', 'b']);
  await t.exec('surface.pointer', {events: loop([[380, 90], [440, 90], [440, 140], [380, 140]])});
  assert.deepEqual(selected(t), ['ink']);
  await t.exec('surface.pointer', {events: loop([[10, 400], [40, 400], [40, 430]])});
  assert.deepEqual(selected(t), [], 'a loop around nothing selects nothing');
  assert.equal(t.doc.view.tool.kind, 'lasso', 'the tool stays on');
  await t.exec('tool.select', {});
  assert.equal(t.doc.view.tool?.kind ?? 'select', 'select');
  await t.exec('tool.lasso', {});
  await t.exec('tool.lasso', {});
  assert.equal(t.doc.view.tool?.kind ?? 'select', 'select', 'the same press again turns it off');
});
