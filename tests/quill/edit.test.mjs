// Quill edit family (core/quill/commands/edit.mjs): Clipboard (Cut, Copy, Paste and its Keep Source /
// Merge Formatting / Keep Text Only options, the Clipboard pane, the Spike), Find and Replace, Go To,
// Go Back and the Format Painter.
//
// 1. What ArtCraft does: wordcraft crates/engine/src/cmd/edit.rs (copy, cut, spike, insert_spike,
//    paste, paste_merge, paste_text, ClipHistory, paste_clip, paste_all_clips, find, advanced_find,
//    step, replace, replace_all, goto, painter, paste_format), cmd/paste.rs (paste_content,
//    merge_formatting), cmd/find_pattern.rs (^ codes, wildcards) and session/query.rs (go_back).
//    Word: Ctrl+X/C/V, Paste Options (Keep Source Formatting, Merge Formatting, Keep Text Only),
//    the Clipboard pane (24 items, Paste All, Clear All), Ctrl+F3 / Ctrl+Shift+F3 Spike, Ctrl+H
//    Find and Replace with ^p ^t ^& and wildcards, F5 Go To (+2 / -1 pages, bookmarks), Shift+F5,
//    Format Painter (double-click: sticky), Ctrl+Shift+C / Ctrl+Shift+V.
// 2. Ours runs the same steps over the schema-2 model. A Copy or Cut the person makes also goes to
//    the system clipboard through the host; a Paste the person makes reads it (bridge calls carry
//    the payload in params, as upstream's control channel). HTML/RTF payloads paste formatted once
//    HTML through core/quill/formats/html-read.mjs, RTF once its reader exists (design note U-quill-paste--formats-rtf--rtf-reader).
// 3. This file (every edit.* id of the family, undo round trips, bridge params),
//    tests/quill/upstream/{text_typing,edit_moves,edit_find_pattern}.test.mjs and the bridge E2E
//    tests/e2e/quill/text-editing.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {s, run, typ, typed, plain, sel, pos, setSel, undo, bodyParas, charAt, addr} from './text-fixture.mjs';

const selectedText = t => {
  const {anchor: a, focus: b} = sel(t);
  return a.path[0] === b.path[0] ? bodyParas(t)[a.path[0]].text.slice(Math.min(a.off, b.off), Math.max(a.off, b.off)) : null;
};

test('edit.copy returns the text, fills the app clipboard and the Clipboard pane; nothing changes', async () => {
  const t = await typed('Hello world');
  await setSel(t, pos(0, 0), pos(0, 5));
  const v = t.version;
  const r = await run(t, 'edit.copy');
  assert.equal(r.text, 'Hello');
  assert.equal(t.version, v);
  assert.equal(t.session.clipboard.text, 'Hello');
  const items = await run(t, 'edit.clipboardItems');
  assert.deepEqual(items.map(i => i.preview), ['Hello']);
});

test('edit.copy and edit.cut made by the person reach the system clipboard', async () => {
  const t = await typed('Hello world');
  await setSel(t, pos(0, 6), pos(0, 11));
  await run(t, 'edit.copy', {}, 'shortcut');
  assert.equal((await t.host.clipboardRead()).text, 'world');
  await setSel(t, pos(0, 0), pos(0, 6));
  await run(t, 'edit.cut', {}, 'ui');
  assert.equal((await t.host.clipboardRead()).text, 'Hello ');
  assert.equal(plain(t), 'world');
});

test('edit.cut deletes the selection (one undo step) and edit.paste puts it back with its formatting', async () => {
  const t = await typed('Hello world');
  await setSel(t, pos(0, 0), pos(0, 5));
  await run(t, 'format.bold');
  await expectUndoRoundTrip(t, 'edit.cut', {}, () => assert.equal(plain(t), ' world'));
  await run(t, 'caret.docEnd');
  await expectUndoRoundTrip(t, 'edit.paste', {}, () => assert.equal(plain(t), ' worldHello'));
  assert.equal((await charAt(t, 0, 6)).bold, true, 'Keep Source Formatting');
  assert.equal(t.state('edit.cut').enabled, false, 'nothing selected');
  assert.equal(t.state('edit.cut').reason, 'nothing is selected');
});

test('edit.paste of another program\'s text pastes as Keep Text Only', async () => {
  const t = await typed('ab');
  await setSel(t, pos(0, 1));
  await expectUndoRoundTrip(t, 'edit.paste', {text: 'X\nY'}, () => assert.deepEqual(bodyParas(t).map(p => p.text), ['aX', 'Yb']));
  await assert.rejects((await s()).bridge('edit.paste', {}), /clipboard is empty/);
});

