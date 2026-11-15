// U:grid/draw: the Draw tab's pens, eraser, lasso, Ink to Shape and Ink Replay, and that ink survives .xlsx.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/draw.rs (`pen`, `eraser`, `stroke`, `ink_to_shape`: a stroke is a shape of
//    kind Ink pinned where it was drawn, its width in the fill's red channel; an open stroke becomes a line, a closed one a
//    rectangle, triangle or ellipse), crates/xlsx/src/drawing/ink.rs (DrawingML polyline, 45% alpha above 8 px).
//    The lasso, Ink Replay and the pen buttons' switching are Excel's (not in gridcraft).
// 2. Ours runs the same commands through the translated model; every change is one undo step.
// 3. These tests; the bridge E2E tests/e2e/grid/draw-objects.e2e.mjs drives the same flows from the ribbon and the pointer.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';
import {inkPoints, inkWidth, widthFill, shapeOfStroke, nearInk, inPolygon} from '../../core/grid/lib/ink.mjs';
import {objectRect} from '../../core/grid/lib/objects.mjs';

const sheet = t => t.content.sheets[0];
const inks = t => (sheet(t).shapes ?? []).filter(x => x.kind === 'ink');
const wave = (x0, y0, n = 12) => Array.from({length: n}, (_, i) => [x0 + i * 10, y0 + 20 * Math.sin(i / 2)]);

