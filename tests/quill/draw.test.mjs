// U:quill/draw: the Draw tab: pens, pencil, highlighter and the pen gallery, Eraser, Lasso Select
// (select, move, recolour, delete), Ink to Shape, Ink Replay, Hide Ink, the Drawing Canvas, and ink as
// real objects of the document that save to .docx and read back.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft crates/ui-egui/src/ribbon/draw.rs (the tab, the gallery pens), engine/src/cmd/draw.rs
//    (the modes, stroke, erase, lasso), cmd/canvas.rs (insert), ui-egui/src/canvas/input.rs (the gestures),
//    and the ink-to-shape recogniser. Word: a drag with the pen leaves a stroke in the page's ink layer; the
//    eraser removes the stroke it touches; the lasso selects what its loop holds and the selection moves,
//    recolours and deletes; Ink to Shape turns a drawn line, arrow, rectangle, ellipse or triangle into
//    that shape; Ink Replay plays the strokes back in the order they were drawn.
// 2. Ours: strokes are shape objects of the paragraph model (freeform geometry flagged `ink`, in drawing
//    order), laid out by the page layout like any floating object; every change is one undo step; .docx
//    keeps them as DrawingML custom geometry named `Ink Pen`.
// 3. Proof: this file, tests/quill/upstream/draw_tests.test.mjs and tests/e2e/quill/draw.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from './format-fixture.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {read as readDocx} from '../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../core/quill/formats/docx-write.mjs';
import {recognise, arrowParts} from '../../core/quill/lib/draw-shape.mjs';
import {gesture, visibleItems, inkOrders} from '../../src/apps/quill/surface/draw-input.mjs';

const TEXT = 'The quick brown fox jumps over the lazy dog.\nA second paragraph of text.\nAnd a third one to anchor ink to.';

/** Every shape object of the body, in order. */
function shapes(t) {
  const out = [];
  for (const b of blocks(t)) for (const o of b.objects ?? []) if (o?.type === 'shape') out.push(o);
  return out;
}
/** The ink of the body in drawing order (a stroke anchors to the paragraph under it, so document order is not drawing order). */
const inkOf = t => shapes(t).filter(o => o.freeform?.ink).sort((a, b) => a.freeform.order - b.freeform.order);
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const squiggle = (x, y, n = 24) => Array.from({length: n}, (_, i) => [x + i * 4, y + Math.sin(i / 2) * 12]);

test('draw.stroke: a stroke is real ink in the document, one undo step; undo and redo bring it back', async () => {
  const q = await quill(TEXT);
  assert.equal(inkOf(q.t).length, 0);
  const before = q.texts();
  await q.exec('draw.pen', {});
  const res = await q.exec('draw.stroke', {page: 0, points: squiggle(100, 200)});
  assert.ok(res, 'a result');
  const ink = inkOf(q.t);
  assert.equal(ink.length, 1, 'one ink object');
  assert.equal(ink[0].kind, 'freeform');
  assert.ok(ink[0].freeform.paths[0].pts.length >= 3, 'the points are kept');
  assert.equal(ink[0].float.wrap, 'inFrontOfText');
  await q.t.session.undo(q.t.docId);
  assert.equal(inkOf(q.t).length, 0, 'undo removes the stroke');
  assert.deepEqual(q.texts(), before, 'the text is untouched');
  await q.t.session.redo(q.t.docId);
  assert.equal(inkOf(q.t).length, 1, 'redo restores it');
});

test('draw.stroke: strokes sit on the page where they were drawn, in drawing order', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 200)});
  await q.exec('draw.stroke', {page: 0, points: squiggle(300, 400)});
  const ink = inkOf(q.t);
  assert.equal(ink.length, 2);
  assert.ok(ink[1].freeform.order > ink[0].freeform.order, 'drawing order grows');
  const l = layout(q.t.content, {view: 'print'});
  const items = l.pages[0].items.filter(i => i.kind === 'object' && i.rect && i.story !== undefined);
  const rects = items.map(i => i.rect);
  const hit = (x, y) => rects.some(r => x >= r.x - 1 && x <= r.x + r.w + 1 && y >= r.y - 1 && y <= r.y + r.h + 1);
  assert.ok(hit(100 + 40, 200), 'the first stroke is where it was drawn');
  assert.ok(hit(300 + 40, 400), 'the second stroke is where it was drawn');
});

