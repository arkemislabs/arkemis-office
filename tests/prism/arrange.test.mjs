// U:prism/arrange: order, group/ungroup/regroup, align, distribute, rotate and flip, reorder,
// guides. Undo round trip per edit command on a schema-2 deck.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/arrange.rs restacks shapes among their
//    siblings (a group's child stays in its group), groups two or more top-level objects into a
//    box that bounds them, ungroups back to slide space, aligns to the slide for one object and to
//    each other for several (or as Align to Slide / Align Selected Objects says, ribbon/arrange.rs),
//    distributes evenly, and keeps drawing guides on the slide. PowerPoint's Arrange menu does the same.
// 2. Ours: the same algorithms over the kernel change API; one undo step each.
// 3. Proved here; guides upstream tests in tests/prism/upstream/arrange_guides_tests.test.mjs;
//    the ribbon path in tests/e2e/prism/shape-format.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide, findShape} from '../../core/prism/model/presentation.mjs';
import {childToParent} from '../../core/prism/commands/arrange.mjs';

async function deck() {
  const c = createContent('Arrange');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const base = {geom: {kind: 'preset', name: 'rect'}, ph: null, fill: null, line: null, effects: null, style: null, text: null, hidden: false, locked: false,
    textBox: false, descr: '', title: '', decorative: false, click: null, hover: null, kind: {type: 'shape'}};
  c.slides = [newSlide({id: 's1', layout, shapes: [
    {...base, id: 'a', name: 'A', xfrm: {x: 100, y: 100, w: 100, h: 50}},
    {...base, id: 'b', name: 'B', xfrm: {x: 300, y: 200, w: 50, h: 50}},
    {...base, id: 'c', name: 'C', xfrm: {x: 600, y: 120, w: 80, h: 80}},
  ]})];
  c.nextId = 300;
  return createTestSession('prism', {content: c, selection: sel(['a'])});
}
const sel = ids => ({ranges: ids.map(i => ({anchor: `/sl:s1/sp:${i}`, focus: `/sl:s1/sp:${i}`})), primary: 0});
const order = r => r.content.slides[0].shapes.map(s => s.id);
const box = (r, id) => findShape(r.content.slides[0].shapes, id).xfrm;

test('bring to front / forward, send backward / to back; already in place is no step', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'arrange.bringToFront', {}, r => assert.deepEqual(order(r), ['b', 'c', 'a']));
  await t.undo();
  await expectUndoRoundTrip(t, 'arrange.bringForward', {}, r => assert.deepEqual(order(r), ['b', 'a', 'c']));
  await t.undo();
  t.session.setSelection(t.docId, sel(['c']));
  await expectUndoRoundTrip(t, 'arrange.sendBackward', {}, r => assert.deepEqual(order(r), ['a', 'c', 'b']));
  await t.undo();
  await expectUndoRoundTrip(t, 'arrange.sendToBack', {}, r => assert.deepEqual(order(r), ['c', 'a', 'b']));
  await t.undo();
  const v = t.version;
  await t.exec('arrange.bringToFront', {});
  assert.equal(t.version, v, 'c is already in front');
  await expectUndoRoundTrip(t, 'arrange.reorder', {id: 'c', index: 0}, r => assert.deepEqual(order(r), ['c', 'a', 'b']));
});

test('group, ungroup and regroup keep every shape where it was', async () => {
  const t = await deck();
  t.session.setSelection(t.docId, sel(['a', 'b']));
  const g = await expectUndoRoundTrip(t, 'arrange.group', {}, r => {
    const grp = r.content.slides[0].shapes.find(s => s.kind.type === 'group');
    assert.deepEqual(grp.xfrm, {x: 100, y: 100, w: 250, h: 150});
    assert.deepEqual(grp.kind.children.map(s => s.id), ['a', 'b']);
    assert.match(grp.name, /^Group \d+$/);
  });
  const gid = g.result.id;
  assert.deepEqual(t.doc.selection.ranges.map(r => r.anchor), [`/sl:s1/sp:${gid}`]);
  // Moving the group moves its members on ungroup.
  await t.exec('shape.move', {dx: 10, dy: 20});
  await expectUndoRoundTrip(t, 'arrange.ungroup', {}, r => {
    assert.deepEqual(box(r, 'a'), {x: 110, y: 120, w: 100, h: 50});
    assert.deepEqual(box(r, 'b'), {x: 310, y: 220, w: 50, h: 50});
  });
  assert.deepEqual(t.doc.selection.ranges.map(r => r.anchor), ['/sl:s1/sp:a', '/sl:s1/sp:b']);
  await expectUndoRoundTrip(t, 'arrange.regroup', {}, r => assert.ok(r.content.slides[0].shapes.some(s => s.kind.type === 'group')));
  t.session.setSelection(t.docId, sel(['c']));
  assert.deepEqual(t.state('arrange.group', {}), {enabled: false, reason: 'select two or more objects'});
});

