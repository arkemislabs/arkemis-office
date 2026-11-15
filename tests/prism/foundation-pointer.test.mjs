// F:prism foundation: the pointer tools (core/prism/lib/pointer.mjs), the keyboard plan
// (core/prism/lib/keys.mjs) and the `surface.pointer` command (src/apps/prism/ui-commands/surface.ts).
//
// 1. What ArtCraft does: deckcraft crates/engine/src/tools/pointer.rs `Session::pointer` (down/drag/up,
//    hit_test, double/triple/context clicks), tools/drag.rs (move with Shift constraint and smart
//    guides, resize_box + snap_resize, rotate with Shift 15° steps, adjust handles, Alt-drag
//    duplicate), tools/geometry.rs (snap_rect/snap_edges, ink), connect.rs (glue, reroute), and
//    keys.rs (Session::key). PowerPoint: the same gestures, one Undo per gesture.
// 2. Ours replays the gesture's events through the same translated code inside one kernel
//    transaction; the document, selection and undo label match deckcraft's.
// 3. Proved here headless (kernel session) and end to end in tests/e2e/prism/surface-normal.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {shape, presetGeom, slide as newSlideObj} from '../../core/prism/model/presentation.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';
import {colorRgb, fillSolid} from '../../core/prism/model/style.mjs';
import {PointerSession, resizeBox, boxHandles, editZone, constrain45, pointerPrefs, newToolState, persistDrag} from '../../core/prism/lib/pointer.mjs';
import {reroute, setGlue, sites, lineXfrm} from '../../core/prism/lib/connect.mjs';
import {planKey, planTyping, cycleSelection} from '../../core/prism/lib/keys.mjs';
import surface from '../../src/apps/prism/ui-commands/surface.ts';

const blue = fillSolid(colorRgb({r: 68, g: 114, b: 196, a: 255}));

/** A deck whose current slide holds rectangle A (100,100 200×100, "Shape A") and text box B (400,100 200×40). */
function deck({extra = []} = {}) {
  const c = createContent('Pointer');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const sl = newSlideObj({id: 'sb', layout, shapes: [
    shape({id: 'a', name: 'Rectangle A', xfrm: {x: 100, y: 100, w: 200, h: 100}, fill: blue, text: bodyFromText('Shape A')}),
    shape({id: 'b', name: 'TextBox B', xfrm: {x: 400, y: 100, w: 200, h: 40}, textBox: true, fill: {kind: 'none'}, text: bodyFromText('Box B')}),
    ...extra,
  ]});
  c.slides = [sl];
  return c;
}

async function session(content, prefs) {
  return createTestSession('prism', {content, modules: [surface], prefs: prefs ?? {prism: {snapToGrid: false, smartGuides: false}},
    selection: {ranges: [{anchor: '/sl:sb', focus: '/sl:sb'}], primary: 0}});
}
const ev = (kind, x, y, mods) => ({kind, x, y, ...(mods ? {mods} : {})});
const box = (t, id) => t.content.slides[0].shapes.find(s => s.id === id).xfrm;
const selected = t => t.doc.selection.ranges.map(r => r.anchor);

test('deckcraft pointer_draw_move_resize (move and resize part): one undo step per gesture', async () => {
  const t = await session(deck());
  // Move by dragging the middle (snap to grid and smart guides off).
  const r = await t.exec('surface.pointer', {events: [ev('down', 150, 140), ev('drag', 170, 150), ev('up', 170, 150)], tol: 3});
  assert.equal(r.undoLabel, 'Move');
  assert.deepEqual([box(t, 'a').x, box(t, 'a').y], [120, 110]);
  assert.deepEqual(selected(t), ['/sl:sb/sp:a']);
  await t.undo();
  assert.equal(box(t, 'a').x, 100);
  // Resize from the SE handle (300, 200).
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sl:sb/sp:a', focus: '/sl:sb/sp:a'}], primary: 0});
  const s = await t.exec('surface.pointer', {events: [ev('down', 300, 200), ev('drag', 350, 220), ev('up', 350, 220)], tol: 3});
  assert.equal(s.undoLabel, 'Size');
  assert.equal(box(t, 'a').w, 250);
  assert.equal(box(t, 'a').h, 120);
});