test('pens: colour and thickness, pencil and highlighter, the gallery (add, use, remove)', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.pen', {color: 'FF0000', width: 3.5});
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 200)});
  const pen = inkOf(q.t)[0];
  assert.deepEqual([...pen.stroke], [255, 0, 0]);
  assert.equal(pen.strokeWidth, 3.5);
  await q.exec('draw.highlighter', {});
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 300)});
  const hl = inkOf(q.t)[1];
  assert.equal(hl.float.wrap, 'behindText', 'the highlighter is behind the text');
  assert.ok(hl.freeform.alpha < 1, 'and translucent');
  assert.ok(hl.strokeWidth >= 4, 'and thick');
  await q.exec('draw.pencil', {});
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 360)});
  assert.equal(inkOf(q.t)[2].freeform.ink, 'pencil');

  // The gallery: Word's default pens, then the person's own.
  const start = (await q.state('draw.usePen')).value;
  assert.deepEqual(start.map(i => i.icon), ['pen', 'pen', 'pen', 'pencil', 'highlight'], 'a fresh profile has the default pens');
  assert.deepEqual(start.map(i => i.accent), ['#000000', '#FF0000', '#0070C0', '#000000', '#FFFF00'], 'drawn in their colours');
  await q.exec('draw.pen', {color: '7030A0', width: 2.5});
  await q.exec('draw.addPen', {kind: 'pen', current: true});
  await q.exec('draw.addPen', {kind: 'highlighter', current: true});
  const items = (await q.state('draw.usePen')).value;
  assert.equal(items.length, 7);
  assert.deepEqual(items.slice(5).map(i => i.icon), ['pen', 'highlight'], 'each tile is its kind\'s icon');
  assert.equal(items[5].accent, '#7030A0', 'drawn in the pen colour');
  assert.ok(items.every(i => i.bar > 0), 'over a bar of its thickness');
  await q.exec('draw.usePen', {index: 5});
  assert.equal((await q.state('draw.penColor')).value, '#7030A0');
  await q.exec('draw.removePen', {index: 5});
  assert.equal((await q.state('draw.usePen')).value.length, 6);
});

test('the pen gallery is the person\'s preference: kept across launches, not in the document; empty only when every pen is removed', async () => {
  const host = createTestHost();
  const open = prefs => quill(TEXT, undefined, {host, prefs});
  let q = await open(undefined);
  assert.equal(host.savedPrefs, null, 'nothing is saved before the gallery changes');
  await q.exec('draw.pen', {color: '00B050', width: 3.5});
  await q.exec('draw.addPen', {kind: 'pen', current: true});
  await q.exec('draw.removePen', {index: 1});
  const saved = host.savedPrefs;
  assert.ok(saved?.draw?.pens, 'the gallery is saved to the settings store');
  assert.equal(saved.draw.pens.length, 5);
  assert.ok(!JSON.stringify(q.t.content).includes('"pens"'), 'and not in the document');
  // Another launch: the same prefs give the same gallery.
  q = await open(saved);
  const again = (await q.state('draw.usePen')).value;
  assert.deepEqual(again.map(i => i.accent), ['#000000', '#0070C0', '#000000', '#FFFF00', '#00B050']);
  // Removing every pen leaves it empty, and it stays empty on the next launch.
  for (let i = again.length; i > 0; i--) await q.exec('draw.removePen', {index: 0});
  assert.deepEqual((await q.state('draw.usePen')).value, []);
  q = await open(host.savedPrefs);
  assert.deepEqual((await q.state('draw.usePen')).value, [], 'a person who removed every pen keeps an empty gallery');
  // A saved gallery keeps its pens and drops the junk around them.
  q = await open({draw: {pens: [{kind: 'pencil', color: [112, 48, 160], width: 3}, 'junk', {kind: 'crayon'}, {width: 'x'}, null]}});
  const kept = (await q.state('draw.usePen')).value;
  assert.deepEqual(kept.map(i => [i.icon, i.accent]), [['pencil', '#7030A0'], ['pen', '#000000']], 'a pen with no usable colour or width falls back to its kind\'s');
});

test('draw.erase: the eraser deletes the stroke it passes over and nothing else; one undo step each', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.stroke', {page: 0, points: rect(100, 200, 80, 40)});
  await q.exec('draw.stroke', {page: 0, points: rect(300, 400, 80, 40)});
  assert.equal(inkOf(q.t).length, 2);
  await q.exec('draw.erase', {page: 0, x: 140, y: 200});
  assert.equal(inkOf(q.t).length, 1, 'one stroke erased');
  await assert.rejects(() => q.exec('draw.erase', {page: 0, x: 500, y: 700}), /no ink stroke/, 'nothing under the eraser, nothing erased');
  assert.equal(inkOf(q.t).length, 1);
  await q.t.session.undo(q.t.docId);
  assert.equal(inkOf(q.t).length, 2, 'undo brings the stroke back');
});

