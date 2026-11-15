// The smaller changes in printcraft 8f16855 since 3109bb2 that the PDF app follows: deleting a comment is refused while a reply that would
// go with it is locked (annot modify.rs `deletable`), the Background's default colour (edit marks.rs), and the file identifier of a document
// protected without one (crypt `file_id`).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft 0.16.0: a comment goes with its pop-up and replies, but a locked reply can't be deleted on its own and so does not go with the
//    comment it answers: Delete is refused (and not offered) while one is locked; the Background starts as a light yellow (1, 0.95, 0.7), not
//    a near-white that looked as if nothing had happened; /ID is derived from the encryption seed like the file key, not an unkeyed hash.
//    Acrobat's locked comments are protected from deletion the same way.
// 2. Ours does the same on real comments and a real protected file.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {textPdf} from '../../core/folio/fixtures.mjs';
import {defaultBackground} from '../../core/folio/lib/edit-marks.mjs';
import * as P from '../../core/folio/lib/protect.mjs';
import {fileId} from '../../core/folio/lib/crypt.mjs';

after(() => releaseTextSources());

test('Delete is refused, and not offered, while a reply that would go with the comment is locked', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages', prefs: {identity: {name: 'Ada'}}});
  await t.exec('comment.note', {page: 'p1', at: [100, 100], text: 'Parent'});
  const parent = t.content.pages[0].annots.find(r => r.dict.Contents?.$t === 'Parent');
  const address = `/pg:p1/annot:${parent.id}`;
  await t.exec('annot.reply', {annotation: address, text: 'A reply'});
  const reply = t.content.pages[0].annots.at(-1);
  assert.equal(t.state('annot.delete', {annotation: address}).enabled, true);
  await t.exec('annot.lock', {annotation: `/pg:p1/annot:${reply.id}`, locked: true});
  const st = t.state('annot.delete', {annotation: address});
  assert.deepEqual([st.enabled, st.reason], [false, 'a reply to it is locked']);
  await assert.rejects(() => t.exec('annot.delete', {annotation: address}), /a reply to it is locked/);
  assert.ok(t.content.pages[0].annots.some(r => r.id === parent.id), 'the comment stays');
  await t.exec('annot.lock', {annotation: `/pg:p1/annot:${reply.id}`, locked: false});
  assert.equal(t.state('annot.delete', {annotation: address}).enabled, true);
  const gone = (await t.exec('annot.delete', {annotation: address})).result.deleted;
  assert.equal(gone.length >= 2, true, 'the comment goes with its reply');
});

test('the Background starts as a light yellow that reads as a colour', () => {
  assert.deepEqual(defaultBackground().color, [1, 0.95, 0.7]);
});

test('a document protected without an /ID gets one of sixteen bytes derived from the seed, the same for the same seed', async () => {
  const a = await fileId(new Uint8Array(32).fill(7)), b = await fileId(new Uint8Array(32).fill(7)), c = await fileId(new Uint8Array(32).fill(8));
  assert.equal(a.length, 16);
  assert.deepEqual([...a], [...b]);
  assert.notDeepEqual([...a], [...c]);
  const doc = await PDFDocument.load(await textPdf({pages: 1}), {updateMetadata: false});
  doc.context.trailerInfo.ID = undefined;
  const rec = await P.protect(await doc.save(), {openPassword: 'pw', permissionsPassword: 'pw2', printing: 'None', changes: 'None'});
  assert.equal(rec.id0.length, 32, 'sixteen bytes as hex');
});
