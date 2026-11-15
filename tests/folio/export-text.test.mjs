// U:folio/export — Export to text: export.text, dialog.export-text.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: printcraft crates/engine/src/export.rs:297 `text_of` (each page's text, trailing
//    white space trimmed, "\n" after it, a form feed before every page after the first),
//    workflows/export_ui.rs (Pages All / Current page / Range; "<name>.txt"; "Exported the text of
//    N pages"). Acrobat: Export a PDF ▸ Text (Plain).
// 2. Ours: the same text from the model's page text, written through the system Save dialog
//    (programmatic calls with no path get the text back; with `path` the host writes it).
// 3. Proof: these tests and tests/e2e/folio/edit-marks.e2e.mjs (export over the bridge).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import dialog from '../../core/folio/dialogs/export-text.mjs';

after(() => releaseTextSources());

test('Export to text: every page, separated by a form feed; a range; the report', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  const r = await t.exec('export.text', {});
  const text = r.result.text;
  const parts = text.split('\f');
  assert.equal(parts.length, 2);
  assert.ok(parts.every(p => p.endsWith('\n') && !/\s\n$/.test(p)));
  assert.equal(r.result.message, 'Exported the text of 2 pages');
  assert.equal(r.result.name, 'fixture.txt');
  const one = await t.exec('export.text', {pages: [1]});
  assert.equal(one.result.text, parts[1]);
  assert.equal(one.result.message, 'Exported the text of 1 page');
  await assert.rejects(t.exec('export.text', {pages: [5]}), /page 6 does not exist/);
  t.session.get(t.docId).file.content.permissions = {copy: false};
  assert.match(t.state('export.text').reason, /don't allow copying/);
});

test('Export to Text dialog: All / Current page / Range', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  const v = dialog.init(t.session.readContext(t.docId));
  assert.deepEqual(dialog.toCommand(v).params, {});
  assert.deepEqual(dialog.toCommand({...v, pages: 'Range', from: 1, to: 2}).params, {pages: [0, 1]});
  assert.deepEqual(dialog.toCommand({...v, pages: 'Current page'}).params, {pages: [0]});
  assert.deepEqual(dialog.validate({...v, pages: 'Range', from: 2, to: 1}).map(p => p.field), ['to']);
});