test('draw.lasso: a loop selects the ink inside it; the selection moves, recolours and deletes', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.stroke', {page: 0, points: rect(100, 200, 60, 40)});
  await q.exec('draw.stroke', {page: 0, points: rect(400, 500, 60, 40)});
  const before = inkOf(q.t).map(o => o.float.x);
  const sel = await q.exec('draw.lasso', {page: 0, points: rect(80, 180, 120, 100)});
  assert.ok(sel, 'a result');
  assert.equal((await q.state('draw.lassoMove')).enabled, true, 'a selection is there');
  await q.exec('draw.lassoMove', {dx: 50, dy: 30});
  const moved = inkOf(q.t).map(o => o.float.x);
  assert.ok(Math.abs(moved[0] - (before[0] + 50)) < 0.5, `the selected stroke moved: ${moved[0]} vs ${before[0] + 50}`);
  assert.equal(moved[1], before[1], 'the other stroke stayed');
  await q.exec('draw.lassoColor', {color: '00B050'});
  assert.deepEqual([...inkOf(q.t)[0].stroke], [0, 176, 80]);
  await q.exec('draw.lassoDelete', {});
  assert.equal(inkOf(q.t).length, 1, 'the selected stroke is deleted');
  await q.exec('draw.lasso', {clear: true});
  assert.equal((await q.state('draw.lassoMove')).enabled, false, 'no selection after clear');
});

test('the lasso selection is dropped when the document changes', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.stroke', {page: 0, points: rect(100, 200, 60, 40)});
  await q.exec('draw.lasso', {page: 0, points: rect(80, 180, 120, 100)});
  assert.equal((await q.state('draw.lassoDelete')).enabled, true);
  q.sel(0, 0);
  await q.exec('text.insert', {text: 'x'});
  assert.equal((await q.state('draw.lassoDelete')).enabled, false);
});

test('Ink to Shape: a rough rectangle, ellipse, triangle, line become shapes; off keeps ink', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.stroke', {page: 0, points: rect(100, 200, 80, 40)});
  assert.equal(inkOf(q.t).length, 1, 'off: ink stays ink');
  await q.exec('draw.inkToShape', {value: true});
  assert.equal((await q.state('draw.inkToShape')).checked, true);
  const wobbly = rect(300, 200, 90, 50).map(([x, y], i) => [x + (i % 2) * 1.5, y - (i % 3) * 1.2]);
  await q.exec('draw.stroke', {page: 0, points: wobbly});
  const kinds = shapes(q.t).filter(o => !o.freeform?.ink).map(o => o.kind);
  assert.deepEqual(kinds, ['rectangle'], 'the rough rectangle became a rectangle');
  const circle = Array.from({length: 40}, (_, i) => [200 + Math.cos(i / 39 * 6.2832) * 40, 400 + Math.sin(i / 39 * 6.2832) * 30]);
  await q.exec('draw.stroke', {page: 0, points: circle});
  assert.ok(shapes(q.t).some(o => o.kind === 'ellipse' || o.kind === 'oval'), JSON.stringify(shapes(q.t).map(o => o.kind)));
  const line = Array.from({length: 20}, (_, i) => [100 + i * 10, 600 + i * 0.4]);
  await q.exec('draw.stroke', {page: 0, points: line});
  assert.ok(shapes(q.t).some(o => !o.freeform?.ink && o.kind === 'freeform' && o.freeform.paths[0].pts.length === 2), JSON.stringify(shapes(q.t).map(o => o.kind)));
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 650)});
  assert.equal(inkOf(q.t).length, 2, 'a squiggle is no shape, it stays ink');
});

test('recognise: shapes from points; a line and an arrowhead drawn apart pair into an arrow', () => {
  assert.equal(recognise(rect(0, 0, 100, 60)).type, 'rectangle');
  assert.equal(recognise(Array.from({length: 20}, (_, i) => [i * 10, i * 0.4])).type, 'line');
  const tri = [[50, 0], [100, 80], [0, 80], [50, 0]];
  assert.equal(recognise(tri).type, 'polygon');
  assert.equal(recognise(tri).corners.length, 3);
  assert.equal(recognise(squiggle(0, 0)), null);
  assert.equal(typeof arrowParts, 'function');
});

