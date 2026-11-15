// U:slate/draw: OneNote's Draw tab (Tools, Pens, Shapes, Edit, Convert).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. Upstream: Slate has no ArtCraft source; docs/spec/slate.json `draw.*`, `ink.*`, `shape.*`,
//    `object.*` and `edit.delete` name the commands; OneNote's behaviour: Type / Lasso / Eraser /
//    Panning Hand are page tools; the pen tray holds four 0.5 mm pens, a 1 mm pencil, galaxy and
//    rainbow pens and three 6 mm highlighters, Add Pen adds one, Remove Pen takes the selected one
//    out, Color & Thickness changes it; the stroke eraser takes whole strokes, the small, medium and
//    large erasers rub out parts; the Lasso selects ink (and a shape's strokes together), which can
//    be moved, rotated, flipped, ordered and deleted; a shape from the gallery is drawn by dragging,
//    in the current pen; Ink to Shape turns a hand-drawn line, triangle, rectangle, diamond or oval
//    into the shape; Ink Replay plays the strokes again in order.
// 2. Ours does the same on the page's ink records (`pages[id].ink`), one undo entry each, and the
//    ink saves with the notebook and reads back (the round-trip test below).
// 3. Proof: these tests and tests/e2e/slate/draw.e2e.mjs (the bridge draws every stroke; captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import penDialog from '../../core/slate/dialogs/pen-color-thickness.mjs';
import {DEFAULT_PENS, MM, erasePoints, lassoHits, rotated, flipped, moved, boundsOf} from '../../core/slate/lib/ink.mjs';
import {SHAPES, recognize, shapePolylines} from '../../core/slate/lib/shapes.mjs';
import {loadNotebook, writeNotebook} from '../../core/slate/lib/notebook-folder.mjs';
import {textSession, textSel} from './format-helpers.mjs';

const pen = (points, o = {}) => ({tool: 'pen', color: '#000000', width: 1.9, points, ...o});
const ink = t => t.content.pages[t.pageId].ink;
const sel = t => t.doc.selection.ranges.map(r => r.anchor.replace(/^.*ink:/, ''));
const draw = async (t, points, o) => (await t.exec('surface.ink', {page: t.pageId, stroke: pen(points, o)})).result.stroke.replace(/^.*ink:/, '');
const session = () => textSession(['Notes'], {selection: p => textSel(p, 'b1', 0)});
const view = t => t.doc.view ?? {};

test('draw.tool sets the page tool: type, lasso, eraser sizes, pan and the pen last used', async () => {
  const t = await session();
  assert.deepEqual(t.state('draw.tool', {tool: 'type'}), {enabled: true, checked: true});
  await t.exec('draw.tool', {tool: 'lasso'});
  assert.equal(view(t).ink.tool, 'lasso');
  assert.equal(t.state('draw.tool', {tool: 'lasso'}).checked, true);
  assert.equal(t.state('draw.tool', {tool: 'type'}).checked, false);
  await t.exec('draw.tool', {tool: 'eraser', size: 'small'});
  assert.deepEqual(view(t).ink, {tool: 'eraser', eraser: 'small'});
  assert.equal(t.state('draw.tool', {tool: 'eraser', size: 'small'}).checked, true);
  assert.equal(t.state('draw.tool', {tool: 'eraser', size: 'large'}).checked, false);
  await t.exec('draw.tool', {tool: 'eraser'});
  assert.equal(view(t).ink.eraser, 'medium');
  await t.exec('draw.tool', {tool: 'pan'});
  assert.equal(view(t).ink.tool, 'pan');
  // Pen: the black pen first, then whichever pen was picked last.
  await t.exec('draw.tool', {tool: 'pen'});
  assert.equal(view(t).ink.penId, 'black-pen');
  await t.exec('ink.selectPen', {penId: 'red-pen'});
  await t.exec('draw.tool', {tool: 'lasso'});
  await t.exec('draw.tool', {tool: 'pen'});
  assert.equal(view(t).ink.penId, 'red-pen');
  await t.exec('draw.tool', {tool: 'type'});
  assert.equal(view(t).ink, null);
  // Insert Space and a pen exclude each other (one page tool at a time).
  await t.exec('insert.space', {});
  await t.exec('ink.selectPen', {penId: 'blue-pen'});
  assert.equal(view(t).insertSpace, false);
});

