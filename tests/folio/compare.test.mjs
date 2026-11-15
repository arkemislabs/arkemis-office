// core/folio/lib/compare.mjs and core/folio/commands/compare.mjs: Compare files (the word diff, the Compare panel's results,
// Mark as comments, the report, Clear).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/compare/src/lib.rs and tests, crates/engine/src/compare.rs, crates/ui-egui/src/workflows/
//    compare_ui.rs): both documents' words (in reading order, with page and box) are diffed with Myers' algorithm after the common
//    prefix and suffix; the result is inserted, deleted or replaced runs of words with one rectangle per line to shade on the new
//    file (blue replaced, green inserted, red deleted); Mark as comments adds a highlight over replaced and inserted text and a note
//    where text was deleted, authored "Compare", as one undoable step "Mark differences"; the report lists the counts and each change;
//    both files must allow copying their text; Clear takes the shading and the panel away. Acrobat's Compare Files does the same
//    (an old and a new file, a list of differences shown on the new file, a report).
// 2. Ours does the same on real PDFs: the older version is a file (docs/spec/patches/folio/compare.json says why), its text is read
//    with the same extraction as the page view, the differences are saved as real annotations.
// 3. Proved here and in tests/e2e/folio/compare.e2e.mjs (the window).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, PDFArray, StandardFonts, rgb} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content, base64} from '../../core/folio/fixtures.mjs';
import {releaseTextSources, pageText} from '../../core/folio/model/page-text.mjs';
import * as C from '../../core/folio/lib/compare.mjs';

after(() => releaseTextSources());

/** A PDF whose pages hold the given lines of text (Helvetica 12 pt, 18 pt leading from the top). */
async function pdfOf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, i) => page.drawText(line, {x: 72, y: 720 - i * 18, size: 12, font, color: rgb(0, 0, 0)}));
  }
  return doc.save();
}
async function open(pages, extra = {}) {
  const content = await migrateContent(await schema1Content(await pdfOf(pages), 'new.pdf'));
  return createTestSession('folio', {content: {...content, ...extra}});
}
const words = (text, page = 0) => text.split(/\s+/).filter(Boolean).map((t, i) => ({text: t, page, rect: [10 + 40 * i, 700, 45 + 40 * i, 710]}));
const OLD = 'The quick brown fox jumps over the lazy dog';
const NEW = 'The quick red fox leaps over the very lazy dog today';

// ── crates/compare/src/lib.rs tests ──────────────────────────────────────────────────────────

test('identical text has no changes', () => {
  assert.ok(C.identical(C.compare(words('the same words here'), words('the same words here'))));
});

test('insertions, deletions and replacements are found and grouped into runs', () => {
  const c = C.compare(words(OLD), words(NEW));
  assert.deepEqual(c.changes.map(x => [x.kind, x.old.text, x.new.text]), [['Replaced', 'brown', 'red'], ['Replaced', 'jumps', 'leaps'], ['Inserted', '', 'very'], ['Inserted', '', 'today']]);
  assert.deepEqual(c.changes[0].new.rects, [[90, 700, 125, 710]]);
  assert.equal(C.count(c, 'Inserted'), 2);
  assert.deepEqual([c.oldWords, c.newWords], [9, 11]);
});

test('deletions across pages keep their pages; the report says what changed', () => {
  const old = [...words('alpha beta gamma', 0), ...words('delta epsilon', 1)];
  const next = [...words('alpha gamma', 0), ...words('delta', 1)];
  const c = C.compare(old, next);
  assert.deepEqual(c.changes.map(x => [x.kind, x.old.page, x.old.text]), [['Deleted', 0, 'beta'], ['Deleted', 1, 'epsilon']]);
  assert.equal(c.changes[1].new.page, 1, 'the place of the deletion in the new file: the page of the words around it');
  const r = C.report(c, 'v1.pdf', 'v2.pdf');
  assert.match(r, /2 changes: 0 replaced, 0 inserted, 2 deleted\./);
  assert.match(r, /Old: epsilon/);
  assert.match(r, /^Compare Report\n\nOld file: v1\.pdf\nNew file: v2\.pdf/);
  assert.match(C.report(C.compare(words('a'), words('a')), 'a', 'b'), /identical/);
});

test('adjacent words merge into one rectangle per line', () => {
  const c = C.compare(words('a b c'), words('x y z'));
  assert.equal(c.changes.length, 1);
  assert.equal(c.changes[0].new.rects.length, 1);
});