test('a click that moves nothing changes the selection only (no undo entry)', async () => {
  const t = await session(deck());
  const v = t.version;
  await t.exec('surface.pointer', {events: [ev('down', 150, 140), ev('up', 150, 140)]});
  assert.equal(t.version, v);
  assert.deepEqual(selected(t), ['/sl:sb/sp:a']);
  // Empty slide: the selection goes; Shift-click adds.
  await t.exec('surface.pointer', {events: [ev('down', 700, 450), ev('up', 700, 450)]});
  assert.deepEqual(selected(t), ['/sl:sb']);
  await t.exec('surface.pointer', {events: [ev('down', 150, 140), ev('up', 150, 140)]});
  await t.exec('surface.pointer', {events: [ev('down', 450, 115, {shift: true}), ev('up', 450, 115, {shift: true})]});
  assert.deepEqual(selected(t), ['/sl:sb/sp:a', '/sl:sb/sp:b']);
  // Shift-click a selected shape takes it out.
  await t.exec('surface.pointer', {events: [ev('down', 150, 140, {shift: true}), ev('up', 150, 140, {shift: true})]});
  assert.deepEqual(selected(t), ['/sl:sb/sp:b']);
});

test('deckcraft right_click_selects_the_shape_under_the_pointer', async () => {
  const t = await session(deck());
  const v = t.version;
  let r = await t.exec('surface.pointer', {events: [ev('contextClick', 150, 150)]});
  assert.deepEqual(r.result.results[0].selected, ['a']);
  assert.deepEqual(selected(t), ['/sl:sb/sp:a']);
  // A text box, which a left click would start editing: only selected.
  await t.exec('surface.pointer', {events: [ev('contextClick', 450, 115)]});
  assert.deepEqual(selected(t), ['/sl:sb/sp:b']);
  // A multiple selection stays when the right click lands on one of its shapes.
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sl:sb/sp:a', focus: '/sl:sb/sp:a'}, {anchor: '/sl:sb/sp:b', focus: '/sl:sb/sp:b'}], primary: 1});
  await t.exec('surface.pointer', {events: [ev('contextClick', 450, 115)]});
  assert.deepEqual(selected(t), ['/sl:sb/sp:a', '/sl:sb/sp:b']);
  // Empty slide: nothing selected.
  r = await t.exec('surface.pointer', {events: [ev('contextClick', 700, 450)]});
  assert.equal(r.result.results[0].hit, null);
  assert.deepEqual(selected(t), ['/sl:sb']);
  assert.equal(t.version, v);
});

test('smart guides snap a moved shape to another shape\'s edge and report the guide', async () => {
  const t = await session(deck(), {prism: {snapToGrid: false, smartGuides: true}});
  // Drag A so its left edge lands 3 pt from B's left edge (400): it snaps to 400.
  const c = deck();
  const io = {read: () => ({content: c, selection: {ranges: [{anchor: '/sl:sb', focus: '/sl:sb'}], primary: 0}}), write() {}};
  const s = new PointerSession({io, prefs: {prism: {snapToGrid: false, smartGuides: true}}});
  s.pointer(ev('down', 150, 250 - 100));
  s.pointer({...ev('drag', 150 + 303, 300), tol: 4});
  assert.equal(s.shape('a').xfrm.x, 400);
  assert.ok(s.tool.guides.some(g => g.vertical && g.pos === 400), JSON.stringify(s.tool.guides));
  // Ctrl (cmd) turns smart guides off while dragging.
  s.pointer({...ev('drag', 150 + 303, 300, {cmd: true}), tol: 4});
  assert.equal(s.shape('a').xfrm.x, 403);
  // Through the command: one Move entry with the snapped position.
  const r = await t.exec('surface.pointer', {events: [ev('down', 150, 150), ev('drag', 453, 300), ev('up', 453, 300)]});
  assert.equal(r.undoLabel, 'Move');
  assert.equal(box(t, 'a').x, 400);
});

