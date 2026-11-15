// Ported from deckcraft crates/engine/src/tests.rs (`text_editing_flow`,
// `text_set_crlf_makes_clean_paragraphs`, `cut_with_only_a_caret_changes_nothing`,
// `smart_quotes_and_autocorrect`, `typing_kurdish_or_arabic_auto_detects_rtl_...` (model part),
// `ime_composition_replaces_its_preedit_and_commits_as_one_undo_step` (commit part),
// `autocorrect_options_as_you_type`, `autocorrect_superscripts_ordinals_as_you_type`,
// `editing_notes_keeps_their_formatting_through_pptx` (the notes edit), `find_and_replace_after_a_line_break`),
// crates/engine/src/cmd/text/caret.rs `select_paragraph_huge_at`, crates/engine/src/cmd/text/editing.rs
// `rtl_promote_tests`, crates/engine/src/cmd/text/formatting.rs `replace_font_tests` at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. Steps that need other families (format.italic,
// format.font, insert.textBox, format.bullets) are replaced by content placed directly or noted.
//
// 1. ArtCraft: cmd/text.rs + text/{editing,caret,ime,autocorrect,formatting}.rs; PowerPoint: typing
//    in a placeholder or text box, AutoCorrect as you type, Home › Editing › Replace Fonts.
// 2. Ours: the same edits on schema-2 bodies through the kernel; the text selection is the kernel
//    range (shape text, notes, table cells), the AutoCorrect options are prefs.prism.
// 3. These tests + tests/prism/text.test.mjs (undo round trips, layout moves) + the bridge E2E
//    tests/e2e/prism/text-editing.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {withNew, textBox, textOf, shapeOf, selected, textSel, typeChars, curSlide} from './text_deck.mjs';
import {promoteRtl} from '../../../core/prism/commands/text.mjs';
import {paraText, bodyText} from '../../../core/prism/model/text.mjs';

const titleId = t => curSlide(t).shapes[0].id;

test('text_editing_flow (format.italic is U:prism/format; the rest as upstream)', async () => {
  const t = await withNew();
  const title = titleId(t);
  await t.exec('text.edit', {id: title});
  await t.exec('text.insert', {text: 'Hello world'});
  await t.exec('text.move', {to: 'wordLeft', extend: true});
  assert.deepEqual([textSel(t).anchor, textSel(t).caret], [[0, 11], [0, 6]]);
  await t.exec('text.move', {to: 'end'});
  await t.exec('text.delete', {dir: 'backward'});
  await t.exec('text.insert', {text: 'D\nSecond'});
  const r = await t.exec('text.get', {id: title});
  assert.equal(r.result.text, 'Hello worlD\nSecond');
  await t.exec('text.exit', {});
  assert.equal(textSel(t), null);
  assert.deepEqual(selected(t), [title]);
});

test('text_set_crlf_makes_clean_paragraphs', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 200, 40], 'x')]});
  await t.exec('text.set', {id: '500', text: 'one\r\ntwo'});
  const g = (await t.exec('text.get', {id: '500'})).result;
  assert.equal(g.paragraphs[0].text, 'one');
  assert.equal(g.paragraphs[1].text, 'two');
  assert.equal(g.text, 'one\ntwo');
  await t.exec('text.set', {id: 500, text: 'a\rb'});
  assert.equal((await t.exec('text.get', {id: '500'})).result.text, 'a\nb');
});

test('cut_with_only_a_caret_changes_nothing', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 200, 40], 'Hello')]});
  await t.exec('text.edit', {id: '500'});
  await t.exec('text.move', {to: 'start'});
  const out = await t.exec('edit.cut', {});
  assert.equal(out.result.text, '');
  assert.equal(textOf(t, '500'), 'Hello', 'cut with only a caret changed the text');
  await t.exec('text.move', {to: 'end', extend: true});
  const out2 = await t.exec('edit.cut', {});
  assert.equal(out2.result.text, 'Hello');
  assert.equal(textOf(t, '500'), '');
});

test('smart_quotes_and_autocorrect', async () => {
  const t = await withNew();
  const title = titleId(t);
  await t.exec('text.edit', {id: title});
  for (const c of ['"', 'h', 'i', '"', ' ', 't', 'e', 'h', ' ']) await t.exec('text.insert', {text: c});
  assert.equal((await t.exec('text.get', {id: title})).result.text, '“hi” the ');
});

test('select_paragraph_huge_at', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 200, 50], 'hello')]});
  await t.exec('text.edit', {});
  await t.exec('text.selectParagraph', {at: [Number.MAX_SAFE_INTEGER, 0]});
  const s = textSel(t);
  // Clamped to the last (only) paragraph, never past the end of the body.
  assert.deepEqual([s.anchor, s.caret], [[0, 0], [0, 5]]);
});

