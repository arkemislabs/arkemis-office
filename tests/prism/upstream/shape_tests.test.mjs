// Ported from deckcraft crates/engine/src/cmd/shape.rs `mod tests`, cmd/shape/size.rs
// `mod size_position_tests` and crates/engine/src/inkshape.rs `mod tests` at
// f893f6af7d36a5409fd804e81a34fd895cfefedf (each test names its Rust original).
//
// 1. What ArtCraft does: a group's Fill and Outline reach every member in one undo step without
//    resetting their other properties; transparency on a group keeps each member's inherited
//    colour; a trackpad twist is one undo; Size and Position… sets position, size and rotation in
//    one step, locks the aspect, scales per shape, opens its dialog with no keys and refuses bad
//    values; Ink to Shape recognises lines, rectangles, ellipses and triangles.
// 2. Ours runs the same commands on a schema-2 deck through the kernel session (ids are strings).
// 3. Proved here with the upstream assertions; the ribbon path in tests/e2e/prism/shape-format.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {createContent} from '../../../core/prism/schema.mjs';
import {slide as newSlide, findShape} from '../../../core/prism/model/presentation.mjs';
import {ctxForSlide, fill as resolveFill, ctxColor} from '../../../core/prism/model/resolve.mjs';
import {recognize} from '../../../core/prism/lib/shape-inkshape.mjs';

async function blankDeck() {
  const c = createContent('Shapes');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = [newSlide({id: 's1', layout})];
  return createTestSession('prism', {content: c, selection: {ranges: [{anchor: '/sl:s1', focus: '/sl:s1'}], primary: 0}});
}
const shapeOf = (t, id) => findShape(t.content.slides[0].shapes, id);
const select = (t, ids) => t.session.setSelection(t.docId, ids.length ? {ranges: ids.map(i => ({anchor: `/sl:s1/sp:${i}`, focus: `/sl:s1/sp:${i}`})), primary: ids.length - 1}
  : {ranges: [{anchor: '/sl:s1', focus: '/sl:s1'}], primary: 0});
const undos = t => t.doc.undo.size;
const lastLabel = t => t.doc.undo.labels()[0];

async function nestedGroup() {
  const t = await blankDeck();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = await t.exec('shape.insert', {preset: 'rect', rect: [40 + i * 100, 100, 80, 60]});
    await t.exec('shape.line', {width: i + 1, dash: 'dash'});
    ids.push(r.result.id);
  }
  const group = async list => { select(t, list); return (await t.exec('arrange.group', {})).result.id; };
  const inner = await group(ids.slice(0, 2));
  const outer = await group([inner, ids[2]]);
  return {t, members: ids.slice(0, 3), group: outer, outside: ids[3]};
}

test('shape.rs group_fill_reaches_nested_members_in_one_undo_step', async () => {
  const {t, members, group, outside} = await nestedGroup();
  const before = structuredClone(t.content);
  const untouched = structuredClone(shapeOf(t, outside));
  await t.exec('shape.fill', {color: '#ff0000'});
  for (const id of members) assert.deepEqual(shapeOf(t, id).fill, {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 255, g: 0, b: 0, a: 255}}}});
  assert.deepEqual(t.doc.selection.ranges.map(r => r.anchor), [`/sl:s1/sp:${group}`]);
  assert.deepEqual(shapeOf(t, outside), untouched);
  const filled = structuredClone(t.content);
  await t.undo();
  assert.deepEqual(t.content, before);
  await t.redo();
  assert.deepEqual(t.content, filled);
  await t.exec('shape.fill', {none: true});
  assert.ok(members.every(id => shapeOf(t, id).fill?.kind === 'none'));
  await t.exec('shape.fill', {reset: true});
  assert.ok(members.every(id => shapeOf(t, id).fill === null));
});