test('docx: ink saves as custom geometry and reads back as ink, in order, still erasable and selectable', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.pen', {color: 'C00000', width: 2.5});
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 200)});
  await q.exec('draw.highlighter', {});
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 300)});
  const bytes = await writeDocx(q.t.content);
  const back = await readDocx(bytes);
  const read = [];
  for (const chunk of back.body.chunks) for (const b of chunk) for (const o of b.objects ?? []) if (o?.type === 'shape') read.push(o);
  const ink = read.filter(o => o.freeform?.ink).sort((x, y) => x.freeform.order - y.freeform.order);
  assert.equal(ink.length, 2, 'both strokes read back as ink');
  assert.deepEqual(ink.map(o => o.freeform.order), inkOf(q.t).map(o => o.freeform.order), 'drawing order kept');
  assert.deepEqual([...ink[0].stroke], [192, 0, 0], 'the colour is kept');
  assert.equal(ink[1].float.wrap, 'behindText', 'the highlighter stays behind the text');
  assert.ok(Math.abs(ink[0].strokeWidth - 2.5) < 0.05, 'the thickness is kept');
  assert.ok(ink[0].freeform.paths[0].pts.length >= 3, 'the points are kept');

  // Open the saved file in a fresh session: the ink is selectable and erasable.
  const q2 = await quill(TEXT, c => { c.body = back.body; c.parts = back.parts ?? c.parts; });
  assert.equal(inkOf(q2.t).length, 2);
  await q2.exec('draw.lasso', {page: 0, points: rect(60, 150, 400, 220)});
  assert.equal((await q2.state('draw.lassoDelete')).enabled, true, 'selectable after reading');
  await q2.exec('draw.lassoDelete', {});
  assert.equal(inkOf(q2.t).length, 0, 'deletable after reading');
});

test('shapes and the Drawing Canvas round trip through docx', async () => {
  const q = await quill(TEXT);
  q.sel(0, 3);
  await q.exec('insert.canvas', {width: 300, height: 150, fill: 'FFF2CC', outline: '7F6000'});
  const canvas = blocks(q.t).flatMap(b => b.objects ?? []).find(o => o?.type === 'group');
  assert.ok(canvas, 'a canvas is inserted');
  assert.equal(canvas.w, 300);
  const back = await readDocx(await writeDocx(q.t.content));
  const c2 = back.body.chunks.flat().flatMap(b => b.objects ?? []).find(o => o?.type === 'group');
  assert.ok(c2, 'the canvas reads back');
  assert.deepEqual([c2.w, c2.h], [300, 150]);
  assert.deepEqual([...c2.canvas.fill], [255, 242, 204]);
  assert.deepEqual([...c2.canvas.stroke], [127, 96, 0]);
});

test('Ink Replay lists the strokes in drawing order and turns itself off; Hide Ink hides them', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 200)});
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 300)});
  const r = await q.exec('draw.replay', {value: true});
  assert.ok(r, 'replay result');
  assert.equal((await q.state('draw.replay')).checked, true);
  const orders = inkOrders(q.t.content);
  assert.equal(orders.length, 2);
  assert.ok(orders[0] < orders[1]);
  await q.exec('draw.replay', {value: false});
  assert.equal((await q.state('draw.replay')).checked, false);
  assert.equal((await q.state('review.hideInk')).checked, false);
  await q.exec('review.hideInk', {value: true});
  assert.equal((await q.state('review.hideInk')).checked, true);
  const items = [{freeform: {ink: 'pen', order: 1}}, {freeform: {ink: 'pen', order: 2}}, {freeform: null}];
  assert.equal(visibleItems(items, true, null).length, 1, 'hidden ink is not drawn');
  assert.equal(visibleItems(items, false, 1).length, 2, 'replay shows strokes up to the current one');
  assert.equal(visibleItems(items, false, null).length, 3);
});

