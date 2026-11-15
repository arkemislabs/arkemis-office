// U:folio/edit — Header & Footer, Bates numbering, Watermark, Background (add / update / remove),
// Create links from URLs, Remove all links: edit.header_footer, edit.header_footer.update,
// edit.header_footer.remove, edit.bates, edit.watermark, edit.watermark.update,
// edit.watermark.remove, edit.background, edit.background.update, edit.background.remove,
// edit.links_from_urls, edit.remove_links; dialogs dialog.header-footer, dialog.watermark,
// dialog.background.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: printcraft crates/ui-egui/src/commands.rs:477-545 (Add/Update open the marks dialog,
//    Update replaces; Bates numbering opens Header & Footer with <<Bates Number#6#1##>> in the
//    bottom-right box; Remove takes that kind off every page, "there is nothing to remove"),
//    dialogs/marks_ui.rs (the draft, Page Range Options, Insert Page Number / Insert Date into the
//    focused box, Fit to page = size 0), crates/edit/src/apply.rs + place.rs (tagged streams, the
//    q/Q wrapper), crates/annot/src/links.rs (find_urls, add_many, remove_all). Acrobat: Edit a PDF ▸
//    Header & Footer / Watermark / Background ▸ Add, Update, Remove; Bates Numbering; Link ▸ Create
//    links from URLs / Remove all links.
// 2. Ours: the same page content written into the PDF source (one undo step), visible in the page
//    text (pdf.js extraction of the saved file) and kept by Save; links become Link annotations.
// 3. Proof: these tests, tests/folio/upstream/edit_marks.test.mjs (tests.rs ports) and
//    tests/e2e/folio/edit-marks.e2e.mjs (an existing PDF on disk edited over the bridge, saved,
//    reopened, captured).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content} from '../../core/folio/fixtures.mjs';
import {releaseTextSources, pageText} from '../../core/folio/model/page-text.mjs';
import {marksOf} from '../../core/folio/lib/edit-needs.mjs';
import {clearDrafts} from '../../core/folio/lib/edit-mark-dialog.mjs';
import {findUrlRanges} from '../../core/folio/lib/edit-links.mjs';
import hfDialog from '../../core/folio/dialogs/header-footer.mjs';
import wmDialog from '../../core/folio/dialogs/watermark.mjs';
import bgDialog from '../../core/folio/dialogs/background.mjs';

after(() => releaseTextSources());

const session = () => createTestSession('folio', {fixture: 'textPages'});
const textOf = async (content, i) => (await pageText(content, content.pages[i])).plain().text;
async function savedText(t, i) {
  const bytes = await writeFolioPdf(t.content);
  const content = await migrateContent(await schema1Content(bytes));
  return textOf(content, i);
}
const ctxOf = t => t.session.readContext(t.docId);

test('Add header & footer draws the boxes with page numbers on every page; undo restores; Save keeps it', async () => {
  const t = await session();
  const before = t.content.sourceBase64;
  const r = await expectUndoRoundTrip(t, 'edit.header_footer', {text: ['', 'ACME report', '', '', '<<Page 1 of n>>', '']}, after => {
    assert.notEqual(after.content.sourceBase64, before);
  });
  assert.equal(r.undoLabel, 'Add header & footer');
  assert.deepEqual(r.result.pages, [0, 1]);
  assert.match(await textOf(t.content, 0), /ACME report/);
  assert.match(await textOf(t.content, 1), /Page 2 of 2/);
  assert.match(await savedText(t, 0), /Page 1 of 2/);
  assert.deepEqual(marksOf(t.content), ['HeaderFooter']);
  assert.equal(t.state('edit.header_footer.update').enabled, true);
  await t.undo();
  assert.equal(t.content.sourceBase64, before);
  assert.equal(t.state('edit.header_footer.update').reason, 'This document has no header or footer to change');
  assert.equal(t.state('edit.header_footer.remove').enabled, false);
});

test('Update replaces the header on the range; Remove takes it off every page; nothing left refuses', async () => {
  const t = await session();
  await t.exec('edit.header_footer', {text: ['First', '', '', '', '', '']});
  const r = await expectUndoRoundTrip(t, 'edit.header_footer.update', {text: ['Second', '', '', '', '', ''], from: 2, to: 2});
  assert.equal(r.undoLabel, 'Update header & footer');
  assert.match(await textOf(t.content, 0), /First/);
  assert.doesNotMatch(await textOf(t.content, 1), /First/);
  assert.match(await textOf(t.content, 1), /Second/);
  const rm = await expectUndoRoundTrip(t, 'edit.header_footer.remove', {});
  assert.equal(rm.undoLabel, 'Remove header & footer');
  assert.equal(rm.result.removed, 2);
  assert.doesNotMatch(await textOf(t.content, 0), /First|Second/);
  await assert.rejects(t.exec('edit.header_footer.remove', {}), e => e.code === 'disabled' && /no header or footer/.test(e.message));
});