test('shape.rs group_outline_reaches_members_without_resetting_their_other_properties', async () => {
  const {t, members, group, outside} = await nestedGroup();
  const before = structuredClone(t.content);
  // Explicit ids work even when another object is selected.
  select(t, [outside]);
  await t.exec('shape.line', {ids: [group], color: '#00ff00'});
  members.forEach((id, i) => {
    const line = shapeOf(t, id).line;
    assert.deepEqual(line.fill, {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 0, g: 255, b: 0, a: 255}}}});
    assert.equal(line.width, i + 1);
    assert.deepEqual(line.dash, {kind: 'preset', name: 'dash'});
  });
  assert.deepEqual(t.doc.selection.ranges.map(r => r.anchor), [`/sl:s1/sp:${outside}`]);
  const outlined = structuredClone(t.content);
  await t.undo();
  assert.deepEqual(t.content, before);
  await t.redo();
  assert.deepEqual(t.content, outlined);
  await t.exec('shape.line', {ids: [group], none: true});
  assert.ok(members.every(id => shapeOf(t, id).line.fill.kind === 'none'));
  await t.exec('shape.line', {ids: [group], reset: true});
  assert.ok(members.every(id => shapeOf(t, id).line === null));
});

test("shape.rs group_fill_transparency_keeps_each_members_inherited_colour", async () => {
  const {t, members, group} = await nestedGroup();
  await t.exec('shape.fill', {ids: [members[1]], color: '#00ff00'});
  const rctx = ctxForSlide(t.content, t.content.slides[0]);
  const colours = members.map(id => {
    const [f, ph] = resolveFill(rctx, shapeOf(t, id));
    assert.equal(f.kind, 'solid', 'solid theme fill');
    return ctxColor(rctx, f.color, ph);
  });
  await t.exec('shape.fill', {ids: [group], transparency: 0.5});
  members.forEach((id, i) => assert.deepEqual(shapeOf(t, id).fill, {kind: 'solid', color: {base: {kind: 'rgb', rgb: colours[i]}, mods: [{op: 'alpha', val: 50000}]}}));
});

test('shape.rs a_twist_is_one_undo_and_wraps_past_a_full_turn', async () => {
  const t = await blankDeck();
  const id = (await t.exec('shape.insert', {preset: 'rect', rect: [40, 40, 80, 40]})).result.id;
  select(t, [id]);
  const rot = () => shapeOf(t, id).xfrm.rot ?? 0;
  assert.ok(Math.abs(rot()) < 0.01);
  const n = undos(t);
  await t.exec('shape.rotate', {by: 10, gesture: 'move'});
  await t.exec('shape.rotate', {by: 350, gesture: 'move'});
  assert.ok(Math.abs(rot()) < 0.01, `10 + 350 wraps to 0, got ${rot()}`);
  await t.exec('shape.rotate', {by: 20, gesture: 'move'});
  await t.exec('shape.rotate', {gesture: 'end', ids: []});
  assert.ok(Math.abs(rot() - 20) < 0.01);
  assert.equal(undos(t), n + 1, 'the twist is one undo step');
  assert.equal(lastLabel(t), 'Rotation');
  await t.undo();
  assert.ok(Math.abs(rot()) < 0.01, 'one undo undoes the whole twist');
  await t.redo();
  assert.ok(Math.abs(rot() - 20) < 0.01);
  // After `end`, the next twist is a new undo step.
  await t.exec('shape.rotate', {by: 5, gesture: 'move'});
  await t.exec('shape.rotate', {gesture: 'end'});
  assert.equal(undos(t), n + 2);
});

test('shape.rs ending_a_twist_does_not_commit_a_drag (no edit, no undo step)', async () => {
  const t = await blankDeck();
  const id = (await t.exec('shape.insert', {preset: 'ellipse', rect: [10, 10, 30, 30]})).result.id;
  select(t, [id]);
  const n = undos(t), v = t.version;
  await t.exec('shape.rotate', {gesture: 'end', ids: []});
  assert.equal(undos(t), n);
  assert.equal(t.version, v);
});

// size.rs size_position_tests --------------------------------------------------------------

async function sizeDeck() {
  const t = await blankDeck();
  const id = (await t.exec('shape.insert', {preset: 'rect', rect: [40, 50, 200, 100]})).result.id;
  return {t, id};
}
const geom = (t, id) => { const x = shapeOf(t, id).xfrm; return [x.x, x.y, x.w, x.h, x.rot ?? 0]; };

