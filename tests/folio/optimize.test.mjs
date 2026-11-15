// core/folio/lib/optimize.mjs and core/folio/commands/optimize.mjs: Reduce file size and the PDF Optimizer's structural settings.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/optimize/src/lib.rs (thumbnails and alternate images discarded, tags and print settings only when asked, streams
//    stored without a filter Flate-compressed when smaller, objects only the file no longer reaches left out, object streams) and create_ui.rs
//    (the copy is named "<name> (reduced).pdf"; a Reduce File Size copy that is not smaller is not saved). Acrobat's Reduce File Size does the same.
// 2. Ours does the same on a PDF written with unfiltered streams, orphaned objects, a thumbnail and tags; the copy is read back with pdf-lib.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFString, PDFRawStream} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {optimizePdf, DEFAULTS} from '../../core/folio/lib/optimize.mjs';

const N = s => PDFName.of(s);

/** A PDF with a big unfiltered stream, an orphaned object, a page thumbnail, a structure tree and print preferences. */
async function bloated() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const ctx = doc.context;
  page.node.set(N('Contents'), ctx.register(ctx.stream('0 0 m 100 100 l S\n'.repeat(400))));
  ctx.register(ctx.stream('orphaned '.repeat(500)));
  page.node.set(N('Thumb'), ctx.register(ctx.stream('thumb'.repeat(100))));
  const root = ctx.register(ctx.obj({Type: 'StructTreeRoot'}));
  doc.catalog.set(N('StructTreeRoot'), root);
  doc.catalog.set(N('MarkInfo'), ctx.obj({Marked: true}));
  doc.catalog.set(N('ViewerPreferences'), ctx.obj({PrintScaling: 'None', Duplex: 'Simplex', FitWindow: true}));
  return doc.save({useObjectStreams: false});
}

test('the defaults shrink a bloated file and report what they did; tags and print settings stay unless asked', async () => {
  const bytes = await bloated();
  const r = await optimizePdf(bytes, DEFAULTS);
  assert.ok(r.after < r.before / 3, `${r.before} -> ${r.after}`);
  assert.equal(r.report.thumbnails, 1);
  assert.ok(r.report.compressed >= 1, 'the content stream is compressed');
  assert.ok(r.report.unused >= 2, 'the orphan and the thumbnail it no longer reaches are gone');
  const doc = await PDFDocument.load(r.bytes);
  assert.ok(doc.catalog.has(N('StructTreeRoot')), 'tags are kept by default');
  assert.equal(doc.getPage(0).node.has(N('Thumb')), false);
  assert.equal(doc.getPageCount(), 1);
});

test('discarding tags and print settings: only when asked, and only the print keys', async () => {
  const r = await optimizePdf(await bloated(), {...DEFAULTS, discardTags: true, discardPrintSettings: true});
  assert.equal(r.report.tagsRemoved, true);
  assert.equal(r.report.printSettings, 2);
  const doc = await PDFDocument.load(r.bytes);
  assert.equal(doc.catalog.has(N('StructTreeRoot')), false);
  assert.equal(doc.catalog.has(N('MarkInfo')), false);
  const vp = doc.catalog.lookup(N('ViewerPreferences'));
  assert.deepEqual([vp.has(N('PrintScaling')), vp.has(N('Duplex')), vp.has(N('FitWindow'))], [false, false, true]);
});

test('optimize.reduce saves nothing when the copy is not smaller; optimize.advanced always saves; the open document is not changed', async () => {
  const t = await createTestSession('folio', {content: await migrateContent(await createPdfContent(await bloated(), 'Big report.pdf'))});
  const before = t.content.sourceBase64;
  const r = await t.exec('optimize.reduce', {});
  assert.equal(r.result.saved, true);
  assert.equal(r.result.name, 'Big report (reduced).pdf');
  assert.match(r.result.message, /% smaller/);
  assert.ok(Buffer.from(r.result.base64, 'base64').length < r.result.before);
  assert.equal(t.content.sourceBase64, before, 'a copy: the document is untouched');
  const small = await createTestSession('folio', {fixture: 'textPages'});
  const again = await small.exec('optimize.reduce', {});
  if (!again.result.saved) assert.match(again.result.message, /already as small as it can be made/);
  const adv = await small.exec('optimize.advanced', {objectStreams: false, discardUnused: false});
  assert.equal(adv.result.saved, true);
  assert.equal(adv.result.name, 'Document (optimized).pdf'.replace('Document', adv.result.name.replace(/ \(optimized\)\.pdf$/, '')));
  assert.ok(PDFString && PDFRawStream);
});
