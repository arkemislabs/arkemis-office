// U:prism/find and the dialogs of the slide, text, edit and find families, driven headless the way
// the glass dialog drives them (core/kernel/dialog.mjs: open → change values → buttons / submit).
//
// 1. What ArtCraft does: deckcraft crates/ui-egui/src/dialogs/find.rs (Find Next steps through
//    text.find's matches with a "Match n of m on slide k" status, Replace replaces the current
//    match then finds the next, Replace All reports the count, Replace… switches modes) and
//    dialogs/body.rs (Paste Special 897, Replace Fonts 808, Slides from Outline 617, Rename
//    Section 692, AutoCorrect 1290). PowerPoint: Home › Editing › Find / Replace / Replace Fonts,
//    Paste Special, Rename Section, AutoCorrect Options.
// 2. Ours: the same values, buttons and commands; Find Next also selects the matched text, as
//    PowerPoint does. text.replace is one undo step.
// 3. These tests + tests/prism/upstream/find_tests.test.mjs + the bridge E2E
//    tests/e2e/prism/find-replace.e2e.mjs (dialog in the app, captured).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {openDialogModel, changeDialogValues, submitDialog, pressDialogButton} from '../../core/kernel/dialog.mjs';
import findDialog from '../../core/prism/dialogs/find.mjs';
import pasteSpecial from '../../core/prism/dialogs/pasteSpecial.mjs';
import replaceFonts from '../../core/prism/dialogs/replaceFonts.mjs';
import outline from '../../core/prism/dialogs/outline.mjs';
import renameSection from '../../core/prism/dialogs/renameSection.mjs';
import autocorrect from '../../core/prism/dialogs/autocorrect.mjs';
import {bodyText} from '../../core/prism/model/text.mjs';
import {currentSlideIndex} from '../../core/prism/model/doc.mjs';
import {withNew, textBox, rect, textOf, textSel, curSlide} from './upstream/text_deck.mjs';

const set = (d, v, k, x) => changeDialogValues(d, v, k, x);
/**
 * Press a dialog button the way the shell does (ShellController.pressField → execDialogCall runs a
 * {batch} as one step); the kernel's pressDialogButton runs single calls only.
 */
async function press(t, d, id, v) {
  const out = d.buttons[id](t.session.readContext(t.docId), v);
  if (!out) return null;
  return out.batch ? t.session.batch(t.docId, out.batch, {origin: 'dialog'}) : pressDialogButton(t.session, t.docId, {...d, buttons: {[id]: () => out}}, id, v);
}

test('text.find / text.replace: matches across slides and notes; replace one or all is one undo step', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 40], 'plan the plan')]});
  await t.exec('slide.notes', {text: 'plan B'});
  const all = (await t.exec('text.find', {text: 'plan'})).result;
  assert.deepEqual(all.map(m => [m.shape, m.para, m.start, m.end]), [['500', 0, 0, 4], ['500', 0, 9, 13], [null, 0, 0, 4]]);
  await expectUndoRoundTrip(t, 'text.replace', {text: 'plan', with: 'goal', at: all[1]}, after => {
    assert.equal(bodyText(after.content.slides[0].shapes.at(-1).text), 'plan the goal');
  });
  await expectUndoRoundTrip(t, 'text.replace', {text: 'PLAN', with: 'aim'}, after => {
    assert.equal(bodyText(after.content.slides[0].notes), 'aim B');
  });
  await assert.rejects(t.exec('text.find', {text: ''}));
});

test('Find dialog: Find Next steps through matches (status, selection), Replace, Replace All, Replace…', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 40], 'one two one')]});
  await t.exec('slide.new', {title: 'one more'});
  await t.exec('slide.go', {index: 0});
  let v = openDialogModel(t.session, t.docId, findDialog);
  assert.equal(v.replace, false);
  v = set(findDialog, v, 'text', 'one');
  await press(t, findDialog, 'findNext', v);
  assert.equal(v.status, 'Match 1 of 3 on slide 1.');
  assert.deepEqual([textSel(t).shape, textSel(t).anchor, textSel(t).caret], ['500', [0, 0], [0, 3]], 'the match is selected');
  await press(t, findDialog, 'findNext', v);
  assert.equal(v.status, 'Match 2 of 3 on slide 1.');
  await press(t, findDialog, 'findNext', v);
  assert.equal(v.status, 'Match 3 of 3 on slide 2.');
  assert.equal(currentSlideIndex(t.content, t.doc.selection), 1);
  // Replace… switches to replace mode; Replace replaces the current match and finds the next.
  await press(t, findDialog, 'replaceMode', v);
  assert.equal(v.replace, true);
  v.with = '1';
  await press(t, findDialog, 'replace', v);
  assert.equal(bodyText(t.content.slides[1].shapes[0].text), '1 more');
  assert.equal(v.status, 'Match 1 of 2 on slide 1.');
  await press(t, findDialog, 'replaceAll', v);
  assert.equal(v.status, 'Replaced 2 occurrence(s).');
  assert.equal(textOf(t, '500'), '1 two 1');
  await t.undo();
  assert.equal(textOf(t, '500'), 'one two one');
  v = set(findDialog, v, 'text', 'zebra');
  await press(t, findDialog, 'findNext', v);
  assert.equal(v.status, 'Prism can\'t find “zebra”.');
});