test('Bates numbering puts a 6-digit number from the start in the bottom-right box', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'edit.bates', {start: 41, prefix: 'ABC', digits: 6});
  assert.equal(r.undoLabel, 'Add header & footer');
  assert.match(await textOf(t.content, 0), /ABC000041/);
  assert.match(await textOf(t.content, 1), /ABC000042/);
});

test('Watermark: text on top or behind, odd pages only, update and remove; refuses text no installed font can draw', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'edit.watermark', {text: 'CONFIDENTIAL', subset: 'odd', opacity: 0.3});
  assert.equal(r.undoLabel, 'Add watermark');
  assert.deepEqual(r.result.pages, [0]);
  assert.match(await textOf(t.content, 0), /CONFIDENTIAL/);
  assert.doesNotMatch(await textOf(t.content, 1), /CONFIDENTIAL/);
  const u = await t.exec('edit.watermark.update', {text: 'DRAFT', behind: true});
  assert.equal(u.undoLabel, 'Update watermark');
  assert.doesNotMatch(await textOf(t.content, 0), /CONFIDENTIAL/);
  assert.match(await savedText(t, 1), /DRAFT/);
  await t.exec('edit.watermark.remove', {});
  assert.deepEqual(marksOf(t.content), []);
  await assert.rejects(t.exec('edit.watermark', {text: `x ${String.fromCodePoint(0x10FFFD)}`}), /standard fonts can't draw/);
  await assert.rejects(t.exec('edit.watermark', {text: '  '}), /type the watermark text first/);
});

test('Watermark and Background from a picture file (PDF page or PNG, as base64)', async () => {
  const t = await session();
  const other = await PDFDocument.create();
  other.addPage([200, 100]).drawText('LOGO', {x: 20, y: 40, size: 30, font: await other.embedFont(StandardFonts.Helvetica)});
  const b64 = Buffer.from(await other.save()).toString('base64');
  await t.exec('edit.watermark', {file: {base64: b64, name: 'logo.pdf', page: 1}, scale: 0.5});
  assert.match(await textOf(t.content, 0), /LOGO/);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6fe1f0000000049454e44ae426082', 'hex');
  await t.exec('edit.background', {file: {base64: png.toString('base64'), name: 'dot.png'}, from: 2, to: 2});
  assert.deepEqual(marksOf(t.content).sort(), ['Background', 'Watermark']);
  await assert.rejects(t.exec('edit.background', {file: {base64: Buffer.from('hello').toString('base64')}}), /only PDF, PNG and JPEG/);
});

test('Background: a colour behind the content, update, remove', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'edit.background', {color: [1, 1, 0.85]});
  assert.equal(r.undoLabel, 'Add background');
  assert.match(await textOf(t.content, 0), /Arkemis|page|\w/);
  await t.exec('edit.background.update', {color: [0.9, 0.9, 1]});
  assert.equal((await t.exec('edit.background.remove', {})).result.removed, 2);
});

test('Marks follow a page turned in the model (drawn upright as displayed) and a duplicated page changes alone', async () => {
  const t = await session();
  await t.exec('page.rotate', {pages: [1]});
  await t.exec('page.duplicate', {pages: [0]});
  await t.exec('edit.header_footer', {text: ['', 'Only one', '', '', '', ''], pages: [1]});
  assert.match(await textOf(t.content, 1), /Only one/);
  assert.doesNotMatch(await textOf(t.content, 0), /Only one/);
  assert.match(await savedText(t, 1), /Only one/);
});

test('without a PDF, or when security forbids changes, the commands say why', async () => {
  const t = await session();
  t.session.get(t.docId).file.content.permissions = {modify: false};
  assert.equal(t.state('edit.header_footer').reason, "The document's security settings don't allow this change");
});