test('the pen tray: OneNote\'s ten pens, selecting one, the gallery state, Add Pen, Remove Pen, Color & Thickness', async () => {
  const t = await session();
  const gallery = t.state('ink.selectPen').value;
  assert.deepEqual(gallery.map(g => g.id), DEFAULT_PENS.map(p => p.id));
  assert.deepEqual(gallery.map(g => g.label).slice(0, 5), ['Black Pen (0.5 mm)', 'Blue Pen (0.5 mm)', 'Red Pen (0.5 mm)', 'Green Pen (0.5 mm)', 'Pencil (1 mm)']);
  assert.ok(gallery.every(g => g.icon && g.iconOnly), 'every pen is a drawn icon');
  assert.equal(DEFAULT_PENS.filter(p => p.type === 'highlighter').length, 3);
  assert.equal(DEFAULT_PENS.find(p => p.id === 'pencil').width, Math.round(MM * 100) / 100);
  await t.exec('ink.selectPen', {value: 'green-highlighter'});
  assert.deepEqual([view(t).ink.tool, view(t).ink.color, view(t).ink.width], ['highlighter', '#92d050', 22.68]);
  assert.equal(t.state('ink.selectPen', {penId: 'green-highlighter'}).checked, true);
  assert.equal(t.state('ink.selectPen').value.find(g => g.id === 'green-highlighter').selected, true);
  await assert.rejects(t.exec('ink.selectPen', {penId: 'nope'}), /No pen/);
  // Add Pen: a pen of the type with its usual look, picked; the tray keeps it.
  const added = (await t.exec('ink.addPen', {type: 'pencil'})).result;
  assert.equal(view(t).ink.penId, added.pen);
  assert.equal(view(t).ink.tool, 'pencil');
  const tray = t.state('ink.selectPen').value;
  assert.equal(tray.length, 11);
  assert.equal(tray.at(-1).label, 'Pencil (1 mm)');
  // Color & Thickness changes the pen in hand and the page's tool follows.
  await t.exec('ink.penSettings', {type: 'highlighter', thickness: 3.5, color: '#FF66CC'});
  assert.deepEqual([view(t).ink.tool, view(t).ink.color, view(t).ink.width], ['highlighter', '#ff66cc', Math.round(3.5 * MM * 100) / 100]);
  assert.equal(t.state('ink.selectPen').value.at(-1).label, 'Highlighter (3.5 mm)');
  await t.exec('ink.penSettings', {fx: 'rainbow'});
  assert.equal(view(t).ink.fx, 'rainbow');
  // Remove Pen takes the selected pen out and the next one takes over; the last pen stays.
  await t.exec('ink.removePen', {});
  assert.equal(t.state('ink.selectPen').value.length, 10);
  assert.equal(view(t).ink.penId, 'pink-highlighter');
  await t.exec('ink.removePen', {penId: 'galaxy-pen'});
  assert.equal(t.state('ink.selectPen').value.some(p => p.id === 'galaxy-pen'), false);
  await assert.rejects(t.exec('ink.penSettings', {penId: 'zz'}), /No pen/);
  await t.exec('draw.tool', {tool: 'type'});
  assert.equal(t.state('ink.removePen').enabled, false);
});

test('dialog.pen-color-thickness: the pen\'s type, thickness and colour; swatches and Galaxy / Rainbow inks', async () => {
  const t = await session();
  await t.exec('ink.selectPen', {penId: 'blue-pen'});
  const ctx = t.session.readContext(t.docId);
  const init = penDialog.init(ctx);
  assert.deepEqual([init.penType, init.thickness, init.color, init.customColor], ['Pen', '0.5 mm', 'Blue', '#0070c0']);
  let v = {...init, color: 'Red'};
  v = {...v, ...penDialog.derive(v, ['color'])};
  assert.equal(v.customColor, '#ff0000');
  v = {...v, penType: 'Highlighter', thickness: '6 mm'};
  assert.deepEqual(penDialog.toCommand(v), {command: 'ink.penSettings', params: {penId: 'blue-pen', type: 'highlighter', thickness: 6, color: '#ff0000', fx: null}});
  assert.equal(penDialog.toCommand({...v, color: 'Rainbow'}).params.fx, 'rainbow');
  assert.equal(penDialog.toCommand({...v, color: null, customColor: '#123456'}).params.color, '#123456');
  assert.equal(penDialog.validate({...v, penId: null})[0].field, 'penType');
  v = {...v, customColor: '#00b050'};
  assert.equal(penDialog.derive(v, ['customColor']).color, 'Green');
  await t.exec('ink.penSettings', penDialog.toCommand(v).params);
  assert.equal(view(t).ink.type ?? view(t).ink.tool, 'highlighter');
  // No pen in hand: nothing to change.
  await t.exec('draw.tool', {tool: 'type'});
  assert.equal(penDialog.validate(penDialog.init(t.session.readContext(t.docId)))[0].field, 'penType');
});

