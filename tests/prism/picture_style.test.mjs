// U:prism/picture_style: Picture Format › Picture Styles.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/picture_style.rs applies one of
//    PowerPoint's 24 picture quick styles (frame geometry, outline and effects) as one step,
//    replacing the previous style; `none` (Reset Style) clears it; unknown ids are refused.
// 2. Ours: the same table of looks on schema-2 picture shapes.
// 3. Proved here; the gallery on the ribbon in tests/e2e/prism/shape-format.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {slide as newSlide} from '../../core/prism/model/presentation.mjs';
import {pictureFill} from '../../core/prism/lib/shape-common.mjs';
import {STYLES} from '../../core/prism/commands/picture_style.mjs';

async function session() {
  const c = createContent('Pictures');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  c.slides = [newSlide({id: 's1', layout, shapes: [{id: 'p', name: 'Picture 1', xfrm: {x: 10, y: 10, w: 200, h: 100}, kind: {type: 'picture', fill: pictureFill('m1')},
    geom: {kind: 'preset', name: 'rect'}, ph: null, fill: null, line: null, effects: null, style: null, text: null, hidden: false, locked: false, textBox: false,
    descr: '', title: '', decorative: false, click: null, hover: null}]})];
  return createTestSession('prism', {content: c, selection: {ranges: [{anchor: '/sl:s1/sp:p', focus: '/sl:s1/sp:p'}], primary: 0}});
}
const pic = r => r.content.slides[0].shapes[0];

test('picture.style applies a frame, outline and effects in one step; Reset Style clears them', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'picture.style', {style: 'simpleFrameWhite'}, r => {
    const s = pic(r);
    assert.deepEqual(s.geom, {kind: 'preset', name: 'rect'});
    assert.equal(s.line.width, 7);
    assert.deepEqual(s.line.fill.color.base.rgb, {r: 255, g: 255, b: 255, a: 255});
    assert.equal(s.effects.outerShadow.blur, 4);
  });
  await expectUndoRoundTrip(t, 'picture.style', {style: 'rotatedWhite'}, r => assert.equal(pic(r).xfrm.rot, 356));
  await expectUndoRoundTrip(t, 'picture.style', {style: 'softEdgeOval'}, r => {
    assert.deepEqual(pic(r).geom, {kind: 'preset', name: 'ellipse'});
    assert.equal(pic(r).line.fill.kind, 'none');
    assert.equal(pic(r).effects.softEdge, 12);
  });
  await expectUndoRoundTrip(t, 'picture.style', {style: 'none'}, r => assert.deepEqual([pic(r).line, pic(r).effects], [null, null]));
  await assert.rejects(t.exec('picture.style', {style: 'glitter'}), /unknown style `glitter`; see picture.styles/);
  const g = (await t.exec('picture.styles', {})).result;
  assert.equal(g.length, 24);
  assert.deepEqual(g[0], {id: 'simpleFrameWhite', label: 'Simple Frame, White'});
  assert.equal(t.state('picture.style', {}).value.length, STYLES.length);
});