test('the marks dialogs: draft kept between openings, page ranges, Insert Page Number into the focused box, Fit to page', async () => {
  clearDrafts();
  const t = await session();
  const ctx = ctxOf(t);
  let v = hfDialog.init(ctx);
  assert.equal(v.size, 8);
  assert.deepEqual([v['margin-top'], v['margin-bottom'], v['margin-left'], v['margin-right']], [36, 36, 72, 72]);
  assert.equal(v.to, 2);
  v = {...v, 'right-footer-text': 'Page '};
  v = {...v, ...hfDialog.derive(v, ['right-footer-text'])};
  v = {...v, 'page-format': 'Page 1 of n', 'insert-page': 1};
  v = {...v, ...hfDialog.derive(v, ['insert-page'])};
  assert.equal(v['right-footer-text'], 'Page <<Page 1 of n>>');
  v = {...v, 'insert-date': 1, 'date-format': 'yyyy-mm-dd'};
  v = {...v, ...hfDialog.derive(v, ['insert-date'])};
  assert.equal(v['right-footer-text'], 'Page <<Page 1 of n>><<yyyy-mm-dd>>');
  assert.deepEqual(hfDialog.validate({...v, 'right-footer-text': ''}).map(p => p.field), ['center-header-text']);
  assert.deepEqual(hfDialog.validate({...v, 'left-header-text': 'Ω'}), [], 'a letter of another script is drawn with a system font when the mark is added (tests/folio/marks-unicode.test.mjs)');
  const call = hfDialog.toCommand({...v, scope: 'Pages from', from: 2, to: 2, subset: 'Even pages only'});
  assert.equal(call.command, 'edit.header_footer');
  assert.deepEqual([call.params.from, call.params.to, call.params.subset], [2, 2, 'even']);
  // The draft is kept: the next opening starts from it.
  assert.equal(hfDialog.init(ctx)['right-footer-text'], 'Page <<Page 1 of n>><<yyyy-mm-dd>>');
  const r = await t.exec(call.command, call.params);
  assert.deepEqual(r.result.pages, [1]);
  const pv = hfDialog.preview(ctx, {...v});
  assert.equal(pv.label, 'Preview: page 1 of 2');
  assert.equal(pv.applies, 'Applies to 2 pages');

  let w = wmDialog.init(ctx);
  assert.equal(w.fit, true);
  w = {...w, text: 'SECRET', rotation: 'None'};
  w = {...w, ...wmDialog.derive(w, ['rotation'])};
  assert.equal(w.degrees, 0);
  const wc = wmDialog.toCommand(w);
  assert.deepEqual([wc.params.fontSize, wc.params.rotation, wc.params.opacity], [0, 0, 0.5]);
  assert.deepEqual(wmDialog.validate({...w, source: 'File'}).map(p => p.field), ['file']);
  const bc = bgDialog.toCommand({...bgDialog.init(ctx), color: '#FF0000', opacity: 40});
  assert.deepEqual([bc.params.color, bc.params.opacity], [[1, 0, 0], 0.4]);
});

test('Create links from URLs turns web addresses and e-mail addresses into Link annotations; Remove all links', async () => {
  assert.deepEqual(findUrlRanges('see www.example.com, or mail me@example.org. http://x'), [[[4, 19], 'http://www.example.com'], [[29, 43], 'mailto:me@example.org']]);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Visit https://example.com/office today', {x: 72, y: 700, size: 14, font});
  const content = await migrateContent(await schema1Content(await doc.save()));
  const t = await createTestSession('folio', {content});
  await assert.rejects(t.exec('edit.remove_links', {}), /there are no links to remove/);
  const r = await expectUndoRoundTrip(t, 'edit.links_from_urls', {});
  assert.equal(r.result.created, 1);
  assert.equal(r.undoLabel, 'Create link');
  const link = t.content.pages[0].annots.find(a => a.dict.Subtype === '/Link');
  assert.ok(link.dict.Rect[0] >= 100 && link.dict.Rect[1] > 690 && link.dict.Rect[3] < 720, JSON.stringify(link.dict.Rect));
  await assert.rejects(t.exec('edit.links_from_urls', {}), /no web addresses were found/);
  const out = await PDFDocument.load(await writeFolioPdf(t.content));
  const annots = out.getPage(0).node.Annots().asArray().map(a => out.context.lookup(a));
  const uri = annots[0].lookup(PDFDocument.prototype.constructor && (await import('pdf-lib')).PDFName.of('A'));
  assert.ok(uri, 'the saved link has an action');
  const rm = await expectUndoRoundTrip(t, 'edit.remove_links', {});
  assert.equal(rm.result.removed, 1);
});
