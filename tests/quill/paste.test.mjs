// Quill paste family (core/quill/commands/paste.mjs): Paste Special.
//
// 1. What ArtCraft does: wordcraft crates/engine/src/cmd/paste.rs `paste_special`: without `as` it
//    lists the formats the clipboard holds (Formatted Text, RTF, HTML Format, Picture, Unformatted
//    Text, best first) and asks for the Paste Special dialog; with `as` it pastes that format
//    (`keep`/`plain`/`png` aliases), failing with "the clipboard has no … content (available: …)".
//    Word: Home › Paste ▾ › Paste Special… (Ctrl+Alt+V), the same list and Result description.
// 2. Ours: the same, over the schema-2 model; Formatted Text is our own copy while the system
//    clipboard still holds it; Picture goes through insert.picture; HTML through html-read.mjs; RTF is offered once its
//    reader exists (design note U-quill-paste--formats-rtf--rtf-reader).
// 3. This file, core/quill/dialogs/pasteSpecial.mjs tests below, and tests/e2e/quill/text-editing.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {changeDialogValues} from '../../core/kernel/dialog.mjs';
import pasteSpecialDialog from '../../core/quill/dialogs/pasteSpecial.mjs';
import {s, run, typed, plain, pos, setSel, bodyParas, charAt} from './text-fixture.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('edit.pasteSpecial without `as` lists the formats and asks for the dialog', async () => {
  const t = await typed('Hello');
  await setSel(t, pos(0, 0), pos(0, 5));
  await run(t, 'edit.copy');
  const r = await run(t, 'edit.pasteSpecial');
  assert.deepEqual(r.formats, [{id: 'formatted', label: 'Formatted Text'}, {id: 'text', label: 'Unformatted Text'}]);
  assert.equal(r.ui[0].open, 'pasteSpecial');
  const p = await run(t, 'edit.pasteSpecial', {text: 'other program', picture: PNG});
  assert.deepEqual(p.formats.map(f => f.id), ['picture', 'text'], 'another program copied since: not our own copy');
  assert.equal((await run(await s(), 'edit.pasteSpecial')).formats.length, 0);
});

test('edit.pasteSpecial as formatted keeps the formatting; as text pastes it plain (one undo step each)', async () => {
  const t = await typed('Hello');
  await setSel(t, pos(0, 0), pos(0, 5));
  await run(t, 'format.bold');
  await run(t, 'edit.copy');
  await run(t, 'caret.docEnd');
  const r = await expectUndoRoundTrip(t, 'edit.pasteSpecial', {as: 'formatted'}, () => assert.equal(plain(t), 'HelloHello'));
  assert.equal(r.result.pastedAs, 'formatted');
  assert.equal((await charAt(t, 0, 7)).bold, true);
  await run(t, 'edit.pasteSpecial', {as: 'unformatted'});
  assert.equal(plain(t), 'HelloHelloHello');
  assert.equal(t.doc.undo.peek().label, 'Paste Special');
});

test('edit.pasteSpecial as picture inserts the picture', async () => {
  const t = await typed('x');
  const r = await run(t, 'edit.pasteSpecial', {as: 'png', picture: PNG});
  assert.equal(r.pastedAs, 'picture');
  assert.ok((bodyParas(t)[0].objects ?? []).length > 0 || JSON.stringify(t.content).includes('image'), 'a picture object');
});

test('edit.pasteSpecial errors as upstream words them', async () => {
  const t = await typed('x');
  await assert.rejects(t.bridge('edit.pasteSpecial', {as: 'formatted'}), /the clipboard is empty/);
  await assert.rejects(t.bridge('edit.pasteSpecial', {as: 'html', text: 'abc'}), /no html content \(available: text\)/);
  await assert.rejects(t.bridge('edit.pasteSpecial', {as: 'bmp'}), e => e.code === 'invalid_params' && /unknown format/.test(e.message));
  assert.deepEqual([].concat(t.registry.get('edit.pasteSpecial').shortcut), ['Mod+Alt+V']);
});

test('dialog.pasteSpecial: formats from the payload, the Result text, OK pastes the chosen format', async () => {
  const t = await typed('Hello');
  await setSel(t, pos(0, 0), pos(0, 5));
  await run(t, 'edit.copy');
  let v = pasteSpecialDialog.init(t.session.readContext(t.docId));
  assert.deepEqual(v.formats, ['formatted', 'text']);
  assert.equal(v.as, 'formatted');
  assert.equal(pasteSpecialDialog.preview(null, v).hint, 'Keeps the fonts and formatting of the copied text.');
  v = changeDialogValues(pasteSpecialDialog, v, 'as', 'text');
  assert.deepEqual(pasteSpecialDialog.toCommand(v), {command: 'edit.pasteSpecial', params: {as: 'text'}});
  v = changeDialogValues(pasteSpecialDialog, v, 'text', 'From elsewhere');
  assert.deepEqual(v.formats, ['text'], 'someone else copied since');
  assert.deepEqual(pasteSpecialDialog.toCommand(v), {command: 'edit.pasteSpecial', params: {as: 'text', text: 'From elsewhere'}});
  const empty = pasteSpecialDialog.init((await s()).session.readContext((await s()).docId));
  assert.deepEqual(pasteSpecialDialog.validate(empty).map(e => e.message), ['The clipboard is empty.']);
});

test('another program\'s HTML pastes with its formatting (Paste and Paste Special as HTML); Copy gives HTML', async () => {
  const t = await typed('x');
  await expectUndoRoundTrip(t, 'edit.paste', {html: '<p><b>Bold</b> html</p><p>two</p>'}, () => assert.equal(plain(t), 'xBold html\ntwo'));
  assert.equal((await charAt(t, 0, 2)).bold, true);
  const r = await run(t, 'edit.pasteSpecial', {text: 'it', html: '<i>it</i>'});
  assert.deepEqual(r.formats.map(f => f.id), ['html', 'text']);
  await run(t, 'edit.pasteSpecial', {as: 'html', html: '<i>it</i>'});
  assert.equal((await charAt(t, 1, 3)).italic, true);
  await setSel(t, pos(0, 1), pos(0, 5));
  const c = await run(t, 'edit.copy');
  assert.equal(c.text, 'Bold');
  assert.ok(c.html.includes('<strong>Bold</strong>'), c.html);
});