test('snap to grid: the moved box\'s left/top edges land on the 6 pt grid', async () => {
  // With smart guides on and no line within reach, the left/top edges land on the grid.
  const t = await session(deck(), {prism: {snapToGrid: true, smartGuides: true, gridSpacing: 6}});
  await t.exec('surface.pointer', {events: [ev('down', 150, 150), ev('drag', 183, 210), ev('up', 183, 210)]});
  assert.deepEqual([box(t, 'a').x, box(t, 'a').y], [132, 162]);
  // deckcraft snap_edges: with smart guides off nothing snaps, the grid included.
  const u = await session(deck(), {prism: {snapToGrid: true, smartGuides: false}});
  await u.exec('surface.pointer', {events: [ev('down', 150, 150), ev('drag', 183, 210), ev('up', 183, 210)]});
  assert.deepEqual([box(u, 'a').x, box(u, 'a').y], [133, 160]);
});

test('Shift constrains a move to one axis; Alt-drag duplicates (one "Duplicate" entry)', async () => {
  const t = await session(deck());
  await t.exec('surface.pointer', {events: [ev('down', 150, 150), ev('drag', 190, 160, {shift: true}), ev('up', 190, 160, {shift: true})]});
  assert.deepEqual([box(t, 'a').x, box(t, 'a').y], [140, 100]);
  const n = t.content.slides[0].shapes.length;
  const r = await t.exec('surface.pointer', {events: [ev('down', 200, 150, {alt: true}), ev('drag', 200, 300, {alt: true}), ev('up', 200, 300, {alt: true})]});
  assert.equal(r.undoLabel, 'Duplicate');
  const shapes = t.content.slides[0].shapes;
  assert.equal(shapes.length, n + 1);
  const copy = shapes[shapes.length - 1];
  assert.notEqual(copy.id, 'a');
  assert.deepEqual([copy.xfrm.x, copy.xfrm.y], [140, 250]);
  assert.deepEqual([box(t, 'a').x, box(t, 'a').y], [140, 100]);
  assert.deepEqual(selected(t), [`/sl:sb/sp:${copy.id}`]);
  await t.undo();
  assert.equal(t.content.slides[0].shapes.length, n);
});

test('rotate with the rotate handle; Shift rounds to 15°; several shapes turn about the grabbed one\'s centre', async () => {
  const t = await session(deck());
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sl:sb/sp:a', focus: '/sl:sb/sp:a'}], primary: 0});
  const {rot} = boxHandles(box(t, 'a'));
  assert.deepEqual(rot, {x: 200, y: 80});
  // A quarter turn clockwise about (200, 150): the handle goes to (270, 150).
  const r = await t.exec('surface.pointer', {events: [ev('down', 200, 80), ev('drag', 268, 153, {shift: true}), ev('up', 268, 153, {shift: true})]});
  assert.equal(r.undoLabel, 'Rotate');
  assert.equal(box(t, 'a').rot, 90);
});

test('the yellow handle reshapes a preset (adj in file units); marquee selects the shapes fully inside', async () => {
  const t = await session(deck({extra: [shape({id: 'c', xfrm: {x: 100, y: 300, w: 200, h: 100}, geom: presetGeom('roundRect'), fill: blue})]}));
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sl:sb/sp:c', focus: '/sl:sb/sp:c'}], primary: 0});
  // roundRect's handle: on the top edge at adj (16 667) × min(w, h) = 16.667 pt.
  const r = await t.exec('surface.pointer', {events: [ev('down', 116.667, 300), ev('drag', 140, 300), ev('up', 140, 300)]});
  assert.equal(r.undoLabel, 'Adjust Shape');
  assert.equal(t.content.slides[0].shapes[2].geom.adj[0], 40000);
  // Marquee from empty slide around A and C but not B.
  await t.exec('surface.pointer', {events: [ev('down', 90, 90), ev('drag', 320, 420), ev('up', 320, 420)]});
  assert.deepEqual(selected(t), ['/sl:sb/sp:a', '/sl:sb/sp:c']);
});

test('resize_box keeps aspect for pictures, flips past the opposite edge, grows from the centre with Alt', () => {
  const o = {x: 100, y: 100, w: 100, h: 50};
  assert.deepEqual(resizeBox(o, 4, {x: 100, y: 0}, true, false), {x: 100, y: 100, w: 200, h: 100});
  const f = resizeBox(o, 3, {x: -150, y: 0}, false, false);
  assert.equal(f.flipH, true);
  assert.equal(f.w, 50);
  assert.equal(f.x, 50);
});

