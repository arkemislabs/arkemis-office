// U:folio/ocr — Scan & OCR ▸ Recognize text: ocr.recognize, dialog.recognize-text.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: printcraft crates/engine/src/ocr.rs (OcrJob::run: pages that already contain text are
//    skipped unless "Also recognize pages that already have text"; words the page already has are
//    not added again; apply_ocr is one undo step "Recognize text"), crates/ocr/src/lib.rs text_layer
//    (invisible Helvetica text fitted to each word box), workflows/ocr_ui.rs (the dialog). Acrobat:
//    Scan & OCR ▸ Recognize Text ▸ In This File, Searchable Image output.
// 2. Ours: the host's OCR worker reads the page (Tesseract); the same text layer is stamped on the
//    page in the PDF source, so search, selection and the saved file find the words.
// 3. Proof: these tests (a scripted recogniser stands in for the worker), tests/folio/upstream/
//    ocr_lib.test.mjs (crates/ocr tests), tests/e2e/folio/ocr-export.e2e.mjs (the real worker).
// Also ports crates/ocr/src/lib.rs tests: places_words_through_the_mapping,
// the_model_alphabet_fits_the_text_layer_font, text_layer_is_invisible_text_fitted_to_each_box,
// the_layer_restores_the_graphics_state_it_changes.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content} from '../../core/folio/fixtures.mjs';
import {releaseTextSources, pageText} from '../../core/folio/model/page-text.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {placeWord, textLayer, num} from '../../core/folio/lib/ocr-layer.mjs';
import {textWidth, firstUndrawable} from '../../core/folio/lib/fonts.mjs';
import dialog from '../../core/folio/dialogs/recognize-text.mjs';

after(() => releaseTextSources());

/** A "scan": a page with no text (a grey box stands in for the picture). */
async function scan(pages = 2) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawRectangle({x: 72, y: 600, width: 300, height: 60});
  return migrateContent(await schema1Content(await doc.save(), 'scan.pdf'));
}
const words = [{text: 'Invoice', x: 72, y: 132, width: 120, height: 24}, {text: 'paid', x: 200, y: 132, width: 60, height: 24}];

test('Recognize text adds an invisible, searchable layer over the words; one undo step; Save keeps it', async () => {
  const calls = [];
  const host = createTestHost({ocrWords: async (content, pageId, opts) => { calls.push([pageId, opts.dpi]); return {words}; }});
  const t = await createTestSession('folio', {content: await scan(), host});
  const r = await expectUndoRoundTrip(t, 'ocr.recognize', {pages: [0]});
  assert.equal(r.undoLabel, 'Recognize text');
  assert.equal(r.result.words, 2);
  assert.equal(r.result.message, 'Recognized 2 words on 1 page');
  assert.deepEqual(calls.at(-1), [t.content.pages[0].id, 300]);
  const pt = await pageText(t.content, t.content.pages[0]);
  assert.match(pt.plain().text, /Invoice\s+paid/);
  const hit = pt.find('paid')[0];
  assert.ok(hit, 'search finds the recognised word');
  const saved = await migrateContent(await schema1Content(await writeFolioPdf(t.content)));
  assert.match((await pageText(saved, saved.pages[0])).plain().text, /Invoice/);
  // The page now has text: running again skips it unless forced.
  const again = await t.exec('ocr.recognize', {pages: [0]});
  assert.deepEqual(again.result.skipped, [0]);
  assert.equal(again.result.message, 'Every page already contains text');
  // Forced, the words already on the page are not added a second time.
  const forced = await t.exec('ocr.recognize', {pages: [0], force: true});
  assert.equal(forced.result.words, 0);
});

test('without a recognition engine the command says so; the dialog maps its choices', async () => {
  const t = await createTestSession('folio', {content: await scan()});
  assert.equal(t.state('ocr.recognize').reason, 'the text recognition engine is not available here');
  const ctx = t.session.readContext(t.docId);
  const v = dialog.init(ctx);
  assert.deepEqual([v.pages, v.downsample, v.force], ['All pages', '300 dpi', false]);
  assert.deepEqual(dialog.toCommand({...v, pages: 'From', from: 2, to: 2, downsample: '150 dpi', force: true}).params, {pages: [1], language: 'en', dpi: 150, force: true});
  assert.deepEqual(dialog.validate({...v, pages: 'From', from: 3, to: 3}).map(p => p.field), ['from']);
});

test('ocr lib.rs places_words_through_the_mapping', () => {
  const toUser = (x, y) => [x / 2, 792 - y / 2];
  const w = placeWord('Hello', [100, 200, 300, 240], toUser);
  assert.deepEqual(w.origin, [50, 672]);
  assert.deepEqual(w.across, [100, 0]);
  assert.deepEqual(w.up, [0, 20]);
});

test('ocr lib.rs the_model_alphabet_fits_the_text_layer_font', () => {
  assert.equal(firstUndrawable(" 0123456789!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~€ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), null);
});

test('ocr lib.rs text_layer_is_invisible_text_fitted_to_each_box', () => {
  const s = textLayer([{text: 'Hi', origin: [10, 20], across: [30, 0], up: [0, 9.3]}]);
  assert.ok(s.includes('3 Tr') && s.includes('/PCHelv 1 Tf'), s);
  const width = textWidth('Hi', 1);
  assert.ok(s.includes(`${num(30 / width)} 0 0 ${num(9.3 / 0.718)} 10 20 Tm (Hi) Tj`), s);
  assert.ok(s.startsWith('/OCR BMC') && s.endsWith('EMC\n'));
});

test('ocr lib.rs the_layer_restores_the_graphics_state_it_changes', () => {
  const s = textLayer([{text: 'Hi', origin: [10, 20], across: [30, 0], up: [0, 9.3]}]);
  let depth = 0;
  for (const token of s.split(/\s+/)) {
    if (token === 'q') depth++;
    else if (token === 'Q') depth--;
    else if (['Tr', 'Tf', 'Tm'].includes(token)) assert.ok(depth > 0, token);
    assert.ok(depth >= 0);
  }
  assert.equal(depth, 0);
});
