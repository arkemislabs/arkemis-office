// Ported from deckcraft crates/engine/src/cmd/slide.rs `mod tests` and crates/engine/src/tests.rs
// (`new_presentation_and_slides`, `new_slide_body_tabs_match_text_set`, `layout_change_keeps_text`,
// `new_slide_body_goes_to_the_content_placeholder`, `markdown_outlines_take_headings_as_slides_and_lists_as_bullets`,
// `plain_outlines_are_unchanged`, `slides_from_outline_join_the_section_of_the_slide_they_follow`,
// `slide_hide_and_layout_reject_invalid_index`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// `Session::with_new()` is a new presentation (one title slide); `selection.slide` is the
// current slide's index, `selection.slides` the slides selected in the slide list.
//
// 1. ArtCraft: deckcraft cmd/slide.rs (new:104, duplicate:190, delete:239, move_slide:269,
//    select_range:382, apply_layout:440, section_*:576-659, from_outline:661); PowerPoint: Home ›
//    Slides (New Slide, Layout, Reset, Section) and the slide list's Shift/Ctrl-click.
// 2. Ours runs the same steps on the schema-2 Presentation through the kernel (undoable, same
//    selection rules, same section bookkeeping).
// 3. These ported tests plus tests/prism/slide-schema2.test.mjs (undo round trips) and
//    tests/e2e/prism/slide-ribbon.e2e.mjs (the ribbon and thumbnail pane in the app).

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../../core/kernel/testing.mjs';
import {createContent} from '../../../core/prism/schema.mjs';
import {currentSlideIndex, selectedSlideIds} from '../../../core/prism/model/doc.mjs';
import {paraText} from '../../../core/prism/model/text.mjs';
import slide from '../../../core/prism/commands/slide.mjs';
import text from '../../../core/prism/commands/text.mjs';
import edit from '../../../core/prism/commands/edit.mjs';

async function withNew() {
  const content = createContent('Deck');
  const id = content.slides[0].id;
  return createTestSession('prism', {content, modules: [slide, text, edit], selection: {ranges: [{anchor: `/sl:${id}`, focus: `/sl:${id}`}], primary: 0}});
}
async function deckOf(n) {
  const t = await withNew();
  while (t.content.slides.length < n) await t.exec('slide.new', {});
  return t;
}
const cur = t => currentSlideIndex(t.content, t.doc.selection);
const selectedIndices = t => selectedSlideIds(t.content, t.doc.selection).map(id => t.content.slides.findIndex(s => s.id === id)).sort((a, b) => a - b);