test('Ruler, Draw with Touch, Ink to Shape and Lock Drawing Mode are page modes', async () => {
  const t = await session();
  for (const [id, key, dflt] of [['ink.ruler', 'ruler', false], ['ink.drawWithTouch', 'touchDraw', true], ['ink.toShape', 'inkToShape', false], ['shape.lockDrawing', 'lockDrawing', false]]) {
    assert.equal(t.state(id).checked, dflt, id);
    await t.exec(id, {});
    assert.equal(t.state(id).checked, !dflt, id);
    assert.equal(view(t)[key], !dflt, id);
    await t.exec(id, {value: dflt});
    assert.equal(t.state(id).checked, dflt, id);
  }
});

test('surface.ink adds real strokes (pen, pencil, highlighter, galaxy and rainbow) that read back and undo', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'surface.ink', {page: t.pageId, stroke: pen([10, 10, 60, 40, 120, 20])});
  const id = await draw(t, [5, 5, 50, 5], {tool: 'pencil', color: '#5f5f5f', width: 3.78});
  await draw(t, [5, 30, 50, 30], {fx: 'galaxy', width: 4.5});
  await draw(t, [5, 60, 50, 60], {tool: 'highlighter', color: '#ffff00', width: 22.68, fx: 'rainbow'});
  assert.deepEqual(ink(t).map(s => [s.tool, s.fx ?? null]), [['pen', null], ['pencil', null], ['pen', 'galaxy'], ['highlighter', 'rainbow']]);
  assert.deepEqual(t.read(`/pg:${t.pageId}/ink:${id}`, 'json').points, [5, 5, 50, 5]);
  await assert.rejects(t.exec('surface.ink', {page: t.pageId, stroke: pen([1, 2, 3, 4], {fx: 'lava'})}), /fx|galaxy|rainbow|must be/);
});

test('shape.insert: a shape tool, then shapes drawn as grouped strokes in the current pen; Lock Drawing Mode keeps the tool', async () => {
  const t = await session();
  assert.equal(t.state('shape.insert').value.length, 21);
  assert.deepEqual(t.state('shape.insert').value.map(s => s.icon).slice(0, 3), ['shape-line', 'shape-arrow', 'shape-double-arrow']);
  await t.exec('ink.selectPen', {penId: 'red-pen'});
  await t.exec('shape.insert', {shape: 'rectangle'});
  assert.deepEqual([view(t).ink.tool, view(t).ink.shape, view(t).ink.color], ['shape', 'rectangle', '#ff0000']);
  assert.equal(t.state('shape.insert', {shape: 'rectangle'}).checked, true);
  assert.equal(t.state('shape.insert', {shape: 'oval'}).checked, false);
  const r = (await expectUndoRoundTrip(t, 'shape.insert', {shape: 'rectangle', x: 100, y: 100, x2: 220, y2: 160})) && ink(t);
  void r;
  assert.equal(ink(t).length, 1);
  assert.deepEqual(ink(t)[0].points, [100, 100, 220, 100, 220, 160, 100, 160, 100, 100]);
  assert.deepEqual([ink(t)[0].color, ink(t)[0].shape, ink(t)[0].tool], ['#ff0000', 'rectangle', 'pen']);
  // One shape, then the tool is off (typing again) unless Lock Drawing Mode is on.
  assert.equal(view(t).ink, null);
  assert.deepEqual(sel(t), [ink(t)[0].id]);
  await t.exec('shape.lockDrawing', {value: true});
  await t.exec('shape.insert', {shape: 'cube'});
  await t.exec('shape.insert', {shape: 'cube', x: 300, y: 100, x2: 400, y2: 200});
  assert.equal(view(t).ink.tool, 'shape');
  const cube = ink(t).filter(s => s.shape === 'cube');
  assert.equal(cube.length, 3);
  assert.equal(new Set(cube.map(s => s.group)).size, 1);
  // Every shape in the gallery draws; lines and arrows run between the points, others fill the box.
  for (const name of SHAPES) {
    const polys = shapePolylines(name, {x: 10, y: 10}, {x: 110, y: 90});
    assert.ok(polys.length >= 1 && polys.every(p => p.length >= 4 && p.every(Number.isFinite)), name);
    await t.exec('shape.insert', {shape: name, x: 10, y: 10, x2: 110, y2: 90});
  }
  assert.deepEqual(shapePolylines('line', {x: 10, y: 10}, {x: 110, y: 90}), [[10, 10, 110, 90]]);
  assert.equal(shapePolylines('arrow', {x: 0, y: 0}, {x: 100, y: 0}).length, 2);
  assert.equal(shapePolylines('double-arrow', {x: 0, y: 0}, {x: 100, y: 0}).length, 3);
  const circle = shapePolylines('circle', {x: 0, y: 0}, {x: 100, y: 40})[0];
  const xs = circle.filter((_, i) => i % 2 === 0), ys = circle.filter((_, i) => i % 2);
  assert.ok(Math.max(...xs) - Math.min(...xs) === Math.max(...ys) - Math.min(...ys), 'a circle is as tall as it is wide');
  await assert.rejects(t.exec('shape.insert', {shape: 'rectangle', x: 5, x2: 50, y2: 60}), /x, y and x2, y2/);
});