test('a long document with scattered edits finds exactly those; two unrelated long documents finish as one replacement', () => {
  const old = Array.from({length: 20_000}, (_, i) => ({text: `w${i}`, page: 0, rect: [0, 0, 0, 0]}));
  const next = old.map(w => ({...w}));
  for (const k of [100, 5000, 12_000, 19_000]) next[k].text = `changed${k}`;
  next.splice(8000, 1);
  const c = C.compare(old, next);
  assert.equal(c.changes.length, 5, JSON.stringify(c.changes.map(x => [x.kind, x.old.text, x.new.text])));
  assert.equal(C.count(c, 'Replaced'), 4);
  const a = Array.from({length: 30_000}, (_, i) => ({text: `a${i}`, page: 0, rect: [0, 0, 0, 0]}));
  const b = Array.from({length: 30_000}, (_, i) => ({text: `b${i}`, page: 0, rect: [0, 0, 0, 0]}));
  const d = C.compare(a, b);
  assert.deepEqual([d.changes.length, d.changes[0].kind], [1, 'Replaced']);
});

test('the colours are Acrobat\'s: replaced blue, inserted green, deleted red', () => {
  assert.deepEqual([C.colour('Replaced'), C.colour('Inserted'), C.colour('Deleted')], [[0.2, 0.45, 0.95], [0.2, 0.75, 0.3], [0.9, 0.25, 0.25]]);
});

test('words come from the page text in reading order with their boxes', async () => {
  const content = await migrateContent(await schema1Content(await pdfOf([[OLD, 'second line here']]), 'w.pdf'));
  const text = await pageText(content, content.pages[0]);
  const w = C.wordsOf([text]);
  assert.deepEqual(w.map(x => x.text), [...OLD.split(' '), 'second', 'line', 'here']);
  assert.ok(w[0].rect[0] < w[1].rect[0] && w[0].rect[1] === w[1].rect[1], 'left to right on a line');
  assert.ok(w.at(-1).rect[1] > w[0].rect[1], 'the second line is lower (view space is y down)');
});

// ── the commands ───────────────────────────────────────────────────────────────────────────

const compareWith = async (t, lines) => t.exec('doc.compare', {base64: base64(await pdfOf(lines)), name: 'old.pdf'});

test('Compare files reads the older version, diffs the words and keeps the result for the panel', async () => {
  const t = await open([[NEW]]);
  const r = (await compareWith(t, [[OLD]])).result;
  assert.deepEqual([r.changes, r.replaced, r.inserted, r.deleted, r.identical, r.message], [4, 2, 2, 0, false, '4 differences found']);
  const c = t.doc.view.compare;
  assert.deepEqual([c.oldName, c.newName, c.showText, c.selected], ['old.pdf', 'new.pdf', true, null]);
  assert.equal(c.changes[0].new.page, 0);
  assert.ok(c.changes[0].new.rects[0][2] > c.changes[0].new.rects[0][0], 'a box to shade on the new file');
  const same = (await compareWith(t, [[NEW]])).result;
  assert.deepEqual([same.identical, same.message], [true, 'The text is the same']);
  const one = (await compareWith(t, [['The quick red fox leaps over the very lazy dog']])).result;
  assert.equal(one.message, '1 difference found');
  await assert.rejects(() => t.exec('doc.compare', {}), /path or base64/);
  await assert.rejects(() => t.exec('doc.compare', {base64: base64(new TextEncoder().encode('not a pdf')), name: 'x.pdf'}), /not a PDF/);
});

test('both files must allow copying their text', async () => {
  const t = await open([[NEW]], {permissions: {copy: false}});
  assert.equal(t.state('doc.compare').enabled, false);
  assert.match(t.state('doc.compare').reason, /copying/);
  await assert.rejects(() => compareWith(t, [[OLD]]), /copying/);
});

