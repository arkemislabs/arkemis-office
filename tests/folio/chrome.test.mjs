// core/folio/commands/chrome.mjs: the mode tabs, the All tools list and its expanded view, fit toggle, Find tools and
// the notice bar.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/ui-egui chrome.rs (mode_bar, right_rail), panels/tools.rs, panels/all_tools_ui.rs,
//    canvas/bars.rs (notices): four modes; the All tools list shows 14 tools until View more; the expanded view lists every tool
//    under its category and a search keeps the tools whose name or item matches; the fit button toggles width and page; the
//    notice bar says one message (security first, with the form's sentence before it), Dismiss closes it for the document and
//    Don't show again hides the secured notice everywhere.
// 2. Ours does the same on a real PDF.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {noticeOf, SECURED} from '../../core/folio/lib/notice.mjs';

after(() => releaseTextSources());
const open = () => createTestSession('folio', {fixture: 'textPages'});
const view = t => t.doc.view;

test('view.mode asks the window for a mode tab; only the four modes exist', async () => {
  const t = await open();
  assert.equal(view(t).modeReq, undefined);
  await t.exec('view.mode', {mode: 'edit'});
  assert.deepEqual([view(t).modeReq.mode, view(t).modeReq.n], ['edit', 1]);
  await t.exec('view.mode', {mode: 'edit'});
  assert.equal(view(t).modeReq.n, 2, 'asking again is a new request the window follows');
  await t.exec('view.mode', {mode: 'esign'});
  assert.equal(view(t).modeReq.mode, 'esign');
  await assert.rejects(t.exec('view.mode', {mode: 'read'}), /mode/);
});

test('Expand all tools opens the expanded view in the All tools mode; Collapse closes it; the search is kept as typed', async () => {
  const t = await open();
  assert.equal((await t.session.state(t.docId, 'view.tools_full', {})).checked, false);
  await t.exec('view.tools_full', {open: true});
  assert.equal(view(t).toolsFull, true);
  assert.equal(view(t).modeReq.mode, 'all-tools');
  assert.equal((await t.session.state(t.docId, 'view.tools_full', {})).checked, true);
  await t.exec('view.tools_search', {query: 'rotate'});
  assert.equal((await t.session.state(t.docId, 'view.tools_search', {})).value, 'rotate');
  await t.exec('view.tools_full', {open: false});
  assert.equal(view(t).toolsFull, false);
  await t.exec('view.tools_full', {});
  assert.equal(view(t).toolsFull, true, 'with no `open` it toggles');
});

test('View more toggles the full list; Find tools and Toggle fit page / fit width', async () => {
  const t = await open();
  await t.exec('view.tools_more', {});
  assert.equal(view(t).toolsMore, true);
  await t.exec('view.tools_more', {on: false});
  assert.equal(view(t).toolsMore, false);
  await t.exec('view.palette', {});
  await t.exec('view.palette', {});
  assert.equal(view(t).paletteReq, 2);
  await t.exec('view.zoom.fit_width', {});
  assert.equal((await t.exec('view.fit_toggle', {})).result.fit, 'page', 'from fit width to fit page');
  assert.equal((await t.exec('view.fit_toggle', {})).result.fit, 'width', 'and back');
  assert.equal(view(t).fit, 'width');
  await t.exec('view.zoom.actual_size', {});
  assert.equal((await t.exec('view.fit_toggle', {})).result.fit, 'width', 'from a zoom percent it fits the width first');
});

test('the notice bar: nothing for a plain page; a form says what it is; Dismiss closes it for the document', async () => {
  const plain = await open();
  assert.equal((await plain.exec('notice.read', {})).result.notice, null);
  assert.equal((await plain.session.state(plain.docId, 'notice.dismiss', {})).enabled, false, 'there is no notice to dismiss');
  const t = await createTestSession('folio', {fixture: 'blankForm'});
  await t.exec('form.detect', {}).catch(() => {});
  const n = noticeOf({...t.content, fields: [{kind: 'text'}, {kind: 'text'}, {kind: 'pushbutton'}]}, {}, {});
  assert.equal(n.text, 'This document contains 2 interactive form fields.', 'push buttons are nothing to fill in');
  assert.deepEqual([n.kind, n.fields, n.security, n.unlock, n.dontShow], ['form', true, false, false, false]);
  assert.equal(noticeOf({...t.content, fields: [{kind: 'pushbutton'}]}, {}, {}), null);
  assert.equal(noticeOf({...t.content, fields: [{kind: 'text'}]}, {noticeDismissed: true}, {}), null);
});

test('a secured document says so, with the form sentence first; Unlock only when a permissions password lifts it; Don\'t show again is for every document', async () => {
  const src = await open();
  await src.exec('protect.restrict_editing', {permissionsPassword: 'boss', printing: 'Low Resolution (150 dpi)', changes: 'None', copy: false, screenReader: true});
  assert.equal((await src.exec('notice.read', {})).result.notice, null, 'protection that Save has not written yet is not a secured document');
  const reopened = await migrateContent(await createPdfContent(await writeFolioPdf(src.content, {encrypt: true}), 'file.pdf'));
  const t = await createTestSession('folio', {content: reopened});
  const n = (await t.exec('notice.read', {})).result.notice;
  assert.equal(n.text, SECURED);
  assert.deepEqual([n.kind, n.security, n.unlock, n.dontShow, n.fields], ['secured', true, true, true, false]);
  const withForm = noticeOf({...reopened, fields: [{kind: 'text'}]}, {}, {});
  assert.equal(withForm.text, `This document contains 1 interactive form fields. ${SECURED}`, 'the security sentence follows the form\'s');
  assert.equal(withForm.fields, true);
  // Don't show again: a preference, so every document.
  await t.exec('notice.hide_secured', {});
  assert.equal(t.prefs?.hideSecuredNotice ?? (await t.exec('notice.read', {})).result.notice, null);
  assert.equal(noticeOf(reopened, {}, {hideSecuredNotice: true}), null);
  assert.equal(noticeOf({...reopened, fields: [{kind: 'text'}]}, {}, {hideSecuredNotice: true}).kind, 'form', 'the form notice stays');
  // Dismiss closes it for this document only.
  const u = await createTestSession('folio', {content: reopened});
  await u.exec('notice.dismiss', {});
  assert.equal((await u.exec('notice.read', {})).result.notice, null);
});