test('Ink to Shape: a hand-drawn line, triangle, rectangle, diamond or oval becomes the exact shape in the same pen; scribbles stay', async () => {
  const wobble = (pts, k = 1.2) => pts.map((v, i) => v + Math.sin(i * 1.7) * k);
  const poly = (corners, per = 12) => { const out = []; for (let i = 0; i < corners.length; i++) { const a = corners[i], b = corners[(i + 1) % corners.length]; for (let k = 0; k < per; k++) out.push(a[0] + ((b[0] - a[0]) * k) / per, a[1] + ((b[1] - a[1]) * k) / per); } out.push(corners[0][0], corners[0][1]); return wobble(out); };
  const ellipse = (cx, cy, rx, ry) => { const out = []; for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); } return wobble(out, 0.8); };
  assert.equal(recognize(wobble([10, 10, 50, 12, 90, 11, 130, 13, 170, 10]))?.shape, 'line');
  assert.equal(recognize(poly([[100, 20], [160, 120], [40, 120]]))?.shape, 'triangle');
  assert.equal(recognize(poly([[20, 20], [160, 20], [160, 100], [20, 100]]))?.shape, 'rectangle');
  assert.equal(recognize(poly([[100, 20], [160, 70], [100, 120], [40, 70]]))?.shape, 'diamond');
  assert.equal(recognize(ellipse(100, 60, 70, 40))?.shape, 'oval');
  assert.equal(recognize(ellipse(100, 60, 50, 50))?.shape, 'circle');
  assert.equal(recognize([10, 10, 14, 12, 12, 16]), null);
  assert.equal(recognize([0, 0, 40, 30, 10, 50, 60, 10, 20, 70, 90, 20, 30, 90]), null);
  const t = await session();
  await t.exec('ink.selectPen', {penId: 'blue-pen'});
  const r = (await t.exec('surface.ink', {page: t.pageId, stroke: pen(poly([[20, 20], [160, 20], [160, 100], [20, 100]]), {color: '#0070c0'}), snap: true})).result;
  assert.equal(r.shape, 'rectangle');
  assert.equal(ink(t).length, 1);
  assert.deepEqual([ink(t)[0].color, ink(t)[0].shape], ['#0070c0', 'rectangle']);
  await t.exec('surface.ink', {page: t.pageId, stroke: pen([5, 5, 9, 7, 6, 9]), snap: true});
  assert.equal(ink(t).length, 2);
  assert.equal(ink(t)[1].shape, undefined);
});