test('draw.pen picks a pen, switches to another pen, and puts the pen in use away', async () => {
  const t = await session(workbook());
  assert.deepEqual(await run(t, 'draw.pen', {color: '#1F5FC9', width: 2}), {tool: 'pen', color: '#1F5FC9', width: 2});
  assert.equal(t.doc.view.draw.tool, 'pen');
  // another pen replaces it, it does not switch the pen off
  assert.equal((await run(t, 'draw.pen', {color: '#d13b2f', width: 2})).tool, 'pen');
  assert.equal(t.doc.view.draw.color, '#D13B2F');
  // the pen in use, pressed again, is put away
  assert.equal((await run(t, 'draw.pen', {color: '#D13B2F', width: 2})).tool, '');
  assert.equal(t.doc.view.draw.tool, '');
  assert.deepEqual(await run(t, 'draw.pen', {kind: 'highlighter'}), {tool: 'pen', color: '#F2E33A', width: 12});
  assert.deepEqual(await run(t, 'draw.pen', {kind: 'pencil'}), {tool: 'pen', color: '#595959', width: 1});
  await assert.rejects(() => run(t, 'draw.pen', {color: 'red'}), /#RRGGBB/);
  await run(t, 'draw.eraser', {});
  assert.equal(t.doc.view.draw.tool, 'eraser');
  await run(t, 'draw.eraser', {});
  assert.equal(t.doc.view.draw.tool, '');
  await run(t, 'draw.lasso', {mode: 'lasso'});
  assert.equal(t.doc.view.draw.tool, 'lasso');
  await run(t, 'draw.lasso', {});
  assert.equal(t.doc.view.draw.tool, '', 'Select Objects puts every tool away');
});

test('draw.stroke is a shape of kind ink pinned where it was drawn, with the pen colour and width', async () => {
  const t = await session(workbook());
  await run(t, 'draw.pen', {color: '#1F5FC9', width: 3});
  const pts = wave(100, 80);
  const r = await run(t, 'draw.stroke', {points: pts});
  const ink = inks(t)[0];
  assert.equal(ink.id, r.shape);
  assert.equal(ink.kind, 'ink');
  assert.equal(ink.anchor.mode, 'absolute');
  assert.equal(ink.line, '#1F5FC9');
  assert.equal(inkWidth(ink), 3);
  assert.equal(ink.fill, widthFill(3));
  // the anchor's corner is the top-left of the points, the points are kept relative to it
  const rect = objectRect(sheet(t), ink.anchor);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  assert.ok(Math.abs(rect.x - Math.min(...xs)) <= 1 && Math.abs(rect.y - Math.min(...ys)) <= 1, 'drawn where the pointer was');
  assert.ok(Math.abs(ink.anchor.width - (Math.max(...xs) - Math.min(...xs))) <= 1);
  const back = inkPoints(ink);
  assert.equal(back.length, pts.length);
  assert.ok(Math.abs(back[3][0] - (pts[3][0] - Math.min(...xs))) < 0.1);
  await assert.rejects(() => run(t, 'draw.stroke', {points: [[1, 1]]}), /at least two points/);
  await expectUndoRoundTrip(t, 'draw.stroke', {points: wave(300, 200), tool: 'highlighter'}, (after) => assert.equal(inks(after).length, 2));
  const hl = inks(t).at(-1);
  assert.equal(inkWidth(hl), 12, 'the highlighter is a wide pen');
});

test('draw.erase deletes the stroke under the point, and only that one', async () => {
  const t = await session(workbook());
  await run(t, 'draw.stroke', {points: [[50, 50], [150, 50]]});
  await run(t, 'draw.stroke', {points: [[50, 150], [150, 150]]});
  assert.equal(inks(t).length, 2);
  await assert.rejects(() => run(t, 'draw.erase', {x: 400, y: 400}), /no ink stroke there/);
  assert.equal((await run(t, 'draw.erase', {x: 100, y: 52})).erased, inks(t).length === 1 ? 1 : undefined);
  assert.equal(inks(t).length, 1);
  assert.ok(inkPoints(inks(t)[0]).length === 2);
  assert.ok(Math.abs(objectRect(sheet(t), inks(t)[0].anchor).y - 150) <= 1, 'the lower stroke is the one left');
  await expectUndoRoundTrip(t, 'draw.erase', {x: 100, y: 150}, after => assert.equal(inks(after).length, 0));
});

test('draw.inkToShape: a stroke becomes the shape it looks like (draw.rs ink_to_shape)', async () => {
  const t = await session(workbook());
  const rect = [[0, 0], [100, 0], [100, 60], [0, 60], [0, 2]].map(([x, y]) => [x + 40, y + 40]);
  const ell = Array.from({length: 40}, (_, i) => [200 + 50 * Math.cos(i / 39 * Math.PI * 2), 100 + 30 * Math.sin(i / 39 * Math.PI * 2)]);
  const tri = [[400, 140], [440, 60], [480, 140], [400, 140]];
  const line = [[40, 300], [160, 340]];
  const kinds = {};
  for (const [name, pts] of Object.entries({rect, ell, tri, line})) {
    const r = await run(t, 'draw.stroke', {points: pts});
    kinds[name] = (await run(t, 'draw.inkToShape', {id: r.shape})).kind;
  }
  assert.deepEqual(kinds, {rect: 'rectangle', ell: 'ellipse', tri: 'triangle', line: 'line'});
  const shapes = sheet(t).shapes;
  assert.deepEqual(shapes.map(x => x.kind), ['rectangle', 'ellipse', 'triangle', 'line']);
  assert.equal(shapes[0].fill, 'auto');
  assert.equal(shapes[3].fill, shapes[3].line, 'a line keeps the pen colour');
  assert.equal(shapes[0].text, '');
  assert.equal(shapeOfStroke([[0, 0], [10, 10]], 10, 10), 'line');
  await assert.rejects(() => run(t, 'draw.inkToShape', {}), /no ink/);
  const r2 = await run(t, 'draw.stroke', {points: rect});
  await expectUndoRoundTrip(t, 'draw.inkToShape', {id: r2.shape}, after => assert.equal(inks(after).length, 0));
});

test('draw.lasso: a loop selects the strokes inside it, which move and delete together', async () => {
  const t = await session(workbook());
  await run(t, 'draw.stroke', {points: [[100, 100], [140, 120], [180, 100]]});
  await run(t, 'draw.stroke', {points: [[100, 160], [180, 160]]});
  await run(t, 'draw.stroke', {points: [[600, 400], [700, 420]]});
  await run(t, 'draw.lasso', {mode: 'lasso'});
  const loop = [[60, 60], [240, 60], [240, 220], [60, 220]];
  const sel = await run(t, 'draw.lasso', {points: loop});
  assert.equal(sel.count, 2);
  assert.deepEqual(t.doc.view.draw.lasso, sel.selected);
  await assert.rejects(() => run(t, 'draw.lasso', {points: [[1, 1], [2, 2]]}), /at least three points/);
  const before = inks(t).map(x => objectRect(sheet(t), x.anchor));
  await run(t, 'draw.lassoMove', {dx: 30, dy: 10});
  const after = inks(t).map(x => objectRect(sheet(t), x.anchor));
  assert.ok(Math.abs(after[0].x - before[0].x - 30) <= 1 && Math.abs(after[0].y - before[0].y - 10) <= 1);
  assert.ok(Math.abs(after[1].x - before[1].x - 30) <= 1);
  assert.deepEqual(after[2], before[2], 'the stroke outside the loop stays');
  await expectUndoRoundTrip(t, 'draw.lassoDelete', {}, after2 => assert.equal(inks(after2).length, 1));
  assert.deepEqual(t.doc.view.draw.lasso, []);
  await assert.rejects(() => run(t, 'draw.lassoDelete', {}), /nothing is selected/);
});

test('draw.inkReplay steps through the strokes in drawing order and ends', async () => {
  const t = await session(workbook());
  const e = await fails(t, 'draw.inkReplay', {});
  assert.match(e.message, /no ink/);
  for (let i = 0; i < 3; i++) await run(t, 'draw.stroke', {points: [[50 + i * 10, 50], [100 + i * 10, 80]]});
  const ids = inks(t).map(x => x.id);
  assert.deepEqual(await run(t, 'draw.inkReplay', {}), {replaying: true, shown: 0, total: 3});
  assert.deepEqual(t.doc.view.inkReplay, {ids, n: 0});
  assert.deepEqual(await run(t, 'draw.inkReplay', {step: 2}), {replaying: true, shown: 2, total: 3});
  assert.equal(t.doc.view.inkReplay.n, 2);
  assert.equal((await run(t, 'draw.inkReplay', {step: 3})).replaying, false);
  assert.equal(t.doc.view.inkReplay ?? null, null);
  await run(t, 'draw.inkReplay', {});
  await run(t, 'draw.inkReplay', {stop: true});
  assert.equal(t.doc.view.inkReplay ?? null, null);
});

test('a protected sheet refuses ink unless Edit objects is allowed', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', protection: {enabled: true}}]));
  const e = await fails(t, 'draw.stroke', {points: [[1, 1], [20, 20]]});
  assert.match(e.message, /protected sheet/);
});