test('rtl_promote_tests: right_aligns_only_when_no_alignment_is_set_or_inherited', () => {
  const para = x => ({level: 0, runs: [{text: x}]});
  let p = promoteRtl(para('مرحبا'), new Array(9).fill(false));
  assert.deepEqual([p.props.rtl, p.props.align], [true, 'right']);
  p = promoteRtl(para('مرحبا'), new Array(9).fill(true));
  assert.deepEqual([p.props.rtl, p.props.align], [true, undefined]);
  p = promoteRtl(para('Hello مرحبا'), new Array(9).fill(false));
  assert.equal(p.props, undefined);
});

test('typing Kurdish or Arabic auto-detects RTL; the title keeps its inherited alignment', async () => {
  const t = await withNew();
  const title = titleId(t);
  await t.exec('text.edit', {id: title});
  for (const ch of ['م', 'ن', ' ', 'ن', 'ا', 'و', 'م']) await t.exec('text.insert', {text: ch});
  const pp = shapeOf(t, title).text.paragraphs[0].props;
  assert.equal(pp.rtl, true, 'auto-detected as RTL');
  assert.equal(pp.align, undefined, 'the title keeps the alignment it inherits');
});

test('ime commit: the input method result is typed as one undo step (no AutoCorrect)', async () => {
  const t = await withNew();
  const title = titleId(t);
  await t.exec('text.edit', {id: title});
  const before = t.doc.undo.depth ?? null;
  const r = await t.exec('text.commit', {text: '日本語teh '});
  assert.deepEqual(r.result.caret, [0, 7]);
  assert.equal(textOf(t, title), '日本語teh ');
  await t.undo();
  assert.equal(textOf(t, title), '');
  void before;
  // Control characters never come from an input method.
  await t.exec('text.commit', {text: 'a\u0007b'});
  assert.equal(textOf(t, title), 'ab');
});

async function typed(t, id, s) {
  await t.exec('text.edit', {id});
  try { await t.exec('text.selectAll', {}); } catch { /* nothing */ }
  try { await t.exec('text.delete', {dir: 'backward'}); } catch { /* nothing */ }
  await typeChars(t, s);
  return (await t.exec('text.get', {id})).result.text;
}

test('autocorrect_options_as_you_type', async () => {
  const t = await withNew();
  const title = titleId(t);
  assert.equal(await typed(t, title, 'hello world. see you monday, i think. '), 'Hello world. See you Monday, I think. ');
  assert.equal(await typed(t, title, 'THe tHIS 1/2 recieved... '), 'The This ½ received… ');
  // `text.insert` reports the caret after the correction.
  assert.equal(await typed(t, title, '(c)'), '(c)');
  assert.deepEqual((await t.exec('text.insert', {text: ' '})).result.caret, [0, 2]);
  assert.equal((await t.exec('text.get', {id: title})).result.text, '© ');
  // Options turn rules off.
  await t.exec('text.autocorrect', {sentenceCaps: false, days: false});
  assert.equal(await typed(t, title, 'hello monday '), 'hello monday ');
  // Your own entries, and deleting a built-in one.
  await t.exec('text.autocorrect', {add: ['dc', 'DeckCraft'], remove: 'teh'});
  assert.equal(await typed(t, title, 'dc teh '), 'DeckCraft teh ');
  const v = (await t.exec('text.autocorrect', {})).result;
  assert.ok(v.entries.some(e => e[0] === 'dc'));
  assert.ok(!v.entries.some(e => e[0] === 'teh'));
  await assert.rejects(t.exec('text.autocorrect', {add: ['two words', 'x']}));
  // Off entirely.
  await t.exec('text.autocorrect', {on: false});
  assert.equal(await typed(t, title, 'dc adn '), 'dc adn ');
  // Pasting a whole string applies only the replacement list, not the case rules.
  await t.exec('text.autocorrect', {on: true, sentenceCaps: true});
  await t.exec('text.edit', {id: title});
  await t.exec('text.selectAll', {});
  await t.exec('text.insert', {text: 'monday notes '});
  assert.equal((await t.exec('text.get', {id: title})).result.text, 'monday notes ');
});