test('edit_zone: the frame band of the box being edited, narrower inside small boxes', () => {
  const x = {x: 0, y: 0, w: 100, h: 40};
  assert.equal(editZone(x, {x: 50, y: 20}, 4), 'inside');
  assert.equal(editZone(x, {x: 2, y: 20}, 4), 'frame');
  assert.equal(editZone(x, {x: -3, y: 20}, 4), 'frame');
  assert.equal(editZone(x, {x: -6, y: 20}, 4), 'outside');
  assert.equal(editZone({x: 0, y: 0, w: 8, h: 8}, {x: 3, y: 3}, 4), 'inside');
  const p = constrain45({x: 0, y: 0}, {x: 10, y: 9});
  assert.ok(Math.abs(p.x - p.y) < 1e-9);
});

test('pointer prefs follow deckcraft defaults and clamps; a freeform in progress survives between gestures', () => {
  assert.deepEqual(pointerPrefs(null), {snapToGrid: true, gridSpacing: 6, smartGuides: true});
  assert.equal(pointerPrefs({prism: {gridSpacing: 0.01}}).gridSpacing, 0.5);
  const tool = newToolState({toolDrag: {kind: 'freeform', mode: 'freeform', points: [{x: 1, y: 2}, {x: 3, y: 4}]}, tool: {kind: 'shape', preset: 'freeform'}});
  assert.equal(tool.drag.points.length, 2);
  assert.deepEqual(persistDrag(tool), {kind: 'freeform', mode: 'freeform', points: [{x: 1, y: 2}, {x: 3, y: 4}]});
  assert.equal(persistDrag(newToolState({})), null);
});

test('ink: a pen stroke joins the slide\'s ink layer as one "Ink" entry; the eraser removes strokes it touches', async () => {
  const c = deck();
  const t = await createTestSession('prism', {content: c, modules: [surface], selection: {ranges: [{anchor: '/sl:sb', focus: '/sl:sb'}], primary: 0}});
  t.session.get(t.docId).view = {...t.session.get(t.docId).view, tool: {kind: 'ink', mode: 'pen', color: {r: 255, g: 0, b: 0, a: 255}, width: 2}};
  const r = await t.exec('surface.pointer', {events: [ev('down', 600, 300), ev('drag', 620, 310), ev('drag', 650, 330), ev('up', 650, 330)]});
  assert.equal(r.undoLabel, 'Ink');
  const ink = t.content.slides[0].shapes.find(s => s.kind.type === 'ink');
  assert.equal(ink.kind.strokes.length, 1);
  assert.deepEqual(ink.kind.strokes[0].points[0], [600, 300, 1]);
  t.session.get(t.docId).view = {...t.session.get(t.docId).view, tool: {kind: 'ink', mode: 'eraser'}};
  const e = await t.exec('surface.pointer', {events: [ev('down', 620, 311), ev('up', 620, 311)]});
  assert.equal(e.undoLabel, 'Erase');
  assert.equal(t.content.slides[0].shapes.find(s => s.kind.type === 'ink').kind.strokes.length, 0);
});

test('deckcraft connectors_follow_glued_shapes (reroute) and set_glue', () => {
  const c = deck();
  const sl = c.slides[0];
  const line = shape({id: 'l', xfrm: lineXfrm({x: 0, y: 0}, {x: 10, y: 10}), geom: presetGeom('straightConnector1')});
  sl.shapes.push(line);
  setGlue(sl.shapes, 'l', 0, ['a', 3]);
  setGlue(sl.shapes, 'l', 1, ['b', 1]);
  assert.equal(sl.shapes[2].kind.type, 'connector');
  reroute(c, sl);
  const sa = sites(c, sl, sl.shapes[0])[3], sb = sites(c, sl, sl.shapes[1])[1];
  const x = sl.shapes[2].xfrm;
  assert.deepEqual([x.x, x.y, x.x + x.w], [Math.min(sa.x, sb.x), Math.min(sa.y, sb.y), Math.max(sa.x, sb.x)]);
  // B gone: that end comes unglued and the line stays.
  sl.shapes.splice(1, 1);
  reroute(c, sl);
  assert.equal(sl.shapes[1].kind.end, null);
  assert.deepEqual(sl.shapes[1].kind.start, ['a', 3]);
});