test('edit.pasteText pastes plain text in the formatting at the caret', async () => {
  const t = await typed('Hello');
  await setSel(t, pos(0, 0), pos(0, 5));
  await run(t, 'format.italic');
  await run(t, 'edit.copy');
  await run(t, 'caret.docEnd');
  await expectUndoRoundTrip(t, 'edit.pasteText', {}, () => assert.equal(plain(t), 'HelloHello'));
  await run(t, 'edit.pasteText', {text: ' more'});
  assert.equal(plain(t), 'HelloHello more');
});

test('edit.pasteMerge keeps only emphasis and takes the destination formatting', async () => {
  const t = await typed('src dest');
  await setSel(t, pos(0, 0), pos(0, 3));
  await run(t, 'format.bold');
  await run(t, 'format.fontSize', {size: 20}).catch(() => run(t, 'format.size', {size: 20}).catch(() => null));
  await run(t, 'edit.copy');
  await setSel(t, pos(0, 8));
  await expectUndoRoundTrip(t, 'edit.pasteMerge', {}, () => assert.equal(plain(t), 'Src destSrc'));
  await run(t, 'edit.pasteMerge');
  const c = await charAt(t, 0, 8);
  assert.equal(c.bold, true, 'emphasis kept');
  assert.equal(c.size, undefined, 'the source size is not kept');
});

test('the Clipboard pane: items newest first, paste one, Paste All, delete one, Clear All', async () => {
  const t = await typed('one two three');
  for (const [a, b] of [[0, 3], [4, 7], [8, 13]]) { await setSel(t, pos(0, a), pos(0, b)); await run(t, 'edit.copy'); }
  assert.deepEqual((await run(t, 'edit.clipboardItems')).map(i => i.preview), ['three', 'two', 'One']);
  const pane = await run(t, 'edit.clipboardPane');
  assert.equal(pane.value, true);
  assert.equal(t.state('edit.clipboardPane').checked, true);
  await run(t, 'caret.docEnd');
  await expectUndoRoundTrip(t, 'edit.pasteClipboardItem', {index: 1}, () => assert.equal(plain(t), 'One two threetwo'));
  await expectUndoRoundTrip(t, 'edit.pasteAllClipboard', {}, () => assert.equal(plain(t), 'One two threetwoOnetwothree'));
  assert.equal((await run(t, 'edit.deleteClipboardItem', {index: 0})).length, 2);
  await assert.rejects(t.bridge('edit.pasteClipboardItem', {index: 9}), e => e.code === 'invalid_params');
  assert.equal((await run(t, 'edit.clearClipboard')).length, 0);
  assert.equal(t.state('edit.pasteAllClipboard').enabled, false);
});

test('edit.spike collects cuts and edit.insertSpike inserts them in order and empties it', async () => {
  const t = await typed('alpha beta gamma');
  await setSel(t, pos(0, 0), pos(0, 6));
  await expectUndoRoundTrip(t, 'edit.spike', {}, () => assert.equal(plain(t), 'beta gamma'));
  await setSel(t, pos(0, 0), pos(0, 5));
  await run(t, 'edit.spike');
  assert.equal(plain(t), 'gamma');
  await run(t, 'caret.docEnd');
  await expectUndoRoundTrip(t, 'edit.insertSpike', {}, () => {
    const x = plain(t);
    assert.ok(x.startsWith('gamma') && x.indexOf('Alpha') > 0 && x.indexOf('Alpha') < x.indexOf('beta'), x);
  });
  assert.equal(t.state('edit.insertSpike').enabled, false, 'the Spike is empty');
});

test('edit.find selects the first match after the caret; without text it opens the search box', async () => {
  const t = await typed('one two one two');
  await run(t, 'caret.docStart');
  const r = await run(t, 'edit.find', {text: 'two'});
  assert.equal(r.count, 2);
  assert.deepEqual([sel(t).anchor, sel(t).focus], [pos(0, 4), pos(0, 7)]);
  const ui = await run(t, 'edit.find');
  assert.deepEqual(ui.ui, [{focus: 'navSearch'}]);
});

test('edit.findNext / edit.findPrevious step through the matches and wrap', async () => {
  const t = await typed('a x b x c x');
  await run(t, 'caret.docStart');
  const n1 = await run(t, 'edit.findNext', {text: 'x'});
  assert.equal(n1.index, 0);
  const n2 = await run(t, 'edit.findNext');
  assert.equal(n2.index, 1);
  const p = await run(t, 'edit.findPrevious');
  assert.equal(p.index, 0);
  await assert.rejects(run(t, 'edit.findNext', {text: 'zzz'}), /no matches/);
});

