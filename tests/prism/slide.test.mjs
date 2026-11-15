// U:prism/slide: slide.new, slide.duplicate, slide.delete, slide.move over schema-1 Prism content.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createFile, validateFile} from '../../core/model.mjs';
import {findLayout, LAYOUTS} from '../../core/prism/lib/slide-layouts.mjs';

async function session() {
  const file = createFile('prism', 'Deck');
  file.id = 'doc1';
  file.content.slides[0].id = 'sl1';
  file.content.activeSlideId = 'sl1';
  return createTestSession('prism', {file});
}
const ids = t => t.content.slides.map(sl => sl.id);

test('slide.new after a title slide picks Title and Content and becomes the current slide', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'slide.new', {}, after => {
    assert.equal(after.content.slides.length, 2);
    assert.equal(after.content.slides[1].layout, 'titleAndContent');
  });
  assert.equal(r.result.index, 1);
  assert.equal(r.result.layout, 'titleAndContent');
  assert.equal(t.content.activeSlideId, r.result.id);
  assert.deepEqual(t.doc.selection.ranges, [{anchor: `/sl:${r.result.id}`, focus: `/sl:${r.result.id}`}]);
  assert.deepEqual(t.content.slides[1].elements.map(e => e.placeholder), ['title', 'body']);
  validateFile(t.file);
  // The next new slide keeps the current (non-title) layout.
  const again = await t.exec('slide.new');
  assert.equal(again.result.layout, 'titleAndContent');
  assert.equal(again.result.index, 2);
});

test('slide.new takes a layout by kind or name, an index, and title/body text', async () => {
  const t = await session();
  const r = await t.exec('slide.new', {layout: 'Two Content', at: 0, title: 'Plan', body: 'Step one'});
  assert.equal(r.result.index, 0);
  const sl = t.content.slides[0];
  assert.equal(sl.layout, 'twoContent');
  assert.equal(sl.elements[0].text, 'Plan');
  assert.equal(sl.elements[1].text, 'Step one');
  assert.equal(findLayout('BLANK'), 'blank');
  assert.equal(Object.keys(LAYOUTS).length, 9);
  await assert.rejects(t.exec('slide.new', {layout: 'nope'}), e => e.code === 'invalid_params' && e.data.path === '/layout');
  validateFile(t.file);
});

test('slide.duplicate copies the selected slides with new ids after the last one', async () => {
  const t = await session();
  await t.exec('slide.new', {layout: 'blank'});
  const [a, b] = ids(t);
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${a}`}, {anchor: `/sl:${b}`}]});
  const r = await expectUndoRoundTrip(t, 'slide.duplicate', {});
  assert.equal(r.result.ids.length, 2);
  assert.deepEqual(ids(t).slice(0, 2), [a, b]);
  assert.deepEqual(ids(t).slice(2), r.result.ids);
  const src = t.content.slides[0], copy = t.content.slides[2];
  assert.notEqual(copy.elements[0].id, src.elements[0].id);
  assert.equal(copy.elements[0].text, src.elements[0].text);
  assert.equal(t.content.activeSlideId, r.result.ids[1]);
  validateFile(t.file);
});

test('slide.delete removes by id, index or the current slide; undo brings it back; an empty deck disables it', async () => {
  const t = await session();
  await t.exec('slide.new');
  await t.exec('slide.new');
  const [a, b, c] = ids(t);
  await expectUndoRoundTrip(t, 'slide.delete', {ids: [b]});
  assert.deepEqual(ids(t), [a, c]);
  assert.equal(t.content.activeSlideId, c);
  await t.exec('slide.delete', {index: 0});
  assert.deepEqual(ids(t), [c]);
  await t.exec('slide.delete');
  assert.deepEqual(ids(t), []);
  assert.equal(t.content.activeSlideId, '');
  validateFile(t.file);
  assert.deepEqual(t.state('slide.delete'), {enabled: false, reason: 'no slides'});
  await assert.rejects(t.exec('slide.duplicate'), e => e.code === 'disabled' && e.message === 'no slides');
  await t.undo(2);
  assert.deepEqual(ids(t), [a, c]);
});

test('upstream deckcraft tests.rs new_presentation_and_slides', async () => {
  const t = await session();
  assert.equal(t.content.slides.length, 1);
  await t.exec('slide.new', {});
  await t.exec('slide.new', {layout: 'blank'});
  assert.equal(t.content.slides.length, 3);
  assert.equal(ids(t).indexOf(t.content.activeSlideId), 2);
  await t.exec('slide.duplicate', {});
  assert.equal(t.content.slides.length, 4);
  await t.exec('slide.move', {from: 3, to: 0});
  await t.exec('slide.delete', {index: 0});
  assert.equal(t.content.slides.length, 3);
  await t.undo();
  assert.equal(t.content.slides.length, 4);
  await t.redo();
  assert.equal(t.content.slides.length, 3);
});

test('over the bridge New Slide is "Automation: New Slide"', async () => {
  const t = await session();
  const r = await t.bridge('slide.new', {layout: 'titleOnly', title: 'From the bridge'});
  assert.equal(r.undoLabel, 'Automation: New Slide');
  assert.equal(t.read(`/slides/1/elements/0/text`), 'From the bridge');
  await assert.rejects(t.bridge('slide.move', {}), e => e.code === 'invalid_params');
});
