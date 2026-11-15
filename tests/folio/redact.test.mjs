// core/folio/commands/redact.mjs: the Redact tool, Redact pages, Find text and redact (phrase, word list,
// patterns), Redaction tool properties, Apply redactions, Clear marks, Remove hidden information, Sanitize.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/ui-egui/src/commands.rs:724-764, tools/redact_ui.rs, crates/redact, crates/engine
//    commands.rs Needs::HasRedactions): a mark is a Redact comment over text lines or a box; Redact pages marks
//    whole pages; Find text and redact marks every match (a phrase, a list, or a pattern) in one step; Apply
//    asks first (destructive), removes what is under the marks from the page content, the comments and fields that
//    overlap them, draws each mark as a box in its colour with its overlay text and verifies; Clear drops the
//    marks; Remove hidden information and Sanitize take the hidden categories out. Acrobat's Redact does the same.
// 2. Ours does the same end to end: commands on a real PDF, the saved bytes searched with every stream decoded,
//    read back with pdf.js.
// 3. Tests below, tests/folio/redact-engine.test.mjs and redact-patterns.test.mjs, tests/e2e/folio/redact.e2e.mjs.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFStream, PDFRawStream, decodePDFRawStream} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip, expectApprovalRequired} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {releaseTextSources, pageText} from '../../core/folio/model/page-text.mjs';
import {LINES} from '../../core/folio/fixtures.mjs';
import {everything} from './redact-helpers.mjs';

after(() => releaseTextSources());
const open = () => createTestSession('folio', {fixture: 'textPages'});
/** One page of the text fixture: the byte-level proofs search the whole file, so no other page may hold the same words. */
const onePage = async () => {
  const {textPdf, schema1Content} = await import('../../core/folio/fixtures.mjs');
  const {migrateContent} = await import('../../core/folio/migrate.mjs');
  return createTestSession('folio', {content: await migrateContent(await schema1Content(await textPdf({pages: 1}), 'one.pdf'))});
};

const textOf = async (bytes, page = 1) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0});
  const t = (await (await (await task.promise).getPage(page)).getTextContent()).items.map(i => i.str).join('|');
  await task.destroy();
  return t;
};
const savedDoc = async t => PDFDocument.load(await writeFolioPdf(t.content), {updateMetadata: false});
const marks = t => t.content.pages.flatMap(p => (p.annots ?? []).filter(r => r.dict.Subtype === '/Redact'));

test('Redact text and images: a drag across text marks it with a Redact comment that follows the lines, a box marks an area; nothing is removed yet', async () => {
  const t = await open();
  const page = t.content.pages[0];
  const text = await pageText(t.content, page);
  const at = text.plainText().indexOf('quick brown');
  const r = await t.exec('redact.mark', {text: `/pg:${page.id}/chars:${at}-${at + 11}`});
  assert.ok(r.result.id);
  assert.equal(marks(t).length, 1);
  assert.equal(marks(t)[0].dict.Subtype, '/Redact');
  assert.equal(marks(t)[0].dict.QuadPoints.length % 8, 0);
  await t.exec('redact.mark', {page: page.id, area: [300, 100, 120, 40]});
  assert.equal(marks(t).length, 2);
  const read = (await t.exec('redact.marks', {})).result.marks;
  assert.deepEqual([read.length, read[0].page, read[0].fill], [2, 1, [0, 0, 0]], 'redact.marks reads them');
  const area = marks(t)[1].dict.QuadPoints;
  assert.equal(area.length, 8);
  assert.ok(Math.abs(Math.max(area[0], area[2], area[4], area[6]) - Math.min(area[0], area[2], area[4], area[6]) - 120) < 0.01, 'the box is 120 points wide');
  // Marking removes nothing.
  assert.ok((await textOf(await writeFolioPdf(t.content))).includes('quick brown'));
  assert.equal((await t.session.state(t.docId, 'redact.apply', {})).enabled, true);
  const tool = await t.exec('redact.mark', {});
  assert.equal(tool.result.tool, 'redact.mark');
  assert.equal(t.doc.view.tool, 'redact.mark');
});