test('edit.advancedFind counts matches in the main document or the selection, with Reading Highlight', async () => {
  const t = await typed('cat dog cat dog cat');
  let r = await run(t, 'edit.advancedFind', {text: 'cat', highlight: true});
  assert.equal(r.count, 3);
  assert.equal(r.highlight, true);
  assert.equal(t.doc.view.quill.find.highlights.length, 3);
  await setSel(t, pos(0, 0), pos(0, 8));
  r = await run(t, 'edit.advancedFind', {text: 'cat', in: 'selection', highlight: false});
  assert.equal(r.count, 1);
  assert.deepEqual(await run(t, 'edit.advancedFind'), {count: 1, ui: [{open: 'find'}]});
});

test('edit.replace replaces the selected match and selects the next', async () => {
  const t = await typed('a x b x');
  await run(t, 'caret.docStart');
  await run(t, 'edit.findNext', {text: 'x'});
  await expectUndoRoundTrip(t, 'edit.replace', {text: 'x', with: 'Y'}, () => assert.equal(plain(t), 'A Y b x'));
  assert.equal(selectedText(t), 'x', 'the next match is selected');
  const r = await run(t, 'edit.replace', {text: 'x', with: 'Y'});
  assert.equal(r.remaining, 0);
  assert.equal(plain(t), 'A Y b Y');
});

test('edit.replaceAll: one undo step, ^p and ^t codes, ^& the found text, wildcards with \\1', async () => {
  const t = await typed('red green red');
  // As upstream (find_pattern.rs expand): the replacement goes in as typed, whatever the match's case.
  await expectUndoRoundTrip(t, 'edit.replaceAll', {text: 'red', with: 'blue'}, () => assert.equal(plain(t), 'blue green blue'));
  let r = await run(t, 'edit.replaceAll', {text: 'blue', with: '[^&]'});
  assert.equal(r.replaced, 2);
  assert.equal(plain(t), '[blue] green [blue]');
  r = await run(t, 'edit.replaceAll', {text: ' ', with: '^p'});
  assert.equal(bodyParas(t).length, 3);
  const w = await typed('Smith, John');
  await run(w, 'edit.replaceAll', {text: '(<*>), (<*>)', with: '\\2 \\1', wildcards: true});
  assert.equal(plain(w), 'John Smith');
  const m = await typed('Word word WORD');
  assert.equal((await run(m, 'edit.replaceAll', {text: 'word', with: 'x', matchCase: true})).replaced, 1);
  assert.equal((await run(m, 'edit.replaceAll', {text: 'wor', with: 'y', wholeWord: true})).replaced, 0);
});

test('edit.findReplace opens Find and Replace on its tab', async () => {
  const t = await typed('x');
  assert.deepEqual(await run(t, 'edit.findReplace', {tab: 'goto'}), {open: 'goto'});
  assert.deepEqual(await run(t, 'edit.findReplace'), {open: 'replace'});
  assert.deepEqual([].concat(t.registry.get('edit.findReplace').shortcut), ['Mod+H']);
});

test('edit.goto goes to a page, a page relative to the caret, a bookmark (selected) or a paragraph', async () => {
  const t = await s();
  await run(t, 'text.insert', {text: Array.from({length: 150}, (_, i) => `Line ${i + 1}`).join('\n'), paragraphs: true, raw: true});
  await run(t, 'edit.goto', {page: 2});
  const p2 = sel(t).focus.path[0];
  assert.ok(p2 > 10, `page 2 starts further down: ${p2}`);
  await run(t, 'edit.goto', {pageBy: -1});
  assert.deepEqual(sel(t).focus, pos(0, 0));
  await run(t, 'edit.goto', {paragraph: 3});
  assert.deepEqual(sel(t).focus, pos(2, 0));
  await setSel(t, pos(4, 0), pos(4, 6));
  await run(t, 'insert.bookmark', {name: 'here'});
  await run(t, 'caret.docStart');
  await run(t, 'edit.goto', {bookmark: 'here'});
  assert.equal(selectedText(t), 'Line 5');
  await assert.rejects(run(t, 'edit.goto', {bookmark: 'nope'}), /no bookmark/);
  assert.deepEqual((await run(t, 'edit.goto')).ui, [{open: 'goto'}]);
});

test('edit.goBack returns to the last edits', async () => {
  const t = await typed('One\nTwo');
  await run(t, 'caret.docStart');
  await run(t, 'edit.goBack');
  assert.deepEqual(sel(t).focus, pos(1, 3));
});