test('Paste Special dialog: As choices, Result line, Keep Source Formatting needs copied shapes', async () => {
  const t = await withNew({shapes: [rect('500', [10, 10, 80, 40], 'Box')]});
  let v = openDialogModel(t.session, t.docId, pasteSpecial);
  assert.equal(v.result, 'Pastes the contents of the Clipboard into your presentation using the destination theme.');
  v = set(pasteSpecial, v, 'as', 'keepSource');
  assert.match(v.result, /keeping the formatting of the source/);
  assert.deepEqual(pasteSpecial.validate(v).map(e => e.field), ['as'], 'nothing copied yet');
  await t.exec('edit.copy', {});
  v = set(pasteSpecial, openDialogModel(t.session, t.docId, pasteSpecial), 'as', 'keepSource');
  assert.deepEqual(pasteSpecial.validate(v), []);
  const r = await submitDialog(t.session, t.docId, pasteSpecial, v);
  assert.equal(r.result.ids.length, 1);
  assert.equal(curSlide(t).shapes.length, 4);
});

test('Replace Font dialog: lists the fonts used, replaces and reports, stays usable', async () => {
  const box = textBox('500', [10, 10, 200, 40], 'Hi');
  box.text.paragraphs[0].runs[0].props = {font: 'Georgia'};
  const t = await withNew({shapes: [box]});
  let v = openDialogModel(t.session, t.docId, replaceFonts);
  assert.ok(v.used.includes('Georgia'));
  v = set(replaceFonts, set(replaceFonts, v, 'from', 'Georgia'), 'to', 'Inter');
  await pressDialogButton(t.session, t.docId, replaceFonts, 'replace', v);
  assert.equal(v.result, 'Replaced “Georgia” with “Inter”.');
  assert.equal(curSlide(t).shapes.at(-1).text.paragraphs[0].runs[0].props.font, 'Inter');
  v = set(replaceFonts, set(replaceFonts, v, 'from', 'Georgia'), 'to', 'Lato');
  await pressDialogButton(t.session, t.docId, replaceFonts, 'replace', v);
  assert.equal(v.result, '“Georgia” isn\'t used explicitly.');
});

test('Slides from Outline, Rename Section and AutoCorrect dialogs submit their commands', async () => {
  const t = await withNew();
  let v = set(outline, openDialogModel(t.session, t.docId, outline), 'text', 'Agenda\n\tIntro\nWrap-up');
  await submitDialog(t.session, t.docId, outline, v);
  assert.equal(t.content.slides.length, 3);
  assert.deepEqual(renameSection.validate(openDialogModel(t.session, t.docId, renameSection)).length, 1, 'no section yet');
  await t.exec('section.add', {at: 1, name: 'Body'});
  await t.exec('slide.go', {index: 2});
  v = openDialogModel(t.session, t.docId, renameSection);
  assert.deepEqual([v.index, v.name], [1, 'Body']);
  await submitDialog(t.session, t.docId, renameSection, set(renameSection, v, 'name', 'Main part'));
  assert.equal(t.content.sections[1].name, 'Main part');
  v = openDialogModel(t.session, t.docId, autocorrect);
  assert.equal(v.days, true);
  assert.ok(v.entries.some(e => e[0] === 'teh'));
  v = set(autocorrect, set(autocorrect, v, 'from', 'pp'), 'to', 'PowerPoint');
  await pressDialogButton(t.session, t.docId, autocorrect, 'add', v);
  await submitDialog(t.session, t.docId, autocorrect, set(autocorrect, v, 'days', false));
  const opts = (await t.exec('text.autocorrect', {})).result;
  assert.equal(opts.days, false);
  assert.ok(opts.entries.some(e => e[0] === 'pp' && e[1] === 'PowerPoint'));
});