test('ink.lasso selects the strokes a loop goes round (a shape\'s strokes together); ink.select picks by id; selection is /ink: addresses', async () => {
  const t = await session();
  const a = await draw(t, [50, 50, 80, 60, 100, 50]);
  const b = await draw(t, [60, 100, 120, 110]);
  const far = await draw(t, [400, 400, 450, 450]);
  await t.exec('shape.insert', {shape: 'rectangle', x: 300, y: 50, x2: 360, y2: 90});
  const rect = ink(t).filter(s => s.shape === 'rectangle').map(s => s.id);
  const r = await t.exec('ink.lasso', {page: t.pageId, path: [20, 20, 140, 20, 140, 140, 20, 140]});
  assert.equal(r.result.selected, 2);
  assert.deepEqual(sel(t).sort(), [a, b].sort());
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}/ink:${a}`);
  // A loop round part of a shape takes all of it.
  await t.exec('ink.lasso', {path: [295, 45, 365, 45, 365, 70, 295, 70]});
  assert.deepEqual(sel(t).sort(), rect.sort());
  await t.exec('ink.select', {ids: [far]});
  assert.deepEqual(sel(t), [far]);
  await t.exec('ink.select', {all: true});
  assert.equal(sel(t).length, 1 + 2 + rect.length);
  await t.exec('ink.lasso', {path: [600, 600, 700, 600, 700, 700]});
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}`);
  await assert.rejects(t.exec('ink.select', {ids: ['nope']}), /No stroke/);
  assert.deepEqual(lassoHits(ink(t), [0, 0, 10, 0, 10, 10]), []);
});

test('ink.move, object.rotate, object.flip move the selected ink; the page edge stops it', async () => {
  const t = await session();
  const a = await draw(t, [100, 100, 200, 100]);
  const b = await draw(t, [100, 200, 200, 200]);
  await t.exec('ink.select', {ids: [a, b]});
  await expectUndoRoundTrip(t, 'ink.move', {dx: 30, dy: 10});
  assert.deepEqual(ink(t).map(s => s.points), [[130, 110, 230, 110], [130, 210, 230, 210]]);
  await t.exec('ink.move', {dx: -1000, dy: -1000});
  assert.deepEqual(ink(t).map(s => s.points), [[0, 0, 100, 0], [0, 100, 100, 100]]);
  // Rotate right 90 degrees round the middle of the selection, flip, and rotate back.
  const before = ink(t).map(s => s.points.slice());
  await expectUndoRoundTrip(t, 'object.rotate', {degrees: 90});
  assert.ok(ink(t).every(st => Math.round(st.points[0]) === Math.round(st.points[2]) && st.points[1] !== st.points[3]), 'two horizontal lines turned are vertical');
  await t.exec('object.rotate', {degrees: -90});
  assert.deepEqual(ink(t).map(s => s.points.map(v => Math.round(v))), before.map(p => p.map(v => Math.round(v))));
  await expectUndoRoundTrip(t, 'object.flip', {axis: 'vertical'});
  assert.deepEqual(ink(t)[0].points.map(Math.round), [0, 100, 100, 100]);
  assert.deepEqual(flipped([{points: [0, 0, 10, 20], width: 1}], 'horizontal')[0].points, [10, 0, 0, 20]);
  assert.deepEqual(moved([{points: [5, 5, 9, 9], width: 1}], -50, 3)[0].points, [0, 8, 4, 12]);
  assert.equal(rotated([{points: [0, 0, 10, 0], width: 1}], 180)[0].points.length, 4);
  // Nothing selected: disabled, with the reason.
  await t.exec('draw.tool', {tool: 'type'});
  t.select({ranges: [{anchor: `/pg:${t.pageId}`, focus: `/pg:${t.pageId}`}], primary: 0});
  assert.equal(t.state('object.rotate').reason, 'Select ink or a shape with the Lasso first');
  await assert.rejects(t.exec('ink.move', {dx: 1, dy: 1}), /Lasso/);
});

test('object.order stacks the selected ink (and note containers): forward, backward, front, back', async () => {
  const t = await session();
  const ids = [];
  for (const x of [10, 20, 30, 40]) ids.push(await draw(t, [x, 10, x, 50]));
  await t.exec('ink.select', {ids: [ids[1]]});
  const order = () => ink(t).map(s => ids.indexOf(s.id));
  await expectUndoRoundTrip(t, 'object.order', {to: 'forward'});
  assert.deepEqual(order(), [0, 2, 1, 3]);
  await t.exec('object.order', {to: 'front'});
  assert.deepEqual(order(), [0, 2, 3, 1]);
  await t.exec('object.order', {to: 'backward'});
  assert.deepEqual(order(), [0, 2, 1, 3]);
  await t.exec('object.order', {to: 'back'});
  assert.deepEqual(order(), [1, 0, 2, 3]);
  // A note container is ordered too (its place in the page's z order).
  await t.exec('surface.newContainer', {page: t.pageId, x: 300, y: 300, text: 'Second'});
  const containers = () => t.content.pages[t.pageId].body.content.map(c => c.attrs.id);
  const [c1, c2] = containers();
  t.select({ranges: [{anchor: `/pg:${t.pageId}/c:${c2}`, focus: `/pg:${t.pageId}/c:${c2}`}], primary: 0});
  await t.exec('object.order', {to: 'back'});
  assert.deepEqual(containers(), [c2, c1]);
  await t.exec('object.order', {to: 'forward'});
  assert.deepEqual(containers(), [c1, c2]);
});