test('Format Painter: pick up, paint once (or sticky), Copy/Paste Formatting', async () => {
  const t = await typed('bold plain');
  await setSel(t, pos(0, 0), pos(0, 4));
  await run(t, 'format.bold');
  await setSel(t, pos(0, 1));
  assert.deepEqual(await run(t, 'edit.formatPainter'), {active: true});
  assert.equal(t.state('edit.formatPainter').checked, true);
  await setSel(t, pos(0, 5), pos(0, 10));
  await expectUndoRoundTrip(t, 'edit.pasteFormat', {}, async () => assert.equal((await charAt(t, 0, 6)).bold, true));
  assert.equal(t.state('edit.pasteFormat').enabled, false, 'the painter turns off after one use');
  await setSel(t, pos(0, 1));
  await run(t, 'edit.copyFormat');
  await setSel(t, pos(0, 5), pos(0, 10));
  await run(t, 'edit.pasteFormat');
  assert.equal((await charAt(t, 0, 7)).bold, true);
  await run(t, 'edit.formatPainter', {sticky: true});
  await run(t, 'edit.pasteFormat');
  assert.equal(t.state('edit.pasteFormat').enabled, true, 'sticky stays on');
  assert.deepEqual(await run(t, 'edit.formatPainter'), {active: false});
});

test('bridge: edit commands validate params; paste from the bridge never reads the system clipboard', async () => {
  const t = await typed('x');
  await t.host.clipboardWrite({text: 'SYSTEM'});
  await assert.rejects(t.bridge('edit.paste', {}), /clipboard is empty/);
  await t.bridge('edit.paste', {text: 'B'});
  assert.equal(plain(t), 'xB');
  await assert.rejects(t.bridge('edit.goto', {page: 0}), e => e.code === 'invalid_params');
  await assert.rejects(t.bridge('edit.advancedFind', {text: 'x', in: 'everywhere'}), e => e.code === 'invalid_params');
  void typ; void undo; void addr;
});

test('dialog.find: Find Next / Replace / Replace All / Reading Highlight / Go To buttons with upstream messages', async () => {
  const {default: findDialog, gotoPage, specialItems} = await import('../../core/quill/dialogs/find.mjs');
  const {pressDialogButton, changeDialogValues} = await import('../../core/kernel/dialog.mjs');
  const t = await typed('cat dog cat dog cat');
  await run(t, 'caret.docStart');
  const ctx = () => t.session.readContext(t.docId);
  let v = findDialog.init(ctx());
  assert.equal(v.findWhat, '');
  assert.throws(() => findDialog.buttons.findNext(ctx(), v), /Type what to find/);
  v = changeDialogValues(findDialog, v, 'findWhat', 'cat');
  await pressDialogButton(t.session, t.docId, findDialog, 'findNext', v);
  v = {...v, ...findDialog.init(ctx()), findWhat: 'cat'};
  assert.equal(v.status, 'Match 1 of 3');
  await pressDialogButton(t.session, t.docId, findDialog, 'findNext', v);
  assert.equal(findDialog.init(ctx()).status, 'Match 2 of 3');
  await pressDialogButton(t.session, t.docId, findDialog, 'readingHighlight', v);
  assert.equal(findDialog.init(ctx()).status, '3 items highlighted');
  v = changeDialogValues(findDialog, v, 'replaceWith', 'bird');
  await pressDialogButton(t.session, t.docId, findDialog, 'replace', v);
  assert.equal(plain(t), 'Cat dog bird dog cat');
  await pressDialogButton(t.session, t.docId, findDialog, 'replaceAll', v);
  assert.equal(plain(t), 'bird dog bird dog bird');
  assert.equal(findDialog.init(ctx()).status, 'All done. We made 2 replacements.');
  // Special ▾ goes into the field that last had the focus; wildcards grey the word options.
  v = changeDialogValues(findDialog, {...v, toReplace: true}, 'special', '^t');
  assert.equal(v.replaceWith, 'bird^t');
  assert.equal(v.special, null);
  v = changeDialogValues(findDialog, {...v, matchCase: true}, 'wildcards', true);
  assert.equal(v.matchCase, false);
  assert.deepEqual(specialItems({toReplace: true, wildcards: true})[0], ['Find What Expression', String.raw`\1`]);
  // Go To: a page, +n / -n, empty = next page.
  assert.deepEqual([gotoPage(''), gotoPage('+2'), gotoPage('-1'), gotoPage('3'), gotoPage('x'), gotoPage('0')], [{pageBy: 1}, {pageBy: 2}, {pageBy: -1}, {page: 3}, null, null]);
  assert.throws(() => findDialog.buttons.goTo(ctx(), {goToWhat: 'page', pageNumber: 'abc'}), /Type a page number, or \+2 \/ -1\./);
  assert.deepEqual(findDialog.buttons.goTo(ctx(), {goToWhat: 'bookmark', bookmarkName: 'here'}), {command: 'edit.goto', params: {bookmark: 'here'}});
  assert.deepEqual(findDialog.buttons.previous(), {command: 'edit.goto', params: {pageBy: -1}});
});
