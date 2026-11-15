// Ported from wordcraft crates/engine/src/cmd/draw/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c
// (MIT, see assets/third-party-licenses/artcraft-reference.txt): the Draw tab's engine tests. Each test names
// the Rust test it ports. Upstream's `document.setText` is the fixture's text; its `s.view.draw` is read back
// through the commands' results and states; `s.undo_depth()` is the session's undo stack size.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from '../format-fixture.mjs';
import * as P from '../../../core/quill/model/para.mjs';
import {layout} from '../../../core/quill/layout/index.mjs';
import {read as readDocx} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';
import {MAX_WIDTH, MAX_PENS} from '../../../core/quill/lib/draw-ink.mjs';

const TEXT = 'First paragraph of text.\nSecond paragraph of text.';
const session = () => quill(TEXT);
const result = async (q, id, params = {}) => (await q.exec(id, params)).result;
const depth = q => q.t.doc.undo.size;
const objectsOf = content => content.body.chunks.flat().flatMap(b => b.objects ?? []);
const drawings = q => objectsOf(q.t.content).filter(o => o?.type === 'shape');
const ink = q => drawings(q).filter(o => o.freeform?.ink).sort((a, b) => a.freeform.order - b.freeform.order);
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const rectStroke = (x, y, w, h) => {
  const c = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const [a, b] = [c[i], c[(i + 1) % 4]];
    for (let k = 0; k < 10; k++) { const t = k / 10; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  pts.push([x, y]);
  return pts;
};
const shaftStroke = () => Array.from({length: 41}, (_, i) => [100 + i * 5, 300]);
const rejects = (q, id, params, msg) => assert.rejects(() => q.exec(id, params), undefined, msg);
/** Select the ink object `n` (document order) as a drawing, the way select.objects index does. */
function selectObject(q, n) {
  let k = 0;
  const bl = blocks(q.t);
  for (let b = 0; b < bl.length; b++) {
    for (const [off] of P.objectsWithOffsets(bl[b])) {
      if (k++ === n) { q.t.session.setSelection(q.t.docId, {ranges: [{anchor: `/body/b:${bl[b].id}/t:${off}`, focus: `/body/b:${bl[b].id}/t:${off + 1}`}], primary: 0}); return; }
    }
  }
  throw new Error('no such object');
}
const pageRect = (q, page = 0) => layout(q.t.content, {view: 'print'}).pages[page].items.filter(i => i.kind === 'object').map(i => i.rect);

test('a_stroke_inserts_floating_ink_through_its_points_in_one_undo_step', async () => {
  const q = await session();
  const text = q.texts();
  const r = await result(q, 'draw.stroke', {page: 0, points: [[100, 90], [150, 120], [200, 95]], color: 'C00000', width: 2});
  assert.deepEqual([r.rect[0], r.rect[1]], [99, 89], "the points' bounds, grown by half the width");
  const objs = ink(q);
  assert.equal(objs.length, 1, 'one stroke');
  const [o] = objs;
  assert.deepEqual([[...o.stroke], o.strokeWidth, o.float.wrap], [[0xC0, 0, 0], 2, 'inFrontOfText']);
  assert.equal(o.freeform.ink, 'pen');
  assert.deepEqual(o.freeform.paths[0].pts, [[1, 1], [51, 31], [101, 6]], 'shape-local');
  const rect = pageRect(q)[0];
  assert.ok(approx(rect.x, 99) && approx(rect.y, 89), `laid out where it was drawn: ${JSON.stringify(rect)}`);
  await q.t.undo();
  assert.equal(ink(q).length, 0);
  assert.deepEqual(q.texts(), text);
  await result(q, 'draw.highlighter', {color: '00FF00'});
  await result(q, 'draw.stroke', {page: 0, points: [[80, 80]]});
  const [h] = ink(q);
  assert.deepEqual([h.float.wrap, h.freeform.ink, [...h.stroke]], ['behindText', 'highlighter', [0, 0xFF, 0]]);
  assert.ok(h.freeform.alpha < 1);
  await rejects(q, 'draw.stroke', {page: 0, points: [[100, 90], [NaN, 3]]}, 'a point that is not a number is refused');
  await rejects(q, 'draw.stroke', {page: 99, points: [[1, 1]]}, 'a page that is not there');
  await rejects(q, 'draw.stroke', {page: 0, points: [['x', 1], [1]]}, 'points that are no points');
  await rejects(q, 'draw.stroke', {page: 0, points: [[1, 1]], tool: 'crayon'}, 'a tool that is not one');
});

test('the_eraser_removes_the_stroke_under_the_point_and_hide_ink_hides_it', async () => {
  const q = await session();
  await result(q, 'draw.stroke', {page: 0, points: [[100, 100], [200, 100]], width: 2});
  await rejects(q, 'draw.eraser', {page: 0, x: 150, y: 130}, 'nothing there');
  assert.equal(ink(q).length, 1);
  assert.equal((await result(q, 'review.hideInk', {})).value, true);
  assert.equal((await q.state('review.hideInk')).checked, true);
  await rejects(q, 'draw.eraser', {page: 0, x: 150, y: 101});
  await result(q, 'review.hideInk', {value: false});
  await result(q, 'draw.eraser', {page: 0, x: 150, y: 101});
  assert.equal(ink(q).length, 0);
  // Without a point it picks up the eraser; Select puts it down.
  await result(q, 'draw.eraser', {});
  assert.equal((await q.state('draw.eraser')).checked, true);
  const pencil = await result(q, 'draw.pencil', {width: 1e9});
  assert.equal(pencil.pencil.width, MAX_WIDTH);
  assert.equal((await q.state('draw.pencil')).checked, true);
  await result(q, 'draw.select', {});
  assert.equal((await q.state('draw.select')).checked, true);
});

test('a_rotated_stroke_is_erased_where_it_is_drawn (#445)', async () => {
  const rotated = async () => {
    const q = await session();
    await result(q, 'draw.stroke', {page: 0, points: [[100, 100], [200, 100]], width: 2, color: '000000'});
    selectObject(q, 0);
    await result(q, 'arrange.rotation', {degrees: 90});
    return q;
  };
  let q = await rotated();
  await rejects(q, 'draw.erase', {page: 0, x: 110, y: 100}, 'its old horizontal path is blank now');
  assert.equal(ink(q).length, 1);
  await result(q, 'draw.erase', {page: 0, x: 150, y: 60});
  assert.equal(ink(q).length, 0, 'the visible vertical stroke is erased');
  q = await rotated();
  await result(q, 'draw.eraser', {page: 0, x: 150, y: 140});
  assert.equal(ink(q).length, 0, 'the point-taking eraser too');
  q = await rotated();
  await result(q, 'review.hideInk', {value: true});
  await rejects(q, 'draw.erase', {page: 0, x: 150, y: 60}, 'hidden ink stays out of reach');
});

test('the_lasso_selects_a_rotated_stroke_where_it_is_drawn', async () => {
  const q = await session();
  await result(q, 'draw.stroke', {page: 0, points: [[100, 100], [200, 100]], width: 2});
  selectObject(q, 0);
  await result(q, 'arrange.rotation', {degrees: 90});
  let r = await result(q, 'draw.lasso', {page: 0, points: [[90, 95], [210, 95], [210, 105], [90, 105]]});
  assert.equal(r.count, 0);
  r = await result(q, 'draw.lasso', {page: 0, points: [[140, 40], [160, 40], [160, 160], [140, 160]]});
  assert.equal(r.count, 1);
});

test('erasing_through_the_eraser_command_is_undoable_and_marks_the_document_dirty', async () => {
  const q = await session();
  await result(q, 'draw.stroke', {page: 0, points: [[100, 100], [200, 100]], width: 2});
  const steps = depth(q), version = q.t.version;
  await result(q, 'draw.eraser', {page: 0, x: 150, y: 101});
  assert.equal(ink(q).length, 0);
  assert.ok(q.t.version > version, 'erasing is a change');
  assert.equal(depth(q), steps + 1, 'one undo step');
  await q.t.undo();
  assert.equal(ink(q).length, 1, 'undo brings the stroke back');
  await q.t.redo();
  assert.equal(ink(q).length, 0);
});

test('the_lasso_selects_the_ink_inside_and_moves_recolours_and_deletes_it', async () => {
  const q = await session();
  await result(q, 'draw.stroke', {page: 0, points: [[100, 100], [140, 110]]});
  await result(q, 'draw.stroke', {page: 0, points: [[300, 300], [340, 310]]});
  await result(q, 'draw.lasso', {});
  assert.equal((await q.state('draw.lasso')).checked, true);
  let r = await result(q, 'draw.lasso', {page: 0, points: [[80, 80], [200, 80], [200, 150], [80, 150]]});
  assert.equal(r.count, 1);
  const sizeBefore = pageRect(q).map(x => [x.x, x.y]);
  const steps = depth(q);
  await result(q, 'draw.lassoMove', {dx: 20, dy: -10});
  await result(q, 'draw.lassoColor', {color: '0070C0'});
  assert.equal(depth(q), steps + 2);
  const sizeAfter = pageRect(q).map(x => [x.x, x.y]);
  const moved = sizeAfter.filter(([x, y]) => sizeBefore.some(([bx, by]) => approx(x - bx, 20) && approx(y - by, -10)));
  assert.equal(moved.length, 1, `the selected stroke moved by (20, -10): ${JSON.stringify([sizeBefore, sizeAfter])}`);
  assert.equal(ink(q).filter(o => o.stroke.join() === '0,112,192').length, 1);
  await result(q, 'draw.lassoColor', {color: '0070C0'});
  assert.equal(depth(q), steps + 2, 'recolouring to the colour it has changes nothing');
  assert.equal((await q.state('draw.lassoDelete')).enabled, true, 'the selection stays');
  q.sel(0, 0);
  await result(q, 'text.insert', {text: 'x'});
  assert.equal((await q.state('draw.lassoDelete')).enabled, false, 'an edit elsewhere ends it');
  r = await result(q, 'draw.lasso', {page: 0, points: [[80, 80], [260, 80], [260, 180], [80, 180]]});
  assert.equal(r.count, 1);
  await result(q, 'draw.lassoDelete', {});
  assert.equal(ink(q).length, 1);
  assert.equal((await q.state('draw.lassoDelete')).enabled, false, 'and the selection with it');
  await rejects(q, 'draw.lassoMove', {dx: 1, dy: 1}, 'nothing selected');
  await rejects(q, 'draw.lasso', {page: 0, points: [[1, 1], [2, 2]]}, 'a loop needs three points');
  const huge = Array.from({length: 20_000}, (_, i) => [i % 600, Math.floor(i / 40)]);
  await q.exec('draw.lasso', {page: 0, points: huge}).catch(() => {});
});

test('ink_to_shape_turns_shape_like_strokes_into_shapes_and_leaves_scribbles', async () => {
  const q = await session();
  assert.equal((await result(q, 'draw.inkToShape', {})).value ?? true, true);
  assert.equal((await q.state('draw.inkToShape')).checked, true);
  const steps = depth(q);
  let r = await result(q, 'draw.stroke', {page: 0, points: rectStroke(100, 100, 120, 60), color: 'C00000', width: 2});
  assert.equal(r.shape, 'rectangle');
  assert.equal(depth(q), steps + 1, 'drawn and converted in one undo step');
  const [o] = drawings(q);
  assert.deepEqual([o.kind, [...o.stroke], o.strokeWidth, o.freeform === undefined || o.freeform === null], ['rectangle', [0xC0, 0, 0], 2, true]);
  assert.ok(Math.abs(o.w - 120) < 2 && Math.abs(o.h - 60) < 2, `${o.w} x ${o.h}`);
  const rect = pageRect(q)[0];
  assert.ok(Math.abs(rect.x - 100) < 2 && Math.abs(rect.y - 100) < 2, `where it was drawn: ${JSON.stringify(rect)}`);
  r = await result(q, 'draw.stroke', {page: 0, points: [[300, 300], [320, 340], [340, 300], [360, 340], [380, 300]]});
  assert.ok(r.shape === null || r.shape === undefined, 'a scribble stays ink');
  assert.equal(ink(q).length, 1);
  await result(q, 'draw.inkToShape', {value: false});
  const ring = Array.from({length: 49}, (_, i) => { const a = i / 48 * Math.PI * 2; return [200 + 50 * Math.cos(a), 500 + 30 * Math.sin(a)]; });
  await result(q, 'draw.stroke', {page: 0, points: ring});
  assert.equal(ink(q).length, 2);
  await result(q, 'draw.lasso', {page: 0, points: [[130, 450], [270, 450], [270, 550], [130, 550]]});
  r = await result(q, 'draw.inkToShape', {});
  assert.equal(r.converted[0].shape, 'ellipse');
  assert.equal(ink(q).length, 1);
  assert.equal((await q.state('draw.inkToShape')).checked, false, "converting the selection doesn't turn the mode on");
});

test('ink_to_shape_turns_an_arrow_stroke_into_a_line_shape_with_a_head_that_survives_docx', async () => {
  const q = await session();
  await result(q, 'draw.inkToShape', {value: true});
  const tail = [300, 200], tip = [100, 300];
  const back = Math.atan2(tail[1] - tip[1], tail[0] - tip[0]);
  const barb = sign => [tip[0] + 30 * Math.cos(back + sign * 0.5), tip[1] + 30 * Math.sin(back + sign * 0.5)];
  const pts = Array.from({length: 20}, (_, i) => i / 20).map(t => [tail[0] + (tip[0] - tail[0]) * t, tail[1] + (tip[1] - tail[1]) * t]);
  pts.push(tip, barb(1), tip, barb(-1));
  const r = await result(q, 'draw.stroke', {page: 0, points: pts, color: 'C00000', width: 2});
  assert.equal(r.shape, 'arrow');
  const [o] = drawings(q);
  assert.deepEqual([o.kind, [...o.stroke], o.strokeWidth, !o.freeform], ['straightConnector', [0xC0, 0, 0], 2, true]);
  assert.ok(o.extra.arrowEnd && !o.extra.arrowStart);
  assert.ok(o.float.flipH && !o.float.flipV, JSON.stringify(o.float));
  assert.ok(Math.abs(o.w - 200) < 1 && Math.abs(o.h - 100) < 1, `${o.w} x ${o.h}`);
  const again = objectsOf(await readDocx(await writeDocx(q.t.content)));
  const c = again.find(x => x?.type === 'shape' && x.kind === 'straightConnector');
  assert.ok(c, JSON.stringify(again));
  assert.ok(c.extra.arrowEnd && !c.extra.arrowStart && c.float.flipH, JSON.stringify([c.extra, c.float]));
});

test('ink_to_shape_turns_a_line_and_a_head_drawn_after_it_into_one_arrow_in_one_undo_step', async () => {
  const q = await session();
  await result(q, 'draw.inkToShape', {value: true});
  let r = await result(q, 'draw.stroke', {page: 0, points: shaftStroke(), color: 'C00000', width: 2});
  assert.equal(r.shape, 'line');
  const steps = depth(q);
  const head = [[274, 285], [287, 292.5], [300, 300], [287, 307.5], [274, 315]];
  r = await result(q, 'draw.stroke', {page: 0, points: head});
  assert.equal(r.shape, 'arrow');
  assert.equal(depth(q), steps + 1, 'paired in one undo step');
  assert.equal(ink(q).length, 0, 'the head stroke is gone');
  const all = drawings(q);
  assert.equal(all.length, 1, 'one arrow');
  const [o] = all;
  assert.deepEqual([o.kind, [...o.stroke], o.strokeWidth], ['straightConnector', [0xC0, 0, 0], 2]);
  assert.ok(o.extra.arrowEnd && !o.extra.arrowStart && !o.float.flipH && !o.float.flipV, JSON.stringify([o.extra, o.float]));
  assert.ok(Math.abs(o.w - 200) < 1, `${o.w}`);
  const rect = pageRect(q)[0];
  assert.ok(Math.abs(rect.x - 100) < 1 && Math.abs(rect.y - 300) < 1, `where the line was: ${JSON.stringify(rect)}`);
  assert.ok([rect.x, rect.y, rect.w, rect.h].every((v, i) => Math.abs(v - r.rect[i]) < 0.5), `the arrow's rect, not the deleted head's: ${JSON.stringify(r.rect)} vs ${JSON.stringify(rect)}`);
  const again = objectsOf(await readDocx(await writeDocx(q.t.content)));
  assert.ok(again.some(x => x?.type === 'shape' && x.kind === 'straightConnector' && x.extra?.arrowEnd && !x.extra?.arrowStart), JSON.stringify(again));
  await q.t.undo();
  const undone = drawings(q);
  assert.equal(undone.length, 1);
  assert.equal(undone[0].kind, 'freeform');
  assert.ok(!undone[0].extra?.arrowEnd);
  assert.equal(ink(q).length, 0);
});

test('ink_to_shape_pairs_a_closed_triangle_head_at_the_start_and_a_head_drawn_first', async () => {
  let q = await session();
  await result(q, 'draw.inkToShape', {value: true});
  await result(q, 'draw.stroke', {page: 0, points: shaftStroke()});
  const tri = [[100, 300], [113, 292.5], [126, 285], [126, 300], [126, 315], [113, 307.5], [100, 300]];
  let r = await result(q, 'draw.stroke', {page: 0, points: tri});
  assert.equal(r.shape, 'arrow');
  let all = drawings(q);
  assert.equal(all.length, 1);
  assert.ok(all[0].kind === 'straightConnector' && all[0].extra.arrowEnd && all[0].float.flipH && !all[0].float.flipV, `tip at the left: ${JSON.stringify([all[0].extra, all[0].float])}`);
  q = await session();
  await result(q, 'draw.inkToShape', {value: true});
  r = await result(q, 'draw.stroke', {page: 0, points: [[274, 285], [300, 300], [274, 315]]});
  assert.ok(r.shape === null || r.shape === undefined);
  r = await result(q, 'draw.stroke', {page: 0, points: shaftStroke()});
  assert.equal(r.shape, 'arrow');
  assert.equal(ink(q).length, 0);
  all = drawings(q);
  assert.equal(all.length, 1);
  assert.ok(all[0].kind === 'straightConnector' && all[0].extra.arrowEnd && !all[0].float.flipH, JSON.stringify([all[0].extra, all[0].float]));
  q = await session();
  await result(q, 'draw.inkToShape', {value: true});
  await result(q, 'draw.stroke', {page: 0, points: shaftStroke()});
  r = await result(q, 'draw.stroke', {page: 0, points: [[174, 385], [200, 400], [174, 415]]});
  assert.ok(r.shape === null || r.shape === undefined, 'a V far from the line\'s ends stays ink');
  assert.equal(ink(q).length, 1);
  assert.ok(drawings(q).every(o => o.kind !== 'straightConnector'));
});

test('converting_a_lasso_selection_pairs_a_line_and_a_head_stroke_into_an_arrow', async () => {
  const q = await session();
  await result(q, 'draw.stroke', {page: 0, points: shaftStroke(), color: '0070C0'});
  await result(q, 'draw.stroke', {page: 0, points: [[274, 285], [300, 300], [274, 315]]});
  await result(q, 'draw.stroke', {page: 0, points: rectStroke(100, 400, 120, 60)});
  assert.equal(ink(q).length, 3);
  const steps = depth(q);
  await result(q, 'draw.lasso', {page: 0, points: [[80, 260], [340, 260], [340, 480], [80, 480]]});
  const r = await result(q, 'draw.inkToShape', {});
  const names = r.converted.map(c => c.shape).filter(Boolean);
  assert.ok(names.includes('arrow') && names.includes('rectangle'), JSON.stringify(names));
  assert.equal(ink(q).length, 0, 'the head stroke went into the arrow');
  const all = drawings(q);
  assert.equal(all.length, 2);
  const arrow = all.find(o => o.kind === 'straightConnector');
  assert.ok(arrow.extra.arrowEnd && arrow.stroke.join() === '0,112,192');
  await result(q, 'draw.lassoDelete', {});
  assert.equal(drawings(q).length, 0, 'the selection still holds what is left: deleting it removes both shapes');
  await q.t.undo();
  assert.equal(drawings(q).length, 2);
  await q.t.undo();
  assert.equal(ink(q).length, 3, 'one undo step brings all three strokes back');
  assert.equal(depth(q), steps);
});

test('converting_a_crowded_lasso_selection_recognises_each_stroke_a_bounded_number_of_times', async () => {
  const q = await session();
  await result(q, 'draw.stroke', {page: 0, points: shaftStroke()});
  await result(q, 'draw.stroke', {page: 0, points: [[274, 285], [300, 300], [274, 315]]});
  const n = 40;
  for (let i = 0; i < n; i++) {
    const y = 420 + i * 2;
    await result(q, 'draw.stroke', {page: 0, points: Array.from({length: 41}, (_, k) => [100 + k * 5, y])});
  }
  await result(q, 'draw.lasso', {page: 0, points: [[80, 260], [340, 260], [340, 560], [80, 560]]});
  const t0 = Date.now();
  const r = await result(q, 'draw.inkToShape', {});
  assert.ok(Date.now() - t0 < 20_000, 'the crowded selection converts in bounded time');
  const names = r.converted.map(c => c.shape).filter(Boolean);
  assert.equal(names.filter(x => x === 'arrow').length, 1, JSON.stringify(names));
  assert.equal(names.filter(x => x === 'line').length, n, JSON.stringify(names));
  assert.equal(ink(q).length, 0);
});

test('ink_replay_plays_strokes_in_the_order_they_were_drawn', async () => {
  const q = await session();
  await result(q, 'draw.stroke', {page: 0, points: [[100, 400], [150, 400]]});
  await result(q, 'draw.stroke', {page: 0, points: [[100, 90], [150, 90]]});
  const r = await result(q, 'draw.replay', {});
  assert.equal((await q.state('draw.replay')).checked, true);
  assert.deepEqual(r.strokes.map(k => k.order), [1, 2]);
  const ys = ink(q).map(o => o.float.y);
  assert.ok(ys[0] > ys[1], `the lower stroke was drawn first: ${JSON.stringify(ys)}`);
  assert.equal((await result(q, 'draw.replay', {})).replaying, false);
  await rejects(await session(), 'draw.replay', {}, 'nothing to replay without ink');
});

test('add_pen_validates_and_saved_galleries_drop_junk', async () => {
  const q = await session();
  const r = await result(q, 'draw.addPen', {kind: 'highlighter', color: '00B050', width: 1e9});
  assert.deepEqual(r.pen, {kind: 'highlighter', color: '00B050', width: MAX_WIDTH});
  assert.equal((await q.state('draw.highlighter')).checked, true, 'the new pen is picked up');
  for (const bad of [{kind: 'crayon'}, {color: 'blue'}]) await rejects(q, 'draw.addPen', bad, JSON.stringify(bad));
  for (let i = 0; i < MAX_PENS + 3; i++) await q.exec('draw.addPen', {}).catch(() => {});
  assert.equal((await q.state('draw.usePen')).value.length, MAX_PENS);
  await result(q, 'draw.removePen', {index: 0});
  await rejects(q, 'draw.removePen', {index: 999});
});