test('edit.delete removes selected ink with its shape, a selected container, selected text, or the character after the caret', async () => {
  const t = await session();
  const a = await draw(t, [10, 10, 50, 50]);
  await t.exec('shape.insert', {shape: 'triangle', x: 100, y: 100, x2: 200, y2: 180});
  const tri = ink(t).filter(s => s.shape === 'triangle');
  await t.exec('ink.select', {ids: [tri[0].id]});
  await expectUndoRoundTrip(t, 'edit.delete', {});
  assert.deepEqual(ink(t).map(s => s.id), [a]);
  assert.equal(t.doc.selection.ranges[0].anchor, `/pg:${t.pageId}`);
  // Text: a range, then a caret deleting forward, then the paragraph joining.
  t.select(textSel(t.pageId, 'b1', 1, 3));
  await t.exec('edit.delete', {});
  assert.equal(t.content.pages[t.pageId].body.content[0].content[0].content[0].text, 'Nes');
  t.select(textSel(t.pageId, 'b1', 0));
  await t.exec('edit.delete', {});
  assert.equal(t.content.pages[t.pageId].body.content[0].content[0].content[0].text, 'es');
  // A selected container.
  await t.exec('surface.newContainer', {page: t.pageId, x: 300, y: 300, text: 'Gone'});
  const cid = t.content.pages[t.pageId].body.content[1].attrs.id;
  t.select({ranges: [{anchor: `/pg:${t.pageId}/c:${cid}`, focus: `/pg:${t.pageId}/c:${cid}`}], primary: 0});
  await t.exec('edit.delete', {});
  assert.equal(t.content.pages[t.pageId].body.content.length, 1);
});

test('the eraser: the stroke eraser takes whole strokes (and shapes), the point erasers cut a stroke in two', async () => {
  const t = await session();
  const long = await draw(t, [0, 100, 100, 100, 200, 100, 300, 100]);
  const other = await draw(t, [0, 300, 300, 300]);
  await t.exec('shape.insert', {shape: 'rectangle', x: 400, y: 50, x2: 480, y2: 120});
  // Point eraser: rubs out the middle of the long stroke only.
  const r = (await expectUndoRoundTrip(t, 'ink.erase', {path: [150, 100, 155, 100], radius: 20, mode: 'point'})) && ink(t);
  void r;
  const parts = ink(t).filter(s => !s.shape && s.id !== other);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].id, long);
  assert.ok(parts[0].points.at(-2) < 150 && parts[1].points[0] > 150);
  assert.ok(ink(t).some(s => s.id === other));
  // A long drag crossing a stroke between its two sampled points erases there too (the eraser sweeps the segment).
  const crossed = await draw(t, [250, 400, 350, 400]);
  await t.exec('ink.erase', {path: [300, 360, 300, 440], radius: 10, mode: 'point'});
  assert.equal(ink(t).filter(s => s.points[1] === 400 && s.points[3] === 400).length, 2);
  void crossed;
  // A path that touches nothing changes nothing.
  const v = t.version;
  assert.equal((await t.exec('ink.erase', {path: [600, 600], radius: 5, mode: 'point'})).result.erased, 0);
  assert.equal(t.version, v);
  // Stroke eraser: one touch takes the whole stroke; a shape of several strokes goes together (the cube below).
  const n = ink(t).length;
  await t.exec('ink.erase', {path: [440, 50, 441, 50], radius: 4, mode: 'stroke'});
  assert.equal(ink(t).length, n - 1);
  assert.equal(ink(t).filter(s => s.shape === 'rectangle').length, 0);
  await t.exec('shape.insert', {shape: 'cube', x: 500, y: 50, x2: 600, y2: 150});
  assert.equal(ink(t).filter(s => s.shape === 'cube').length, 3);
  await t.exec('ink.erase', {path: [500, 60, 500, 60], radius: 30, mode: 'stroke'});
  assert.equal(ink(t).filter(s => s.shape === 'cube').length, 0);
  // Cutting a stroke in the middle keeps its pen.
  assert.ok(erasePoints([{id: 'a', tool: 'highlighter', color: '#ffff00', width: 6, points: [0, 0, 50, 0, 100, 0]}], [50, 0], 5, () => 'b').ink.every(s => s.tool === 'highlighter'));
});

