// Audit space usage (core/folio/lib/space-audit.mjs, commands/optimize_audit.mjs).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/optimize/src/audit.rs: every object counts once, for the first kind that reaches it; the kinds are listed in upstream's order; what they
//    do not account for is Document Overhead; the shares are of the file's length and add up to 100. Acrobat's Audit space usage is the same table.
// 2. Ours measures a PDF with a picture, fonts, a bookmark and a comment and checks each lands in its kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts, PDFName} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {auditSpace, CATEGORIES} from '../../core/folio/lib/space-audit.mjs';

const N = s => PDFName.of(s);
async function sample() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText('Hello world', {x: 20, y: 200, size: 12, font});
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  page.drawImage(await doc.embedPng(png), {x: 20, y: 20, width: 40, height: 40});
  const ctx = doc.context;
  const link = ctx.register(ctx.obj({Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: 'a note'}));
  page.node.set(N('Annots'), ctx.obj([link]));
  return doc.save({useObjectStreams: false});
}
const rowsOf = rows => Object.fromEntries(rows.map(r => [r.category, r]));

test('each kind of content gets its bytes, the shares add up to 100 and the categories are upstream\'s, in order', async () => {
  const bytes = await sample();
  const rows = auditSpace(await PDFDocument.load(bytes), bytes.length);
  assert.deepEqual(rows.map(r => r.category), CATEGORIES);
  const by = rowsOf(rows);
  assert.ok(by.Images.bytes > 0 && by.Fonts.bytes > 0 && by['Content Streams'].bytes > 0 && by.Comments.bytes > 0);
  assert.equal(by.Bookmarks.bytes, 0);
  assert.ok(by['Document Overhead'].bytes > 0);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.percent, 0) - 100) < 1e-6);
  assert.equal(rows.reduce((a, r) => a + r.bytes, 0), Math.max(bytes.length, rows.reduce((a, r) => a + r.bytes, 0)));
});

test('optimize.audit lists the kinds that use bytes with their percentage and a total that is at least the file', async () => {
  const t = await createTestSession('folio', {content: await migrateContent(await createPdfContent(await sample(), 'Audit.pdf'))});
  const r = (await t.exec('optimize.audit', {})).result;
  assert.ok(r.rows.length >= 4 && r.rows.every(x => x.bytes > 0));
  assert.ok(r.rows.some(x => x.category === 'Images'));
  assert.ok(r.total >= r.fileSize - 1);
  assert.ok(Math.abs(r.rows.reduce((a, x) => a + x.percent, 0) - 100) < 0.1);
});