test('the panel picks a difference (its page and box), shows or hides the text differences, and clears', async () => {
  const t = await open([['one two three'], ['four five six']]);
  assert.equal(t.state('compare.clear').enabled, false, 'nothing is compared yet');
  await compareWith(t, [['one two three'], ['four 5 six']]);
  const pick = (await t.exec('compare.select', {index: 1})).result;
  assert.deepEqual([pick.kind, pick.page, pick.oldPage], ['Replaced', 2, 2]);
  assert.equal(t.doc.view.compare.selected, 0);
  assert.equal(t.doc.view.compare.rev, 1, 'each pick is a revision the page view follows');
  await assert.rejects(() => t.exec('compare.select', {index: 5}), /no difference/);
  assert.equal(t.state('compare.show', {what: 'text'}).checked, true);
  assert.equal(t.state('compare.show', {}).value, 'Text', 'Show: names what is shown');
  await t.exec('compare.show', {what: 'text'});
  assert.equal(t.doc.view.compare.showText, false);
  assert.equal(t.state('compare.show', {what: 'text'}).checked, false);
  assert.equal(t.state('compare.show', {}).value, 'Nothing');
  await t.exec('compare.show', {value: true});
  assert.equal(t.doc.view.compare.showText, true);
  await t.exec('compare.clear', {});
  assert.equal(t.doc.view.compare, null);
  assert.equal(t.state('compare.mark').enabled, false);
});

test('Mark as comments adds a highlight over replaced and inserted text and a note where text was deleted, one undoable step', async () => {
  const t = await open([['alpha gamma delta beta']]);
  await compareWith(t, [['alpha beta gamma delta']]);
  // beta moved: deleted after alpha, inserted at the end.
  const kinds = t.doc.view.compare.changes.map(c => c.kind);
  assert.deepEqual(kinds, ['Deleted', 'Inserted']);
  const r = await expectUndoRoundTrip(t, 'compare.mark', {}, after => assert.equal(after.content.pages[0].annots.length, 2));
  assert.equal(r.undoLabel, 'Mark differences');
  assert.deepEqual([r.result.added, r.result.message], [2, 'Added 2 comments']);
  const annots = t.content.pages[0].annots;
  assert.deepEqual(annots.map(a => a.dict.Subtype), ['/Text', '/Highlight']);
  assert.equal(annots[0].dict.Contents.$t, 'Deleted: "beta"');
  assert.equal(annots[1].dict.Contents.$t, 'Inserted: "beta"');
  assert.deepEqual([annots[0].dict.T.$t, annots[1].dict.T.$t], ['Compare', 'Compare']);
  assert.deepEqual(annots[1].dict.C, C.colour('Inserted'));
  assert.deepEqual(annots[0].dict.C, C.colour('Deleted'));
  // Real annotations: saved and reopened.
  const bytes = await writeFolioPdf(t.content);
  const doc = await PDFDocument.load(bytes);
  const arr = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  const subtypes = arr.asArray().map(e => doc.context.lookup(e).lookup(PDFName.of('Subtype')).decodeText());
  assert.deepEqual(subtypes.sort(), ['Highlight', 'Popup', 'Text'], 'the note carries its pop-up');
});

test('Mark as comments needs a replaced text to shade: a replaced run is highlighted over the new words', async () => {
  const t = await open([['The quick red fox']]);
  await compareWith(t, [['The quick brown fox']]);
  const r = (await t.exec('compare.mark', {})).result;
  assert.equal(r.added, 1);
  const a = t.content.pages[0].annots[0];
  assert.equal(a.dict.Subtype, '/Highlight');
  assert.equal(a.dict.Contents.$t, 'Replaced: "brown" with "red"');
  assert.equal(a.dict.QuadPoints.length, 8);
  const rect = t.doc.view.compare.changes[0].new.rects[0];
  const xs = a.dict.QuadPoints.filter((_, i) => i % 2 === 0);
  assert.ok(Math.min(...xs) <= rect[0] + 0.01 && Math.max(...xs) >= rect[2] - 0.01, 'the highlight covers the new word');
});

test('the report is a PDF with the counts and each change; from a program it comes back as base64', async () => {
  const t = await open([[NEW]]);
  await compareWith(t, [[OLD]]);
  const r = (await t.exec('compare.report', {})).result;
  assert.equal(r.changes, 4);
  assert.match(r.text, /4 changes: 2 replaced, 2 inserted, 0 deleted\./);
  assert.match(r.text, /Old file: old\.pdf\nNew file: new\.pdf/);
  assert.match(r.text, /1\. Replaced \(old page 1, new page 1\)\n {3}Old: brown\n {3}New: red/);
  assert.equal(typeof r.base64, 'string');
  const out = await PDFDocument.load(Buffer.from(r.base64, 'base64'));
  assert.ok(out.getPageCount() >= 1);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({data: new Uint8Array(Buffer.from(r.base64, 'base64')), verbosity: 0});
  const d = await task.promise;
  const page = await d.getPage(1);
  const text = (await page.getTextContent()).items.map(i => i.str).join(' ');
  await task.destroy();
  assert.match(text, /Compare Report/);
  assert.match(text, /brown/);
});