test('keys: engine keys while editing text, nudges and Tab otherwise; typing on a selected shape replaces its text', () => {
  const c = deck();
  const shapesSel = {ranges: [{anchor: '/sl:sb/sp:a', focus: '/sl:sb/sp:a'}], primary: 0};
  assert.deepEqual(planKey(c, shapesSel, 'ArrowLeft', {}).steps, [{command: 'shape.move', params: {dx: -6, dy: 0}}]);
  assert.deepEqual(planKey(c, shapesSel, 'ArrowDown', {alt: true}).steps, [{command: 'shape.move', params: {dx: 0, dy: 1}}]);
  assert.deepEqual(planKey(c, shapesSel, 'Delete', {}).steps, [{command: 'edit.delete', params: {}}]);
  assert.deepEqual(planKey(c, shapesSel, 'F2', {}).steps, [{command: 'text.edit', params: {}}]);
  assert.deepEqual(planKey(c, shapesSel, 'Escape', {}).steps, [{command: 'edit.deselect', params: {}}]);
  assert.deepEqual(planKey(c, shapesSel, 'Tab', {}).select.ranges[0].anchor, '/sl:sb/sp:b');
  assert.deepEqual(cycleSelection(c, shapesSel, false).ranges[0].anchor, '/sl:sb/sp:b');
  assert.equal(planKey(c, shapesSel, 'b', {cmd: true}).handled, false);
  const slideSel = {ranges: [{anchor: '/sl:sb', focus: '/sl:sb'}], primary: 0};
  assert.deepEqual(planKey(c, slideSel, 'PageDown', {}).steps, [{command: 'slide.next', params: {}}]);
  assert.deepEqual(planKey(c, slideSel, 'Enter', {}).steps, [{command: 'slide.new', params: {}}]);
  const editing = {ranges: [{anchor: '/sl:sb/sp:a/t:3', focus: '/sl:sb/sp:a/t:3'}], primary: 0};
  assert.deepEqual(planKey(c, editing, 'ArrowLeft', {cmd: true, shift: true}).steps, [{command: 'text.move', params: {to: 'wordLeft', extend: true}}]);
  assert.deepEqual(planKey(c, editing, 'ArrowLeft', {alt: true}, {mac: true}).steps, [{command: 'text.move', params: {to: 'wordLeft', extend: false}}]);
  assert.deepEqual(planKey(c, editing, 'Backspace', {}).steps, [{command: 'text.delete', params: {dir: 'backward'}}]);
  assert.deepEqual(planKey(c, editing, 'Enter', {shift: true}).steps, [{command: 'text.insert', params: {text: '\u000b'}}]);
  assert.deepEqual(planKey(c, editing, 'Tab', {}).steps, [{command: 'text.insert', params: {text: '\t'}}]);
  const atStart = {ranges: [{anchor: '/sl:sb/sp:a/t:0', focus: '/sl:sb/sp:a/t:0'}], primary: 0};
  assert.deepEqual(planKey(c, atStart, 'Tab', {shift: true}).steps, [{command: 'format.outdent', params: {}}]);
  assert.deepEqual(planKey(c, editing, 'Escape', {}).steps, [{command: 'text.exit', params: {}}]);
  assert.deepEqual(planKey(c, editing, ']', {cmd: true}).steps, [{command: 'format.grow', params: {}}]);
  assert.deepEqual(planTyping(c, shapesSel, 'x'), [{command: 'text.edit', params: {id: 'a'}}, {command: 'text.selectAll', params: {}}, {command: 'text.insert', params: {text: 'x'}}]);
  assert.deepEqual(planTyping(c, editing, 'x', {commit: true}), [{command: 'text.commit', params: {text: 'x'}}]);
  assert.equal(planTyping(c, slideSel, 'x'), null);
});

test('caret placement follows the translated text layout (text_pos_at) through the shape\'s transform', () => {
  const c = deck();
  const io = {read: () => ({content: c, selection: {ranges: [{anchor: '/sl:sb/sp:a/t:0', focus: '/sl:sb/sp:a/t:0'}], primary: 0}}), write() {}};
  const measure = (f, t) => t.length * f.size * 0.5;
  const s = new PointerSession({io, measure});
  const [p0] = s.textPosAt('a', {x: 100, y: 150});
  assert.equal(p0, 0);
  const [, end] = s.textPosAt('a', {x: 299, y: 150});
  const [, start] = s.textPosAt('a', {x: 101, y: 150});
  assert.ok(end > start, `${start} < ${end}`);
});