test('Apply is destructive (it asks), cuts the marked text out of the content, keeps the rest, draws the box, and verifies', async () => {
  const t = await onePage();
  const page = t.content.pages[0];
  const text = await pageText(t.content, page);
  const at = text.plainText().indexOf('quick brown');
  await t.exec('redact.mark', {text: `/pg:${page.id}/chars:${at}-${at + 11}`});
  await expectApprovalRequired(t, 'redact.apply', {});
  const u = await expectUndoRoundTrip(t, 'redact.apply', {}, () => {});
  assert.equal(u.undoLabel, 'Apply redactions');
  // Run it for real (expectUndoRoundTrip leaves it applied after redo).
  assert.equal(marks(t).length, 0, 'the marks are gone');
  const report = u.result;
  assert.equal(report.verified, true);
  assert.ok(report.glyphs >= 9, `${report.glyphs}`);
  const bytes = await writeFolioPdf(t.content, {encrypt: true});
  const reread = await PDFDocument.load(bytes, {updateMetadata: false});
  const all = everything(reread);
  assert.ok(!all.includes('quick') && !all.includes('brown'), 'the text is not in the saved bytes (every stream decoded)');
  const raw = Buffer.from(bytes).toString('latin1');
  assert.ok(!raw.includes('quick brown'));
  const shown = await textOf(bytes);
  assert.ok(!shown.includes('quick') && shown.includes('lazy dog'), shown);
  assert.ok(shown.includes(LINES[0]), 'the other lines are there');
  // The page text the model reads now has no such word either.
  const after2 = await pageText(t.content, t.content.pages[0]);
  assert.ok(!after2.plainText().includes('quick'));
  assert.equal((await t.session.state(t.docId, 'redact.apply', {})).enabled, false, 'no marks left');
});

test('Apply removes the comments under a mark and keeps the others; the comment text is not in the saved file', async () => {
  const t = await open();
  const page = t.content.pages[0];
  await t.exec('comment.note', {page: page.id, at: [100, 100], text: 'private under the mark'});
  await t.exec('comment.note', {page: page.id, at: [400, 500], text: 'public note elsewhere'});
  const notes = () => t.content.pages[0].annots.filter(r => r.dict.Subtype === '/Text');
  assert.equal(notes().length, 2);
  await t.exec('redact.mark', {page: page.id, area: [80, 80, 80, 80]});
  const r = await t.exec('redact.apply', {});
  assert.equal(r.result.comments, 1);
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].dict.Contents.$t, 'public note elsewhere');
  const raw = Buffer.from(await writeFolioPdf(t.content, {encrypt: true})).toString('latin1');
  assert.ok(!raw.includes('private under the mark'), 'the comment text is not in the file');
});

test('Redact pages marks whole pages; Redaction properties give the marks a colour and overlay text (custom or codes) that Apply draws', async () => {
  const t = await open();
  const prefs = await t.exec('redact.properties', {useOverlay: true, useCode: true, codeSet: 'foia', codes: ['(b)(6)', '(b)(1)(A)'], fill: [0.1, 0.1, 0.1], align: 1, repeat: false});
  assert.equal(prefs.result.overlayText, '(b)(1)(A), (b)(6)');
  await assert.rejects(t.exec('redact.properties', {codes: ['(k)(1)']}), /not a code/);
  const r = await t.exec('redact.pages', {from: 1, to: 2});
  assert.equal(r.result.marked, 2);
  const m = marks(t);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].dict.IC.map(x => Math.round(x * 10)), [1, 1, 1]);
  assert.equal(m[0].dict.OverlayText.$t, '(b)(1)(A), (b)(6)');
  await assert.rejects(t.exec('redact.pages', {from: 5, to: 9}), /do not exist/);
  const cleared = await t.exec('redact.clear', {});
  assert.equal(cleared.result.cleared, 2);
  assert.equal(marks(t).length, 0);
  await t.exec('redact.pages', {});
  const applied = await t.exec('redact.apply', {});
  assert.equal(applied.result.pages, 1);
  const all = everything(await savedDoc(t));
  assert.equal((await textOf(await writeFolioPdf(t.content), 1)).replace(/[|\s]/g, ''), '(b)(1)(A),(b)(6)', 'page 1 shows nothing but the overlay text');
  assert.ok(all.includes(String.raw`\(b\)\(1\)\(A\), \(b\)\(6\)`), 'the overlay text is drawn in the box');
  assert.ok(await textOf(await writeFolioPdf(t.content), 2).then(x => x.includes('page 2')), 'page 2 is untouched');
});