test('ink geometry: nearInk, inPolygon and the width channel', () => {
  assert.ok(nearInk([[0, 0], [100, 0]], 2, 50, 4, 4));
  assert.ok(!nearInk([[0, 0], [100, 0]], 2, 50, 12, 4));
  assert.ok(inPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 5, 5));
  assert.ok(!inPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 15, 5));
  assert.equal(inkWidth({fill: widthFill(12)}), 12);
  assert.equal(inkWidth({fill: 'auto'}), 2);
});

test('ink saves as a DrawingML polyline and reads back with its colour, width and points', async () => {
  const t = await session(workbook());
  await run(t, 'draw.stroke', {points: wave(120, 90), color: '#D13B2F', width: 4});
  await run(t, 'draw.stroke', {points: [[300, 200], [380, 260], [420, 200]], tool: 'highlighter'});
  const bytes = await writeXlsx(t.content);
  const read = await readXlsx(bytes);
  const content = read.content ?? read;
  const back = (content.sheets[0].shapes ?? []).filter(x => x.kind === 'ink');
  assert.equal(back.length, 2);
  assert.equal(back[0].line, '#D13B2F');
  assert.equal(inkWidth(back[0]), 4);
  assert.equal(back[0].anchor.mode, 'absolute');
  const was = inkPoints(inks(t)[0]), now = inkPoints(back[0]);
  assert.equal(now.length, was.length);
  assert.ok(now.every(([x, y], i) => Math.abs(x - was[i][0]) < 0.5 && Math.abs(y - was[i][1]) < 0.5));
  assert.equal(inkWidth(back[1]), 12);
  assert.equal(back[1].line, '#F2E33A');
});