test('new_presentation_and_slides', async () => {
  const t = await withNew();
  assert.equal(t.content.slides.length, 1);
  await t.exec('slide.new', {});
  await t.exec('slide.new', {layout: 'blank'});
  assert.equal(t.content.slides.length, 3);
  assert.equal(cur(t), 2);
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

test('invalid_index_params_are_rejected_not_defaulted_to_selection', async () => {
  const t = await deckOf(3);
  for (const badv of [-1, 1.5]) {
    for (const [cmd, p] of [['slide.delete', {index: badv}], ['slide.duplicate', {index: badv}], ['slide.move', {from: badv, to: 0}], ['section.add', {at: badv}]]) {
      await assert.rejects(t.exec(cmd, p), undefined, `${cmd} must reject ${JSON.stringify(p)}`);
      assert.equal(t.content.slides.length, 3, cmd);
    }
  }
});

test('duplicate_keeps_section_order_in_step_with_slides', async () => {
  const t = await deckOf(3);
  await t.exec('section.add', {at: 0});
  const orig = t.content.slides[0].id;
  await t.exec('slide.duplicate', {index: 0});
  const all = t.content.slides.map(s => s.id);
  const sec = t.content.sections[0].slides;
  assert.equal(all.length, 4);
  assert.deepEqual(sec, all, 'section order must match slide order');
  assert.equal(sec[0], orig);
});

test('new_slide_body_leading_tabs_become_levels', async () => {
  const t = await withNew();
  await t.exec('slide.new', {layout: 'titleAndContent', title: 'Indent', body: 'Level one\n\tLevel two\n\t\tLevel three\nLevel one again'});
  const sl = t.content.slides[cur(t)];
  const body = sl.shapes.find(x => x.ph && x.ph.kind !== 'title' && x.ph.kind !== 'ctrTitle');
  assert.deepEqual(body.text.paragraphs.map(p => [p.level, paraText(p)]), [[0, 'Level one'], [1, 'Level two'], [2, 'Level three'], [0, 'Level one again']]);
});

test('select_range_covers_every_slide_between', async () => {
  const t = await deckOf(6);
  await t.exec('slide.go', {index: 1});
  await t.exec('slide.selectRange', {to: 4});
  assert.deepEqual(selectedIndices(t), [1, 2, 3, 4]);
  assert.equal(cur(t), 4);
  // Backwards works too, and replaces the earlier selection.
  await t.exec('slide.selectRange', {from: 5, to: 3});
  assert.deepEqual(selectedIndices(t), [3, 4, 5]);
});

test('select_range_add_keeps_the_existing_selection', async () => {
  const t = await deckOf(8);
  await t.exec('slide.selectSlides', {indices: [0, 1]});
  await t.exec('slide.go', {index: 4});
  await t.exec('slide.selectSlides', {indices: [4]});
  await t.exec('slide.selectRange', {to: 6, add: true});
  assert.deepEqual(selectedIndices(t), [4, 5, 6]);
  await t.exec('slide.selectSlides', {indices: [0]});
  await t.exec('slide.selectRange', {from: 3, to: 5, add: true});
  assert.deepEqual(selectedIndices(t), [0, 3, 4, 5]);
});

test('select_range_rejects_out_of_range_slides', async () => {
  const t = await deckOf(3);
  await assert.rejects(t.exec('slide.selectRange', {to: 3}));
  await assert.rejects(t.exec('slide.selectRange', {from: 9, to: 1}));
  await assert.rejects(t.exec('slide.selectRange', {}));
});

test('select_range_rejects_an_invalid_from_instead_of_using_the_current_slide', async () => {
  const t = await deckOf(4);
  await t.exec('slide.go', {index: 2});
  await assert.rejects(t.exec('slide.selectRange', {from: -1, to: 3}));
  await assert.rejects(t.exec('slide.selectRange', {from: 'x', to: 3}));
  assert.deepEqual(selectedIndices(t), [2]);
});

test('a_second_range_extends_from_the_original_anchor', async () => {
  const t = await deckOf(8);
  await t.exec('slide.go', {index: 2});
  await t.exec('slide.selectRange', {to: 5});
  assert.deepEqual(selectedIndices(t), [2, 3, 4, 5]);
  // Shift-click further on: still anchored at 2, not at 5.
  await t.exec('slide.selectRange', {to: 7});
  assert.deepEqual(selectedIndices(t), [2, 3, 4, 5, 6, 7]);
  // Shift-click back across the anchor.
  await t.exec('slide.selectRange', {to: 0});
  assert.deepEqual(selectedIndices(t), [0, 1, 2]);
  // A plain click on another slide starts a new anchor.
  await t.exec('slide.go', {index: 4});
  await t.exec('slide.selectRange', {to: 6});
  assert.deepEqual(selectedIndices(t), [4, 5, 6]);
});

test('moving_a_slide_drops_the_range_anchor', async () => {
  const t = await deckOf(6);
  await t.exec('slide.go', {index: 0});
  await t.exec('slide.selectRange', {to: 2});
  // Slide 0 moves to index 2 and stays current; the next Shift-click starts at the moved slide.
  await t.exec('slide.move', {from: 0, to: 2});
  assert.equal(cur(t), 2);
  await t.exec('slide.selectRange', {to: 4});
  assert.deepEqual(selectedIndices(t), [2, 3, 4]);
});

test('new_slide_body_tabs_match_text_set', async () => {
  const t = await withNew();
  const body = 'A\n\tB\n\t\tC';
  await t.exec('slide.new', {layout: 'titleAndContent', title: 'T', body});
  const sl = t.content.slides[cur(t)];
  const ph = sl.shapes.find(x => x.ph && !['title', 'ctrTitle'].includes(x.ph.kind));
  const viaNew = ph.text.paragraphs.map(p => [p.level, paraText(p)]);
  await t.exec('text.set', {id: ph.id, text: body});
  const viaSet = t.content.slides[cur(t)].shapes.find(x => x.id === ph.id).text.paragraphs.map(p => [p.level, paraText(p)]);
  assert.deepEqual(viaNew, viaSet);
});

test('layout_change_keeps_text', async () => {
  const t = await withNew();
  await t.exec('slide.new', {layout: 'titleAndContent', title: 'Keep me', body: 'Body text'});
  await t.exec('slide.layout', {layout: 'twoContent'});
  const sl = t.content.slides[cur(t)];
  const texts = sl.shapes.map(x => (x.text?.paragraphs ?? []).map(paraText).join('\n'));
  assert.ok(texts.includes('Keep me'), JSON.stringify(texts));
  assert.ok(texts.includes('Body text'), JSON.stringify(texts));
  const lay = t.content.masters[0].layouts.find(l => l.id === sl.layout);
  assert.equal(lay.kind, 'twoContent');
});

test('new_slide_body_goes_to_the_content_placeholder', async () => {
  const t = await withNew();
  for (const layout of ['titleAndContent', 'twoContent', 'comparison', 'contentWithCaption']) {
    await t.exec('slide.new', {layout, title: 'T', body: 'Body'});
    const sl = t.content.slides[cur(t)];
    const holder = sl.shapes.find(x => (x.text?.paragraphs ?? []).map(paraText).join('') === 'Body');
    assert.ok(holder, layout);
    assert.equal(holder.ph.idx, 1, `${layout}: the body goes to idx 1`);
  }
});

test('markdown_outlines_take_headings_as_slides_and_lists_as_bullets', async () => {
  const t = await withNew();
  await t.exec('slide.fromOutline', {markdown: true, text: '# One\n- a\n  - b\n# Two\nplain line\n'});
  const made = t.content.slides.slice(1);
  assert.equal(made.length, 2);
  assert.equal(paraText(made[0].shapes[0].text.paragraphs[0]), 'One');
  assert.deepEqual(made[0].shapes[1].text.paragraphs.map(p => [p.level, paraText(p)]), [[0, 'a'], [1, 'b']]);
  assert.deepEqual(made[1].shapes[1].text.paragraphs.map(p => [p.level, paraText(p)]), [[0, 'plain line']]);
});

test('plain_outlines_are_unchanged', async () => {
  const t = await withNew();
  await t.exec('slide.fromOutline', {text: 'Title A\n\tPoint 1\n\t\tSub\nTitle B\n- not a bullet title\n'});
  const made = t.content.slides.slice(1);
  assert.equal(made.length, 3);
  assert.deepEqual(made[0].shapes[1].text.paragraphs.map(p => [p.level, paraText(p)]), [[0, 'Point 1'], [1, 'Sub']]);
  assert.equal(paraText(made[2].shapes[0].text.paragraphs[0]), 'not a bullet title');
});

test('slides_from_outline_join_the_section_of_the_slide_they_follow', async () => {
  const t = await deckOf(3);
  await t.exec('section.add', {at: 1, name: 'Second'});
  await t.exec('slide.go', {index: 1});
  await t.exec('slide.fromOutline', {text: 'New A\nNew B'});
  const ids = t.content.slides.map(s => s.id);
  assert.deepEqual(t.content.sections.map(x => x.name), ['Default Section', 'Second']);
  assert.deepEqual([...t.content.sections[0].slides, ...t.content.sections[1].slides], ids);
  assert.deepEqual(t.content.sections[1].slides.slice(0, 3), [ids[1], ids[2], ids[3]]);
});

test('slide_hide_and_layout_reject_invalid_index', async () => {
  const t = await deckOf(2);
  for (const [cmd, p] of [['slide.hide', {index: -1}], ['slide.hide', {index: 2.5}], ['slide.layout', {layout: 'blank', index: -3}]]) {
    await assert.rejects(t.exec(cmd, p), undefined, cmd);
  }
  assert.ok(t.content.slides.every(s => !s.hidden));
});
