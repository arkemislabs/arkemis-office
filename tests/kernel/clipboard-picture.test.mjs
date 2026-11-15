// A picture copied in another program (a screenshot, "Copy image" in a browser) pastes in every app.
//
// It came through as an empty clipboard: the host read only text and HTML, so Slate said "The clipboard is empty",
// Grid "Nothing to paste", and Prism pasted nothing. The host now gives the picture as `picture` (a data URL) and, with
// no HTML of its own, as an <img> in `html` (electron/main.cjs). These tests give each app a host whose clipboard holds
// exactly that, and check the picture lands; the shared reader never takes the new picture for the app's own copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readClipboard} from '../../core/common/lib/clipboard.mjs';
import {textSession, textSel} from '../slate/format-helpers.mjs';
import {withNew} from '../prism/upstream/text_deck.mjs';
import prismInsert from '../../core/prism/commands/insert.mjs';
import {session as gridSession} from '../grid/edit-helpers.mjs';
import {typed, run as quillRun} from '../quill/text-fixture.mjs';

// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// What the host's clipboard read returns for a copied picture with no HTML of its own.
const copiedPicture = async () => ({text: '', html: `<img src="${PNG}" alt="">`, picture: PNG});

test('the shared reader passes a copied picture on, and never mistakes it for the app\'s own copy', async () => {
  const ctx = {app: 'prism', clipboard: {app: 'prism', kind: 'prism.shapes', text: '', data: {}}, host: {clipboardRead: copiedPicture}};
  const r = await readClipboard(ctx);
  assert.equal(r.source, 'external', 'a shape copied here (empty text) is not what a screenshot taken since pastes');
  assert.equal(r.picture, PNG);
  ctx.host.clipboardRead = async () => ({text: '', html: ''});
  assert.equal((await readClipboard(ctx)).source, 'internal', 'with no picture, our own copy still pastes');
});

test('Slate: a copied picture pastes onto the page (it said "The clipboard is empty")', async () => {
  const t = await textSession(['First'], {selection: p => textSel(p, 'b1', 5)});
  t.host.clipboardRead = copiedPicture;
  await t.exec('clipboard.paste');
  const json = JSON.stringify(t.content);
  assert.ok(json.includes(PNG.slice(0, 60)), 'the picture is on the page');
});

test('Prism: a copied picture goes on the slide as a picture', async () => {
  const t = await withNew({extra: [prismInsert]});
  t.host.clipboardRead = copiedPicture;
  const before = t.content.slides[0].shapes.length;
  await t.exec('edit.paste');
  const shapes = t.content.slides[0].shapes;
  assert.equal(shapes.length, before + 1, 'one shape more');
  assert.ok(/pic|image|picture/i.test(JSON.stringify(shapes.at(-1)).slice(0, 400)), 'and it is a picture');
});

test('Quill: a copied picture pastes as a picture (Quill read `picture`, which the host never sent)', async () => {
  const t = await typed('x');
  t.host.clipboardRead = copiedPicture;
  // A paste the person makes (Ctrl+V): only then is the system clipboard read.
  await quillRun(t, 'edit.paste', {}, 'shortcut');
  assert.ok(JSON.stringify(t.content).includes('image'), 'a picture is in the document');
});

test('Grid: a copied picture floats over the cells (it said "Nothing to paste")', async () => {
  const t = await gridSession();
  t.host.clipboardRead = copiedPicture;
  await t.exec('edit.paste');
  const json = JSON.stringify(t.content);
  assert.ok(/"pictures"|"images"|"objects"|image\/png/.test(json), 'a picture is in the workbook');
});
