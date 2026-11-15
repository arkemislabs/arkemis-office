// U:prism/tool: the ribbon arms the pointer tools through `view.tool`
// (design note F-prism--tool--view-state-contract); nothing is undoable.
//
// 1. What ArtCraft does: deckcraft `Session::set_tool` (crates/engine/src/tools.rs) from the
//    Shapes gallery (a preset or curve/freeform/scribble; double-click locks drawing mode), the
//    Draw tab's pens, highlighter, eraser and Select, and Draw Table / Table Eraser (which toggle
//    off when pressed again, ribbon/table.rs). The next press on the slide draws with that tool.
// 2. Ours: the same tool states in the view; the foundation pointer (core/prism/lib/pointer.mjs)
//    reads them and draws through shape.insert / shape.freeform / insert.table.
// 3. Proved here end to end through `surface.pointer`, and on the ribbon in
//    tests/e2e/prism/insert-shapes.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import {shapesGallery, presetTilePath} from '../../core/prism/commands/tool.mjs';
import {modules as generated} from '../../core/generated/prism.commands.mjs';
import surface from '../../src/apps/prism/ui-commands/surface.ts';

async function session() {
  const c = createContent('Tools');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = [newSlide({id: 's1', layout})];
  return createTestSession('prism', {content: c, modules: [...generated, surface], selection: {ranges: [{anchor: '/sl:s1', focus: '/sl:s1'}], primary: 0},
    prefs: {prism: {snapToGrid: false, smartGuides: false}}});
}
const ev = (kind, x, y) => ({kind, x, y});

test('tool.shape arms a preset; the next drag draws it once, then the tool is Select again', async () => {
  const t = await session();
  const v = t.version;
  await t.exec('tool.shape', {preset: 'ellipse'});
  assert.equal(t.version, v, 'arming a tool changes no document');
  assert.deepEqual(t.doc.view.tool, {kind: 'shape', preset: 'ellipse'});
  assert.equal(t.state('tool.shape', {}).checked, true);
  assert.equal(t.state('tool.select', {}).checked, false);
  await t.exec('surface.pointer', {events: [ev('down', 100, 100), ev('drag', 200, 160), ev('up', 200, 160)], tol: 3});
  const s = t.content.slides[0].shapes.at(-1);
  assert.deepEqual(s.geom, {kind: 'preset', name: 'ellipse'});
  assert.deepEqual(s.xfrm, {x: 100, y: 100, w: 100, h: 60});
  assert.equal(t.doc.view.tool?.kind ?? 'select', 'select');
});

test('a locked drawing mode (sticky) keeps the tool; Select disarms it', async () => {
  const t = await session();
  await t.exec('tool.shape', {preset: 'rect', sticky: true});
  assert.deepEqual(t.doc.view.tool, {kind: 'shape', preset: 'rect', sticky: true});
  await t.exec('tool.select', {});
  assert.deepEqual(t.doc.view.tool, {kind: 'select'});
  assert.equal(t.state('tool.select', {}).checked, true);
  await assert.rejects(t.exec('tool.shape', {preset: 'blob'}), /unknown preset `blob`/);
  await t.exec('tool.shape', {preset: 'scribble'});
  assert.equal(t.doc.view.tool.preset, 'scribble');
});

test('pens, highlighter and eraser carry colour and width; the pen button shows checked', async () => {
  const t = await session();
  await t.exec('tool.ink', {mode: 'pen', color: '#D83F3F', width: 1.5});
  assert.deepEqual(t.doc.view.tool, {kind: 'ink', mode: 'pen', color: {r: 0xd8, g: 0x3f, b: 0x3f, a: 255}, width: 1.5});
  assert.equal(t.state('tool.ink', {mode: 'pen', color: '#D83F3F', width: 1.5}).checked, true);
  assert.equal(t.state('tool.ink', {mode: 'pen', color: '#2E6FD8', width: 1.5}).checked, false);
  await t.exec('tool.ink', {mode: 'eraser'});
  assert.equal(t.state('tool.ink', {mode: 'eraser'}).checked, true);
  await assert.rejects(t.exec('tool.ink', {mode: 'pen', color: 'nope'}), /`color` must be/);
});

test('Draw Table and Table Eraser toggle off when pressed again', async () => {
  const t = await session();
  await t.exec('tool.drawTable', {});
  assert.deepEqual(t.doc.view.tool, {kind: 'shape', preset: 'drawTable', sticky: true});
  assert.equal(t.state('tool.drawTable', {}).checked, true);
  await t.exec('tool.drawTable', {});
  assert.deepEqual(t.doc.view.tool, {kind: 'select'});
  await t.exec('tool.tableEraser', {});
  assert.equal(t.doc.view.tool.preset, 'tableEraser');
  await t.exec('tool.tableEraser', {});
  assert.deepEqual(t.doc.view.tool, {kind: 'select'});
});

test('the Shapes gallery lists every preset by category, the freeform tools after the lines', () => {
  const g = shapesGallery();
  const names = g.map(i => i.value);
  const lastLine = g.findLastIndex(i => i.group === 'Lines');
  assert.deepEqual(names.slice(lastLine - 2, lastLine + 1), ['curve', 'freeform', 'scribble']);
  assert.ok(g.find(i => i.value === 'star5').path.startsWith('M'));
  assert.equal(presetTilePath('line'), 'M0 0 L20 20');
});