test('child_to_parent maps a scaled, flipped group child back to the slide', () => {
  const x = childToParent({x: 0, y: 0, w: 200, h: 100, flipH: true}, {x: 0, y: 0, w: 100, h: 100}, {x: 0, y: 0, w: 50, h: 50, rot: 30});
  assert.deepEqual([x.x, x.y, x.w, x.h], [100, 0, 100, 50]);
  assert.equal(x.flipH, true);
  assert.equal(x.rot, 330);
});

test('align: one object to the slide, several to each other, or as Align to Slide says', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'arrange.align', {edge: 'right'}, r => assert.equal(box(r, 'a').x, 960 - 100));
  t.session.setSelection(t.docId, sel(['a', 'b', 'c']));
  await expectUndoRoundTrip(t, 'arrange.align', {edge: 'top'}, r => assert.deepEqual(['a', 'b', 'c'].map(i => box(r, i).y), [100, 100, 100]));
  await expectUndoRoundTrip(t, 'arrange.align', {edge: 'middle', to: 'slide'}, r => assert.equal(box(r, 'b').y, 245));
  // Align to Slide ticked for this selection.
  await t.exec('arrange.alignTo', {slide: true});
  assert.equal(t.state('arrange.alignTo', {slide: true}).checked, true);
  assert.equal(t.state('arrange.alignTo', {slide: false}).checked, false);
  await t.exec('arrange.align', {edge: 'left'});
  assert.deepEqual(['a', 'b', 'c'].map(i => box(t, i).x), [0, 0, 0]);
  // Another selection forgets the choice.
  t.session.setSelection(t.docId, sel(['a', 'b']));
  assert.equal(t.state('arrange.alignTo', {slide: false}).checked, true);
});

test('distribute horizontally among the selection and across the slide', async () => {
  const t = await deck();
  t.session.setSelection(t.docId, sel(['a', 'b', 'c']));
  await expectUndoRoundTrip(t, 'arrange.distribute', {dir: 'horizontal'}, r => {
    // Span 100..680, widths 100+50+80 = 230, gap (580 - 230) / 2 = 175.
    assert.deepEqual(['a', 'b', 'c'].map(i => box(r, i).x), [100, 375, 600]);
  });
  await expectUndoRoundTrip(t, 'arrange.distribute', {dir: 'vertical', to: 'slide'}, r => {
    const ys = ['a', 'c', 'b'].map(i => box(r, i).y);
    assert.equal(ys[0], 0);
    assert.equal(ys[2] + 50, 540);
  });
});

test('rotate, flip and nudge go through shape.rotate / shape.flip / shape.move', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'arrange.rotateRight', {}, r => assert.equal(box(r, 'a').rot, 90));
  await expectUndoRoundTrip(t, 'arrange.rotateLeft', {}, r => assert.equal(box(r, 'a').rot, undefined));
  await expectUndoRoundTrip(t, 'arrange.flipHorizontal', {}, r => assert.equal(box(r, 'a').flipH, true));
  await expectUndoRoundTrip(t, 'arrange.flipVertical', {}, r => assert.equal(box(r, 'a').flipV, true));
  await expectUndoRoundTrip(t, 'arrange.nudge', {dx: 6, dy: 0}, r => assert.equal(box(r, 'a').x, 106));
  assert.equal(t.doc.undo.labels()[0], 'Nudge');
});

test('guides: add, move, delete round-trip', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'guide.add', {vertical: false, pos: 100}, r => assert.deepEqual(r.content.guides, [{vertical: false, pos: 100}]));
  await expectUndoRoundTrip(t, 'guide.move', {index: 0, pos: -5}, r => assert.equal(r.content.guides[0].pos, 0));
  await expectUndoRoundTrip(t, 'guide.delete', {index: 0}, r => assert.deepEqual(r.content.guides, []));
  assert.deepEqual((await t.exec('guide.list', {})).result, []);
});