test('Find text and redact marks every match: a phrase, a word list, and patterns (email, phone, card, SSN, date)', async () => {
  const t = await open();
  const one = await t.exec('redact.search', {text: 'the'});
  assert.ok(one.result.marked >= 2, `${one.result.marked}`);
  await t.exec('redact.clear', {});
  const words = await t.exec('redact.search', {mode: 'Multiple words or phrases', words: 'fox\nliquor jugs\nfox\n  '});
  assert.equal(words.result.marked, 4, 'fox and liquor jugs on both pages');
  await t.exec('redact.clear', {});
  assert.equal((await t.exec('redact.search', {text: '   '})).result.marked, 0);
  assert.equal((await t.exec('redact.search', {mode: 'Patterns', pattern: 'Email Addresses'})).result.marked, 0, 'no email in the text');
  const whole = await t.exec('redact.search', {text: 'qui', wholeWords: true});
  assert.equal(whole.result.marked, 0);
  const part = await t.exec('redact.search', {text: 'QUICK', caseSensitive: true});
  assert.equal(part.result.marked, 0);
  const folded = await t.exec('redact.search', {text: 'QUICK'});
  assert.equal(folded.result.marked, 2);
});

test('Remove hidden information and Sanitize take the categories out; they ask first', async () => {
  const t = await open();
  const scan = await t.exec('redact.hidden_scan', {});
  assert.equal(scan.result.found.length, 9);
  await expectApprovalRequired(t, 'redact.sanitize', {});
  await expectApprovalRequired(t, 'protect.remove_hidden', {items: ['metadata']});
  const done = await t.session.execute(t.docId, 'protect.remove_hidden', {items: ['metadata']}, {origin: 'test'});
  assert.ok(done.result.removed.metadata >= 1 || done.result.nothing);
});

test('Find text and redact with patterns marks the phone numbers, emails, card numbers, SSNs and dates of a page, and Apply removes them from the file', async () => {
  const {PDFDocument: PDF, StandardFonts} = await import('pdf-lib');
  const {schema1Content} = await import('../../core/folio/fixtures.mjs');
  const {migrateContent} = await import('../../core/folio/migrate.mjs');
  const doc = await PDF.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  [
    'Contact: ada.lovelace@example.org or call (555) 123-4567.',
    'Card 4111 1111 1111 1111, SSN 123-45-6789.',
    'Invoice dated March 5, 2024 for 99 widgets.',
  ].forEach((line, i) => page.drawText(line, {x: 50, y: 700 - i * 30, size: 12, font}));
  const t = await createTestSession('folio', {content: await migrateContent(await schema1Content(await doc.save(), 'pii.pdf'))});
  const counts = {};
  for (const pattern of ['Email Addresses', 'Phone Numbers', 'Credit Card Numbers', 'Social Security Numbers', 'Dates']) {
    counts[pattern] = (await t.exec('redact.search', {mode: 'Patterns', pattern})).result.marked;
  }
  assert.deepEqual(counts, {'Email Addresses': 1, 'Phone Numbers': 1, 'Credit Card Numbers': 1, 'Social Security Numbers': 1, Dates: 1});
  assert.equal(marks(t).length, 5);
  await t.exec('redact.apply', {});
  const bytes = await writeFolioPdf(t.content, {encrypt: true});
  const all = everything(await PDF.load(bytes, {updateMetadata: false}));
  for (const gone of ['example.org', '555', '4111', '6789', 'March', '2024']) assert.ok(!all.includes(gone), `${gone} is still in the file`);
  const shown = await textOf(bytes);
  assert.ok(shown.includes('Contact') && shown.includes('Invoice') && shown.includes('widgets'), shown);
});