test('Ink Replay plays the selected strokes (or the page) in drawn order; ruler and touch are modes', async () => {
  const t = await session();
  assert.equal(t.state('ink.replay').enabled, false);
  const a = await draw(t, [10, 10, 60, 60]);
  const b = await draw(t, [10, 70, 60, 20]);
  await draw(t, [100, 100, 150, 150]);
  await t.exec('ink.replay', {});
  assert.deepEqual([view(t).replay.ids.length, view(t).replay.run, view(t).replay.page], [3, 1, t.pageId]);
  await t.exec('ink.select', {ids: [b, a]});
  await t.exec('ink.replay', {});
  assert.deepEqual(view(t).replay.ids, [a, b], 'in the order they were drawn, not the order picked');
  assert.equal(view(t).replay.run, 2);
  await t.exec('ink.replay', {strokeIds: [b]});
  assert.deepEqual(view(t).replay.ids, [b]);
  await assert.rejects(t.exec('ink.replay', {strokeIds: ['zz']}), /No stroke/);
});

test('every kind of ink saves into the notebook folder and reads back the same', async () => {
  const t = await session();
  await draw(t, [10, 10, 40, 40, 80, 20]);
  await draw(t, [10, 60, 90, 60], {tool: 'pencil', color: '#5f5f5f', width: 3.78});
  await draw(t, [10, 90, 90, 90], {fx: 'rainbow', width: 4.5});
  await draw(t, [10, 120, 90, 120], {tool: 'highlighter', color: '#ff66cc', width: 22.68});
  await t.exec('shape.insert', {shape: 'cylinder', x: 200, y: 100, x2: 300, y2: 220});
  await t.exec('ink.select', {all: true});
  await t.exec('object.rotate', {degrees: 90});
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-ink-'));
  const nodeFs = {
    readText: p => fs.readFile(p, 'utf8'),
    async writeText(p, text) { const tmp = `${p}.${process.pid}.tmp`; await fs.writeFile(tmp, text); await fs.rename(tmp, p); },
    list: async p => (await fs.readdir(p, {withFileTypes: true})).map(d => ({name: d.name, dir: d.isDirectory()})),
    mkdir: p => fs.mkdir(p, {recursive: true}).then(() => {}),
    rename: (a, b) => fs.rename(a, b),
    remove: p => fs.rm(p, {recursive: true, force: true}),
  };
  const root = path.join(base, 'Notebook').split(path.sep).join('/');
  await writeNotebook(nodeFs, root, t.content);
  const {content: back} = await loadNotebook(nodeFs, root);
  assert.deepEqual(back.pages[t.pageId].ink, ink(t));
  assert.ok(back.pages[t.pageId].ink.some(s => s.fx === 'rainbow') && back.pages[t.pageId].ink.some(s => s.tool === 'pencil') && back.pages[t.pageId].ink.some(s => s.group));
  await fs.rm(base, {recursive: true, force: true});
});

test('the Draw commands exist; Ink to Text, Math and the Ink Editor are not registered', async () => {
  const t = await session();
  for (const id of ['draw.tool', 'ink.selectPen', 'ink.addPen', 'ink.removePen', 'ink.penSettings', 'ink.ruler', 'ink.drawWithTouch', 'ink.toShape', 'ink.replay', 'ink.erase', 'ink.lasso', 'ink.select', 'ink.move',
    'shape.insert', 'shape.lockDrawing', 'object.order', 'object.rotate', 'object.flip', 'edit.delete', 'insert.space']) assert.ok(t.registry.has(id), id);
  for (const id of ['ink.toText', 'ink.toMath', 'ink.editor']) assert.equal(t.registry.has(id), false, id);
});