test('autocorrect_superscripts_ordinals_as_you_type', async () => {
  const t = await withNew();
  const title = titleId(t);
  const sup = async s => {
    await typed(t, title, s);
    return shapeOf(t, title).text.paragraphs[0].runs.map(r => ((r.props?.baseline ?? 0) > 0 ? `^(${r.text})` : r.text)).join('');
  };
  assert.equal(await sup('1st, 22nd and 103rd. 4th 11th x'), '1^(st), 22^(nd) and 103^(rd). 4^(th) 11^(th) x');
  assert.equal(await sup('first x1st 1th 2st 21st'), 'First x1st 1th 2st 21st');
  assert.equal((await t.exec('text.autocorrect', {})).result.ordinals, true);
  await t.exec('text.autocorrect', {ordinals: false});
  assert.equal(await sup('2nd '), '2nd ');
  await t.exec('text.autocorrect', {ordinals: true, on: false});
  assert.equal(await sup('2nd '), '2nd ');
});

test('autoformat lists: a lead stays typed while format.bullets/numbering (U:prism/format) is not registered', async () => {
  const t = await withNew();
  const title = titleId(t);
  // Upstream autoformat_starts_bulleted_and_numbered_lists_as_you_type needs format.bullets; without
  // it the lead is kept, never dropped (tests/prism/text.test.mjs runs the list path with a stub).
  assert.equal(await typed(t, title, '* x'), '* x');
  assert.equal(await typed(t, title, '1. x'), '1. x');
});

test('find_and_replace_after_a_line_break', async () => {
  const t = await withNew({shapes: [textBox('500', [10, 10, 300, 80], 'ab')]});
  await t.exec('text.edit', {id: '500', end: true});
  await t.exec('text.insert', {text: '\u000bcd'});
  await t.exec('text.exit', {});
  const found = (await t.exec('text.find', {text: 'cd'})).result;
  assert.deepEqual(found.map(m => [m.para, m.start, m.end]), [[0, 3, 5]]);
  await t.exec('text.replace', {text: 'cd', with: 'X'});
  assert.equal(textOf(t, '500'), 'ab\u000bX');
  assert.equal(shapeOf(t, '500').text.paragraphs[0].runs[1].kind.kind, 'break');
});

test('replace_font_tests: replaces runs, notes and theme fonts and undoes', async () => {
  const box = textBox('500', [10, 10, 200, 50], 'Hello');
  box.text.paragraphs[0].runs[0].props = {font: 'Comic Neue'};
  const t = await withNew({shapes: [box]});
  const theme = t.content.masters[0].theme.fonts.minor.latin;
  assert.ok((await t.exec('font.used', {})).result.includes('Comic Neue'));
  const r = await t.exec('font.replace', {from: 'comic neue', to: 'Lato'});
  assert.ok(r.result.replaced >= 1);
  const used = (await t.exec('font.used', {})).result;
  assert.ok(!used.includes('Comic Neue') && used.includes('Lato'), used.join());
  // The theme's body font is replaced too, so placeholders follow.
  await t.exec('font.replace', {from: theme, to: 'Lato'});
  assert.equal(t.content.masters[0].theme.fonts.minor.latin, 'Lato');
  await t.undo();
  await t.undo();
  assert.ok((await t.exec('font.used', {})).result.includes('Comic Neue'));
});

test('replace_font_tests: nothing to replace is no undo step and bad names fail', async () => {
  const t = await withNew();
  const depth = t.doc.undo.labels?.().length ?? t.doc.undo.length;
  assert.equal((await t.exec('font.replace', {from: 'Nope Sans', to: 'Inter'})).result.replaced, 0);
  assert.equal((await t.exec('font.replace', {from: '+mn-lt', to: 'Inter'})).result.replaced, 0);
  assert.equal(t.doc.undo.labels?.().length ?? t.doc.undo.length, depth);
  await assert.rejects(t.exec('font.replace', {from: '', to: 'Inter'}));
  await assert.rejects(t.exec('font.replace', {from: 'Inter', to: 'a\nb'}));
  await assert.rejects(t.exec('font.replace', {from: 'Inter'}));
});

test('editing notes: slide.notes text keeps the formatting of untouched notes', async () => {
  const t = await withNew();
  await t.exec('slide.notes', {text: 'Bold start and more'});
  const sl = curSlide(t);
  const notes = structuredClone(sl.notes);
  notes.paragraphs[0].runs = [{text: 'Bold start', props: {bold: true}}, {text: ' and more'}];
  await t.exec('slide.notes', {body: notes});
  await t.exec('slide.notes', {text: 'Bold start and much more'});
  const runs = curSlide(t).notes.paragraphs[0].runs;
  assert.equal(runs[0].text, 'Bold start');
  assert.equal(runs[0].props.bold, true);
  assert.equal(bodyText(curSlide(t).notes), 'Bold start and much more');
  void paraText;
});