test('size.rs sets_position_size_and_rotation_in_one_undo', async () => {
  const {t, id} = await sizeDeck();
  const n = undos(t);
  await t.exec('shape.sizePosition', {x: 80, y: 90, w: 240, h: 60, rot: 370});
  assert.deepEqual(geom(t, id), [80, 90, 240, 60, 10]);
  assert.equal(undos(t), n + 1);
  assert.equal(lastLabel(t), 'Size and Position…');
  await t.undo();
  assert.deepEqual(geom(t, id), [40, 50, 200, 100, 0]);
});

test('size.rs lock_aspect_and_scale_share_one_step', async () => {
  const {t, id} = await sizeDeck();
  await t.exec('shape.sizePosition', {w: 300, lockAspect: true});
  assert.deepEqual(geom(t, id), [40, 50, 300, 150, 0]);
  await t.undo();
  await t.exec('shape.sizePosition', {h: 50, lockAspect: true});
  assert.deepEqual(geom(t, id), [40, 50, 100, 50, 0]);
  await t.undo();
  await t.exec('shape.sizePosition', {scaleW: 25, scaleH: 150});
  assert.deepEqual(geom(t, id), [40, 50, 50, 150, 0]);
  await t.undo();
  await t.exec('shape.sizePosition', {scaleH: 50, lockAspect: true});
  assert.deepEqual(geom(t, id), [40, 50, 100, 50, 0]);
  // An explicit width wins over a scale on the same axis.
  await t.exec('shape.sizePosition', {w: 80, scaleW: 50});
  assert.equal(geom(t, id)[2], 80);
});

test('size.rs partial_fields_leave_the_rest_and_a_repeat_does_not_undo', async () => {
  const {t, id} = await sizeDeck();
  const n = undos(t);
  await t.exec('shape.sizePosition', {y: 12, rot: -90});
  assert.deepEqual(geom(t, id), [40, 12, 200, 100, 270]);
  assert.equal(undos(t), n + 1);
  await t.exec('shape.sizePosition', {x: 40, y: 12, w: 200, h: 100, rot: 270});
  assert.equal(undos(t), n + 1, 'identical geometry is not an undo step');
});

test('size.rs no_fields_opens_the_dialog_without_editing', async () => {
  const {t, id} = await sizeDeck();
  const n = undos(t);
  const r = await t.exec('shape.sizePosition', {});
  assert.deepEqual(geom(t, id), [40, 50, 200, 100, 0]);
  assert.equal(undos(t), n);
  assert.equal(r.result.dialog, 'dialog.sizePosition');
  assert.deepEqual(r.result.params, {x: 40, y: 50, w: 200, h: 100, rot: 0, scaleW: 100, scaleH: 100, lockAspect: false});
});

test('size.rs bad_fields_do_not_edit', async () => {
  const {t, id} = await sizeDeck();
  const n = undos(t);
  for (const p of [{w: 'wide'}, {h: -5}, {scaleW: 0}, {x: 1e9}, {rot: 'spin'}, {lockAspect: 'yes'}]) {
    await assert.rejects(t.exec('shape.sizePosition', p), e => e.code === 'invalid_params' && /sizePosition/.test(e.message), JSON.stringify(p));
    assert.deepEqual(geom(t, id), [40, 50, 200, 100, 0]);
    assert.equal(undos(t), n);
  }
});

test('size.rs scale_is_per_shape_and_nothing_selected_is_disabled', async () => {
  const {t, id: a} = await sizeDeck();
  const b = (await t.exec('shape.insert', {preset: 'ellipse', rect: [10, 10, 40, 80]})).result.id;
  await t.exec('shape.sizePosition', {ids: [a, b], scaleW: 200});
  assert.equal(geom(t, a)[2], 400);
  assert.equal(geom(t, a)[3], 100);
  assert.equal(geom(t, b)[2], 80);
  assert.equal(geom(t, b)[3], 80);
  assert.equal(lastLabel(t), 'Size and Position…');
  select(t, []);
  await assert.rejects(t.exec('shape.sizePosition', {}), e => /nothing selected/.test(e.message));
});

// inkshape.rs tests ------------------------------------------------------------------------

