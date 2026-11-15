// U:prism/slide on schema-2 presentations: every edit command's undo round trip, selection after
// each command, sections bookkeeping, layouts by id/name/kind, hide toggling, reset, notes, rename,
// navigation and the request the surface sends (design note F-prism--slide--schema2).
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/slide.rs (each command, file:line in the
//    family header); PowerPoint: Home › Slides (New Slide with the layout gallery, Layout, Reset,
//    Section), Insert › Duplicate Slide, Slide Show › Hide Slide, the thumbnail pane (click,
//    Shift/Ctrl-click, drag to reorder, Delete), the notes pane.
// 2. Ours: the same document changes and selection (deckcraft's current slide, selected slides,
//    Shift-click anchor) through the kernel; each edit is one undo step that restores slides,
//    sections and nextId.
// 3. Proved by these tests, tests/prism/upstream/slide_tests.test.mjs and the bridge E2E
//    tests/e2e/prism/slide-ribbon.e2e.mjs (ribbon buttons, layout gallery, thumbnails, notes pane).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {currentSlideIndex, selectedSlideIds} from '../../core/prism/model/doc.mjs';
import {paraText, bodyText} from '../../core/prism/model/text.mjs';
import {findLayout} from '../../core/prism/commands/slide.mjs';
import {withNew, rect} from './upstream/text_deck.mjs';

async function deckOf(n) {
  const t = await withNew();
  while (t.content.slides.length < n) await t.exec('slide.new', {});
  return t;
}
const cur = t => currentSlideIndex(t.content, t.doc.selection);
const layoutKind = (t, i) => t.content.masters[0].layouts.find(l => l.id === t.content.slides[i].layout).kind;

test('slide.new: Title and Content after a title slide, then the current layout; undo restores slides and nextId', async () => {
  const t = await withNew();
  const r = await expectUndoRoundTrip(t, 'slide.new', {});
  assert.equal(r.result.index, 1);
  assert.equal(layoutKind(t, 1), 'titleAndContent');
  assert.equal(cur(t), 1);
  await t.exec('slide.layout', {layout: 'twoContent'});
  await t.exec('slide.new', {});
  assert.equal(layoutKind(t, 2), 'twoContent');
  // A layout id (the gallery sends it), a name and a kind all work; an unknown one is refused.
  const blankId = t.content.masters[0].layouts.find(l => l.kind === 'blank').id;
  await t.exec('slide.new', {layout: blankId});
  assert.equal(layoutKind(t, 3), 'blank');
  await t.exec('slide.new', {layout: 'Section Header'});
  assert.equal(layoutKind(t, 4), 'sectionHeader');
  await assert.rejects(t.exec('slide.new', {layout: 'nope'}), e => e.code === 'invalid_params');
  assert.equal(findLayout(t.content, 'TITLE ONLY', 0), t.content.masters[0].layouts.find(l => l.kind === 'titleOnly').id);
  // at: inserts there.
  const at0 = await t.exec('slide.new', {at: 0, layout: 'blank'});
  assert.equal(at0.result.index, 0);
  assert.equal(t.content.slides[0].id, at0.result.id);
});

test('slide.new joins the section of the slide before it', async () => {
  const t = await deckOf(3);
  await t.exec('section.add', {at: 1, name: 'Middle'});
  await t.exec('slide.go', {index: 1});
  await expectUndoRoundTrip(t, 'slide.new', {}, after => {
    const sec = after.content.sections[1].slides;
    assert.equal(sec[1], after.content.slides[2].id);
  });
});

test('slide.duplicate copies the selected slides after the last, with new shape ids; undo', async () => {
  const t = await deckOf(3);
  await t.exec('slide.selectSlides', {indices: [0, 2]});
  const r = await expectUndoRoundTrip(t, 'slide.duplicate', {});
  assert.equal(r.result.ids.length, 2);
  assert.deepEqual(t.content.slides.slice(3).map(s => s.id), r.result.ids);
  const src = t.content.slides[0], copy = t.content.slides[3];
  assert.notEqual(copy.shapes[0].id, src.shapes[0].id);
  assert.deepEqual(selectedSlideIds(t.content, t.doc.selection), r.result.ids);
});

test('slide.delete: selected slides, by index, by ids; sections drop them; undo', async () => {
  const t = await deckOf(4);
  await t.exec('section.add', {at: 2});
  const ids = t.content.slides.map(s => s.id);
  await expectUndoRoundTrip(t, 'slide.delete', {ids: [ids[1], ids[2]]}, after => {
    assert.deepEqual(after.content.slides.map(s => s.id), [ids[0], ids[3]]);
    assert.deepEqual(after.content.sections.flatMap(x => x.slides), [ids[0], ids[3]]);
  });
  assert.equal(cur(t), 1);
  await t.undo();
  await t.exec('slide.selectSlides', {indices: [1, 2]});
  await t.exec('slide.delete', {});
  assert.deepEqual(t.content.slides.map(s => s.id), [ids[0], ids[3]]);
  await t.exec('slide.delete', {index: 0});
  assert.deepEqual(t.content.slides.map(s => s.id), [ids[3]]);
  // deckcraft deletes what the ids name; an id that is no slide changes nothing.
  await t.exec('slide.delete', {ids: ['nope']});
  assert.deepEqual(t.content.slides.map(s => s.id), [ids[3]]);
});

test('slide.move keeps sections in step and selects the moved slide; undo', async () => {
  const t = await deckOf(4);
  await t.exec('section.add', {at: 2, name: 'Two'});
  const ids = t.content.slides.map(s => s.id);
  await expectUndoRoundTrip(t, 'slide.move', {from: 0, to: 3}, after => {
    assert.deepEqual(after.content.slides.map(s => s.id), [ids[1], ids[2], ids[3], ids[0]]);
    assert.deepEqual(after.content.sections[1].slides, [ids[2], ids[3], ids[0]]);
  });
  assert.equal(cur(t), 3);
});

test('navigation: go, next, previous, first, last never change the document', async () => {
  const t = await deckOf(3);
  const v = t.version;
  await t.exec('slide.first', {});
  assert.equal(cur(t), 0);
  await t.exec('slide.next', {});
  assert.equal(cur(t), 1);
  await t.exec('slide.last', {});
  assert.equal(cur(t), 2);
  await t.exec('slide.next', {});
  assert.equal(cur(t), 2, 'stays on the last slide');
  await t.exec('slide.previous', {});
  assert.equal(cur(t), 1);
  await t.exec('slide.go', {id: t.content.slides[0].id});
  assert.equal(cur(t), 0);
  await assert.rejects(t.exec('slide.go', {index: 9}));
  await assert.rejects(t.exec('slide.go', {}));
  assert.equal(t.version, v);
});

test('slide.hide toggles the selected slides (all hidden → shown) and reports checked; undo', async () => {
  const t = await deckOf(3);
  await t.exec('slide.selectSlides', {indices: [1, 2]});
  await expectUndoRoundTrip(t, 'slide.hide', {}, after => assert.deepEqual(after.content.slides.map(s => !!s.hidden), [false, true, true]));
  assert.equal(t.state('slide.hide').checked, true);
  await t.exec('slide.hide', {});
  assert.deepEqual(t.content.slides.map(s => !!s.hidden), [false, false, false]);
  await t.exec('slide.hide', {index: 0, hidden: true});
  assert.equal(t.content.slides[0].hidden, true);
});

test('slide.layout re-maps placeholders (text kept, empty ones dropped) on every selected slide; undo', async () => {
  const t = await withNew();
  await t.exec('slide.new', {layout: 'titleAndContent', title: 'T1', body: 'B1'});
  await t.exec('slide.new', {layout: 'titleAndContent', title: 'T2'});
  await t.exec('slide.selectSlides', {indices: [1, 2]});
  await expectUndoRoundTrip(t, 'slide.layout', {layout: 'titleOnly'}, after => {
    const s1 = after.content.slides[1], s2 = after.content.slides[2];
    assert.equal(after.content.masters[0].layouts.find(l => l.id === s1.layout).kind, 'titleOnly');
    // The body with text stays (positioned), the empty body goes.
    assert.deepEqual(s1.shapes.map(x => bodyText(x.text)), ['T1', 'B1']);
    assert.deepEqual(s2.shapes.map(x => bodyText(x.text)), ['T2']);
    assert.equal(s1.shapes[0].xfrm, null, 'a matched placeholder follows the layout again');
  });
  // The Layouts gallery lists the master's layouts by id (Home › Layout, Home › New Slide).
  const gallery = t.state('slide.layout').value;
  assert.deepEqual(gallery.map(x => x.value), t.content.masters[0].layouts.map(l => l.id));
  assert.equal(gallery[0].label, 'Title Slide');
  assert.deepEqual(t.state('slide.new').value, gallery);
});

test('slide.reset puts placeholders back to the layout look and drops the background; undo', async () => {
  const t = await withNew();
  await t.exec('slide.new', {layout: 'titleAndContent', title: 'Title'});
  const i = cur(t);
  const c = structuredClone(t.content);
  const sl = c.slides[i];
  sl.background = {kind: 'solid'};
  sl.shapes[0] = {...sl.shapes[0], xfrm: {x: 1, y: 2, w: 3, h: 4}, fill: {kind: 'none'}};
  sl.shapes[0].text.paragraphs[0].props = {align: 'right'};
  sl.shapes[0].text.paragraphs[0].runs[0].props = {bold: true};
  t.doc.dirty = false;
  t.session.reload(t.docId, {...t.file, content: c});
  t.session.setSelection(t.docId, {ranges: [{anchor: `/sl:${sl.id}`, focus: `/sl:${sl.id}`}], primary: 0});
  await expectUndoRoundTrip(t, 'slide.reset', {}, after => {
    const s = after.content.slides[i];
    assert.equal(s.background, null);
    assert.equal(s.shapes[0].xfrm, null);
    assert.equal(s.shapes[0].fill, null);
    assert.equal(s.shapes[0].text.paragraphs[0].props, undefined);
    assert.equal(s.shapes[0].text.paragraphs[0].runs[0].props, undefined);
    assert.equal(paraText(s.shapes[0].text.paragraphs[0]), 'Title', 'text kept');
  });
});

test('slide.notes saves typed notes (as the notes pane does on blur) and rename; undo', async () => {
  const t = await deckOf(2);
  await expectUndoRoundTrip(t, 'slide.notes', {text: 'Say hello\nThen wave', index: 0}, after => {
    assert.equal(bodyText(after.content.slides[0].notes), 'Say hello\nThen wave');
  });
  await assert.rejects(t.exec('slide.notes', {body: {paragraphs: 'x'}}));
  await expectUndoRoundTrip(t, 'slide.rename', {name: 'Intro', index: 1}, after => assert.equal(after.content.slides[1].name, 'Intro'));
});

test('sections: add (Default Section first), rename, move (slides follow), remove (with and without slides), remove all; undo each', async () => {
  const t = await deckOf(4);
  const ids = t.content.slides.map(s => s.id);
  await expectUndoRoundTrip(t, 'section.add', {at: 2, name: 'Second'}, after => {
    assert.deepEqual(after.content.sections, [{name: 'Default Section', slides: [ids[0], ids[1]]}, {name: 'Second', slides: [ids[2], ids[3]]}]);
  });
  await t.exec('section.add', {at: 3});
  assert.deepEqual(t.content.sections.map(x => x.name), ['Default Section', 'Second', 'Untitled Section']);
  await expectUndoRoundTrip(t, 'section.rename', {index: 2, name: 'Third'}, after => assert.equal(after.content.sections[2].name, 'Third'));
  await expectUndoRoundTrip(t, 'section.move', {index: 2, to: 0}, after => {
    assert.deepEqual(after.content.slides.map(s => s.id), [ids[3], ids[0], ids[1], ids[2]]);
  });
  // Sections are now Third [3], Default Section [0, 1], Second [2]: removing one joins its slides to the section before.
  await expectUndoRoundTrip(t, 'section.remove', {index: 1}, after => {
    assert.deepEqual(after.content.sections.map(x => x.name), ['Third', 'Second']);
    assert.deepEqual(after.content.sections[0].slides, [ids[3], ids[0], ids[1]]);
  });
  await expectUndoRoundTrip(t, 'section.remove', {index: 1, slides: true}, after => {
    assert.deepEqual(after.content.slides.map(s => s.id), [ids[3], ids[0], ids[1]]);
  });
  await expectUndoRoundTrip(t, 'section.removeAll', {}, after => assert.deepEqual(after.content.sections, []));
  await assert.rejects(t.exec('section.rename', {index: 9, name: 'x'}));
});

test('slide.fromOutline inserts after the current slide; undo', async () => {
  const t = await deckOf(2);
  await t.exec('slide.go', {index: 0});
  await expectUndoRoundTrip(t, 'slide.fromOutline', {text: 'Alpha\n\tOne\nBeta'}, after => {
    assert.equal(after.content.slides.length, 4);
    assert.equal(bodyText(after.content.slides[1].shapes[0].text), 'Alpha');
    assert.equal(bodyText(after.content.slides[2].shapes[0].text), 'Beta');
  });
});

test('selection commands (surface contract): selectSlides by ids with add, selectRange, go', async () => {
  const t = await deckOf(5);
  const ids = t.content.slides.map(s => s.id);
  await t.exec('slide.selectSlides', {ids: [ids[1]]});
  await t.exec('slide.selectSlides', {ids: [ids[3]], add: true});
  assert.deepEqual(selectedSlideIds(t.content, t.doc.selection), [ids[1], ids[3]]);
  assert.equal(cur(t), 3);
  await t.exec('slide.selectRange', {to: 4, add: true});
  assert.deepEqual(selectedSlideIds(t.content, t.doc.selection), [ids[1], ids[3], ids[4]]);
});

test('a shape selection on the slide: slide.go clears it', async () => {
  const t = await withNew({shapes: [rect('500', [10, 10, 40, 40])]});
  await t.exec('slide.go', {index: 0});
  assert.deepEqual(t.doc.selection.ranges.map(r => r.anchor), [`/sl:${t.content.slides[0].id}`]);
});
