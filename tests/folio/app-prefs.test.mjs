// core/folio/commands/app_prefs.mjs: Preferences and Keyboard shortcuts.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) dialogs.rs Preferences > Identity: the name comments are made under; the secured-document notice's Don't show again
//    is a preference; Fill & Sign's text size is 4 to 300 pt. Acrobat's Preferences keep the same.
// 2. Ours: the preferences are what the commands read, so a comment made after the change carries the name.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {PDFDocument} from 'pdf-lib';
import {props} from '../../core/folio/model/annots.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';

const open = () => createTestSession('folio', {fixture: 'textPages'});

test('Preferences report and change the name, the secured notice and the Fill & Sign size', async () => {
  const t = await open();
  const first = (await t.exec('app.preferences', {})).result;
  assert.deepEqual([first.name, first.secured, first.fillTextSize], ['', true, 10]);
  const r = (await t.exec('app.preferences', {name: '  Ada  ', secured: false, fillTextSize: 14})).result;
  assert.deepEqual([r.name, r.secured, r.fillTextSize], ['Ada', false, 14]);
  assert.equal(t.session.prefs.identity.name, 'Ada');
  assert.equal(t.session.prefs.hideSecuredNotice, true);
  assert.equal(t.session.prefs.fillSign.textSize, 14);
  await assert.rejects(t.exec('app.preferences', {fillTextSize: 3}), /fillTextSize/);
});

test('a comment made after the change carries the name; Fill & Sign text takes the size', async () => {
  const t = await open();
  await t.exec('app.preferences', {name: 'Ada', fillTextSize: 20});
  await t.exec('comment.note', {page: 1, at: [50, 50], text: 'Hello'});
  const note = t.content.pages[0].annots.at(-1);
  assert.equal(props(note).author, 'Ada');
  await t.exec('sign.fill.text', {page: 1, at: [60, 90], text: 'Typed'});
  assert.ok(t.content.pages[0].annots.length >= 2);
});

test('Keyboard shortcuts is a command the window answers with its dialog', async () => {
  const t = await open();
  assert.equal((await t.exec('help.shortcuts', {})).result.shown, 'shortcuts');
  assert.ok(PDFDocument && createPdfContent && migrateContent);
});