function poly(corners, perSide) {
  const v = [];
  corners.forEach((a, k) => {
    const b = corners[(k + 1) % corners.length];
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      const wob = ((i * 7 + k * 3) % 5) * 0.4 - 0.8;
      v.push([a[0] + (b[0] - a[0]) * t + wob, a[1] + (b[1] - a[1]) * t - wob]);
    }
  });
  v.push([corners[0][0] + 2, corners[0][1] + 1.5]);
  return v;
}

test('inkshape.rs rectangles_ellipses_triangles_and_lines', () => {
  const r = recognize(poly([[100, 100], [300, 100], [300, 200], [100, 200]], 30));
  assert.equal(r.kind, 'rect');
  assert.ok(Math.abs(r.w - 200) < 4 && Math.abs(r.h - 100) < 4, JSON.stringify(r));
  const ell = Array.from({length: 81}, (_, i) => { const a = i / 80 * Math.PI * 2; return [200 + 120 * Math.cos(a) + (i % 3) * 0.5, 150 + 60 * Math.sin(a)]; });
  assert.equal(recognize(ell)?.kind, 'ellipse');
  const up = recognize(poly([[200, 50], [300, 250], [100, 250]], 30));
  assert.equal(up.kind, 'triangle');
  assert.equal(up.flipV, false);
  const down = recognize(poly([[100, 50], [300, 50], [200, 250]], 30));
  assert.equal(down.kind, 'triangle');
  assert.equal(down.flipV, true);
  const line = Array.from({length: 41}, (_, i) => [10 + i * 5, 20 + i * 2 + (i % 2) * 0.6]);
  const l = recognize(line);
  assert.equal(l?.kind, 'line');
  assert.ok(l.x0 < l.x1);
});

test('inkshape.rs scribbles_dots_and_garbage_stay_ink', () => {
  assert.equal(recognize([]), null);
  assert.equal(recognize([[1, 1]]), null);
  assert.equal(recognize([[0, 0], [2, 2], [1, 3]]), null, 'too small');
  const zig = Array.from({length: 40}, (_, i) => [i * 5, i % 2 === 0 ? 0 : 60]);
  assert.equal(recognize(zig), null, 'an open zigzag is no line');
  assert.equal(recognize([[NaN, 0], [Infinity, 1]]), null);
  const thereAndBack = [...Array.from({length: 21}, (_, i) => i), ...Array.from({length: 21}, (_, i) => 20 - i)].map(i => [i * 10, 5]);
  assert.equal(recognize(thereAndBack), null);
});

test('inkshape.rs ink_to_shape_command_converts_and_undoes', async () => {
  const t = await blankDeck();
  const rect = poly([[100, 100], [300, 100], [300, 200], [100, 200]], 30);
  const zig = Array.from({length: 40}, (_, i) => [i * 5, i % 2 === 0 ? 300 : 360]);
  const mk = v => ({points: v.map(([x, y]) => [x, y, 0.5]), color: {r: 200, g: 0, b: 0, a: 255}, width: 3, highlighter: false});
  t.content.slides[0].shapes.push({id: 'ink1', name: 'Ink', xfrm: {x: 0, y: 0, w: 960, h: 540}, kind: {type: 'ink', strokes: [mk(rect), mk(zig)]}, geom: {kind: 'preset', name: 'rect'},
    ph: null, fill: null, line: null, effects: null, style: null, text: null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null});
  const n0 = t.content.slides[0].shapes.length;
  const r = await t.exec('draw.inkToShape', {});
  assert.equal(r.result.kept, 1);
  const sh = t.content.slides[0].shapes;
  assert.equal(sh.length, n0 + 1, 'ink keeps the zigzag, one rectangle added');
  const made = sh.at(-1);
  assert.deepEqual(made.geom, {kind: 'preset', name: 'rect'});
  assert.equal(made.line.width, 3);
  await t.undo();
  assert.equal(t.content.slides[0].shapes.length, n0);
  // Nothing recognisable: a no-op, not an error. A slide without ink too.
  await t.exec('draw.inkToShape', {});
  t.content.slides[0].shapes = t.content.slides[0].shapes.filter(s => s.kind.type !== 'ink');
  assert.equal((await t.exec('draw.inkToShape', {})).result.kept, 0);
});