test('the gesture a drag makes: pens draw, the eraser erases along the path, the lasso loops or moves', () => {
  const pts = [[10, 10], [20, 20], [30, 30]];
  assert.deepEqual(gesture('pen', 0, pts).map(g => g[0]), ['draw.stroke']);
  assert.deepEqual(gesture('highlighter', 0, pts).map(g => g[0]), ['draw.stroke']);
  assert.deepEqual(gesture('eraser', 0, pts).map(g => g[0]), ['draw.erase', 'draw.erase', 'draw.erase']);
  assert.deepEqual(gesture('lasso', 0, pts).map(g => g[0]), ['draw.lasso']);
  assert.deepEqual(gesture('lasso', 0, [[1, 1]]).map(g => g[0]), ['draw.lasso'], 'a click clears');
  const sel = {page: 0, rect: {x: 0, y: 0, w: 100, h: 100}};
  assert.deepEqual(gesture('lasso', 0, [[10, 10], [40, 25]], sel), [['draw.lassoMove', {dx: 30, dy: 15}]], 'a drag from inside the selection moves it');
  assert.deepEqual(gesture('select', 0, pts), []);
});

test('drawing is not allowed where there is no page to draw on', async () => {
  const q = await quill(TEXT);
  await assert.rejects(() => q.exec('draw.stroke', {page: 9, points: squiggle(10, 10)}));
});

test('draw.penWidth: the thickness of the pen in use (and its gallery pen); the list is the kind\'s widths; clamped', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.pen', {});
  assert.deepEqual((await q.state('draw.penWidth')).value.map(w => w.value), [0.5, 1, 1.5, 2.5, 3.5, 5], 'the pen widths');
  await q.exec('draw.penWidth', {width: 3.5});
  assert.equal((await q.state('draw.penWidth', {width: 3.5})).checked, true);
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 200)});
  assert.equal(inkOf(q.t)[0].strokeWidth, 3.5);
  await q.exec('draw.highlighter', {});
  assert.deepEqual((await q.state('draw.penWidth')).value.map(w => w.value), [4, 8, 12, 18, 24], 'the highlighter widths');
  // A gallery pen keeps in step with the thickness.
  await q.exec('draw.pen', {color: '0070C0'});
  await q.exec('draw.addPen', {kind: 'pen', current: true});
  await q.exec('draw.penWidth', {width: 5});
  assert.equal((await q.state('draw.usePen')).value[0].bar > 0, true);
  await q.exec('draw.penWidth', {width: 1e9});
  assert.equal((await q.exec('draw.pen', {})).result.pen.width, 72, 'clamped to the largest thickness');
});

test('draw.convertInk: converts the lasso-selected strokes that look like shapes; a line and a head become one arrow', async () => {
  const q = await quill(TEXT);
  await q.exec('draw.stroke', {page: 0, points: rect(100, 400, 120, 60)});
  await q.exec('draw.stroke', {page: 0, points: squiggle(100, 520)});
  assert.equal(inkOf(q.t).length, 2);
  assert.equal((await q.state('draw.convertInk')).enabled, false, 'nothing is selected');
  await q.exec('draw.lasso', {page: 0, points: rect(60, 360, 400, 200)});
  const r = (await q.exec('draw.convertInk', {})).result;
  assert.deepEqual(r.converted.map(c => c.shape).filter(Boolean), ['rectangle']);
  assert.equal(inkOf(q.t).length, 1, 'the squiggle stays ink');
  assert.ok(shapes(q.t).some(o => o.kind === 'rectangle'));
  await q.t.undo();
  assert.equal(inkOf(q.t).length, 2, 'one undo step');
});

test('a gallery pen follows the colour and thickness changes made while it is in use; the plain tools never touch the gallery', async () => {
  const q = await quill(TEXT);
  const accents = async () => (await q.state('draw.usePen')).value.map(i => i.accent);
  const before = await accents();
  await q.exec('draw.pen', {color: '7030A0', width: 3.5});
  await q.exec('draw.penColor', {color: '00B050'});
  assert.deepEqual(await accents(), before, 'the plain Pen button is no gallery pen');
  await q.exec('draw.usePen', {index: 2});
  assert.equal((await q.state('draw.usePen')).value[2].selected, true, 'the tile in use is selected');
  await q.exec('draw.penColor', {color: 'ED7D31'});
  await q.exec('draw.penWidth', {width: 5});
  const now = (await q.state('draw.usePen')).value;
  assert.equal(now[2].accent, '#ED7D31');
  assert.ok(now[2].label.includes('5 pt'));
  assert.equal(now.filter(i => i.selected).length, 1);
  await q.exec('draw.removePen', {index: 0});
  assert.equal((await q.state('draw.usePen')).value[1].selected, true, 'removing an earlier pen keeps the one in use');
  await q.exec('draw.removePen', {index: 1});
  assert.equal((await q.state('draw.usePen')).value.some(i => i.selected), false, 'removing the pen in use leaves none selected');
});
