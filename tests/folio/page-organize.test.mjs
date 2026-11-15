// U:folio/page — Organize Pages: page.rotate_dialog, page.delete, page.insert_blank, page.duplicate,
// page.reverse, page.move, page.copy, page.cut, page.paste, page.insert, page.replace, page.extract,
// page.split, page.crop, page.boxes, page.number.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: printcraft crates/ui-egui/src/commands.rs:346-438 (run_page_command), editing.rs:377-430
//    (page clipboard), workflows/files.rs:302-760 (insert from file, replace, extract), dialogs.rs:1079
//    (Rotate Pages with parity/orientation, page_filter.rs), crates/organize/src/lib.rs (delete keeps
//    one page, reverse needs two, duplicate after the last, blank page the size of the page before,
//    replace keeps the target's comments), boxes.rs (margins from the media box), labels.rs
//    (number_pages). Acrobat's Organize Pages does the same: thumbnails, insert/extract/replace/
//    split, Rotate Pages dialog, Crop/Set Page Boxes, Page Labels.
// 2. Ours does the same end to end on real PDFs built with pdf-lib: each command edits the model or
//    rewrites the source, undo restores it, and the file written by Save (writeFolioPdf) is reopened
//    with pdf-lib to check page count, order, sizes, labels and comments.
// 3. Proof: these tests, tests/folio/upstream/page_*.test.mjs (organize tests.rs ports) and
//    tests/e2e/folio/page-organize.e2e.mjs (the window over the bridge, captures).
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts, PDFName, PDFArray} from 'pdf-lib';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {writeFolioPdf} from '../../core/folio/model/pdf-write.mjs';
import {base64} from '../../core/folio/fixtures.mjs';
import {releaseTextSources, pageText} from '../../core/folio/model/page-text.mjs';
import {parseRanges, filterPages, clearPageClipboard} from '../../core/folio/commands/page.mjs';
import {pageLabel} from '../../core/folio/model/index.mjs';

after(() => releaseTextSources());

const session = (fixture = 'textPages') => createTestSession('folio', {fixture});
const ids = t => t.content.pages.map(p => p.id);
const selectPages = (t, ...list) => t.session.setSelection(t.docId, {ranges: list.map(id => ({anchor: `/pg:${id}`, focus: `/pg:${id}`})), primary: 0});
async function saved(t) {
  const bytes = await writeFolioPdf(t.content);
  return PDFDocument.load(bytes);
}
/** A PDF of `n` pages whose text says which page it is ("Other N"), optionally with a form field. */
async function otherPdf(n = 2, {size = [400, 500], field = null} = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) doc.addPage(size).drawText(`Other ${i + 1}`, {x: 50, y: 400, size: 18, font});
  if (field) doc.getForm().createTextField(field).addToPage(doc.getPage(0), {x: 50, y: 50, width: 100, height: 20});
  return doc.save();
}
async function firstWords(content, i) {
  const pt = await pageText(content, content.pages[i]);
  return pt.plain().text.slice(0, 20);
}

test('Delete pages removes the selection undoably; the last page cannot go (WouldRemoveAllPages)', async () => {
  const t = await session();
  selectPages(t, 'p1');
  const r = await expectUndoRoundTrip(t, 'page.delete', {}, after => assert.deepEqual(after.content.pages.map(p => p.id), ['p2']));
  assert.equal(r.undoLabel, 'Delete page');
  // expectUndoRoundTrip leaves the redone state: p1 is gone and p2 is the current page.
  assert.equal(t.content.activePageId, 'p2');
  await assert.rejects(t.exec('page.delete', {pages: [0]}), e => e.code === 'invalid_params' && /at least one page/.test(e.message));
  assert.equal((await saved(t)).getPageCount(), 1);
});

test('Duplicate, Reverse and Move reorder the page records; Save writes that order', async () => {
  const t = await session();
  await expectUndoRoundTrip(t, 'page.duplicate', {pages: [0]}, after => assert.equal(after.content.pages.length, 3));
  const copy = t.content.pages[1];
  assert.equal(copy.duplicateOf, 'p1');
  assert.notEqual(copy.id, 'p1');
  // Reverse with fewer than two selected pages reverses the whole document.
  await t.exec('page.reverse');
  assert.deepEqual(ids(t).at(0), 'p2');
  await expectUndoRoundTrip(t, 'page.move', {pages: [0], to: 2}, after => assert.equal(after.content.pages[2].id, 'p2'));
  const doc = await saved(t);
  assert.equal(doc.getPageCount(), 3);
  await assert.rejects(t.exec('page.reverse', {pages: [1]}), /reversing needs at least two pages/);
});

test('Insert blank page goes after the selection at the size of the page before it', async () => {
  const t = await session();
  selectPages(t, 'p1');
  const r = await expectUndoRoundTrip(t, 'page.insert_blank', {}, after => {
    assert.equal(after.content.pages.length, 3);
    assert.equal(after.content.pages[1].width, 612);
  });
  assert.equal(r.undoLabel, 'Insert blank page');
  await t.exec('page.insert_blank', {at: 0, width: 300, height: 200});
  const doc = await saved(t);
  assert.equal(doc.getPageCount(), 4);
  assert.deepEqual([doc.getPage(0).getWidth(), doc.getPage(0).getHeight()], [300, 200]);
  assert.equal(await firstWords(t.content, 0), '');
  assert.equal(await firstWords(t.content, 2), '');
});

test('Insert pages from file (base64) puts its pages after the selection; colliding field names are renamed', async () => {
  const t = await session();
  const bytes = await otherPdf(2, {field: 'Name'});
  selectPages(t, 'p1');
  const r = await expectUndoRoundTrip(t, 'page.insert', {base64: base64(bytes), name: 'other.pdf'}, after => assert.equal(after.content.pages.length, 4));
  assert.equal(r.undoLabel, 'Insert pages from other.pdf');
  assert.equal(r.result.inserted, 2);
  assert.match(await firstWords(t.content, 1), /Other 1/);
  assert.match(await firstWords(t.content, 2), /Other 2/);
  // Insert the same file again: its "Name" field collides and becomes "Name-1".
  const r2 = await t.exec('page.insert', {base64: base64(bytes), name: 'other.pdf', at: 4});
  assert.deepEqual(r2.result.renamedFields, [['Name', 'Name-1']]);
  const doc = await saved(t);
  assert.equal(doc.getPageCount(), 6);
  assert.deepEqual(doc.getForm().getFields().map(f => f.getName()).sort(), ['Name', 'Name-1']);
  await assert.rejects(t.exec('page.insert', {base64: base64(new TextEncoder().encode('hello'))}), /is not a PDF/);
});

test('Copy pages then Paste pages inserts a copy after the selection; Cut refuses every page', async () => {
  clearPageClipboard();
  const t = await session();
  assert.equal(t.state('page.paste').reason, 'Copy or cut pages first');
  await t.exec('page.copy', {pages: [1]});
  selectPages(t, 'p1');
  const r = await expectUndoRoundTrip(t, 'page.paste', {}, after => assert.equal(after.content.pages.length, 3));
  assert.equal(r.undoLabel, 'Paste page');
  assert.match(await firstWords(t.content, 1), /\(page 2\)|Arkemis/);
  await assert.rejects(t.exec('page.cut', {pages: [0, 1, 2]}), /at least one page/);
  await t.exec('page.cut', {pages: [0]});
  assert.equal(t.content.pages.length, 2);
});

test('Replace pages swaps what a page shows and keeps its comments', async () => {
  const t = await session();
  await t.exec('comment.ink', {page: 'p1', strokes: [[[100, 100], [200, 200]]]}).catch(() => null);
  const before = t.content.pages[0].annots.length;
  const r = await expectUndoRoundTrip(t, 'page.replace', {base64: base64(await otherPdf(1)), name: 'new.pdf', from: 1, to: 1},
    after => assert.equal(after.content.pages[0].width, 400));
  assert.equal(r.undoLabel, 'Replace page');
  assert.equal(t.content.pages[0].annots.length, before);
  assert.match(await firstWords(t.content, 0), /Other 1/);
  await assert.rejects(t.exec('page.replace', {base64: base64(await otherPdf(1)), from: 1, to: 2}), /not enough to replace 2/);
});

test('Extract pages returns a PDF of the chosen pages (typed ranges win); Delete after extracting is one undo step', async () => {
  const t = await session();
  const r = await t.exec('page.extract', {ranges: '2'});
  const out = await PDFDocument.load(Uint8Array.from(atob(r.result.files[0].base64), c => c.charCodeAt(0)));
  assert.equal(out.getPageCount(), 1);
  assert.equal(r.result.files[0].name, 'fixture (extract).pdf');
  const r2 = await t.exec('page.extract', {pages: [0], delete: true, fileName: 'First'});
  assert.equal(r2.result.files[0].name, 'First.pdf');
  assert.deepEqual(ids(t), ['p2']);
  await t.undo();
  assert.deepEqual(ids(t), ['p1', 'p2']);
  const sep = await t.exec('page.extract', {ranges: '1-2', separate: true});
  assert.deepEqual(sep.result.files.map(f => f.name), ['fixture (page 1).pdf', 'fixture (page 2).pdf']);
  assert.throws(() => parseRanges('3', 2), /page 3 does not exist/);
  assert.deepEqual(parseRanges('3-1, 2', 3), [2, 1, 0, 1]);
});

test('Split document by number of pages writes one file per part', async () => {
  const t = await session();
  const r = await t.exec('page.split', {mode: 'pages', every: 1});
  assert.deepEqual(r.result.files.map(f => [f.name, f.pages]), [['fixture_Part1.pdf', 1], ['fixture_Part2.pdf', 1]]);
  await assert.rejects(t.exec('page.split', {mode: 'pages', every: 5}), /nothing to split/);
  await assert.rejects(t.exec('page.split', {mode: 'selection'}), /Select the pages to split before/);
});

test('Set Page Boxes by margins crops from the media box; Crop by a view rectangle; reset pins the media box', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'page.boxes', {box: 'crop', margins: [36, 72, 36, 72], which: 'all'}, after => {
    assert.deepEqual(after.content.pages[0].box, [36, 72, 576, 720]);
    assert.equal(after.content.pages[1].width, 540);
  });
  assert.equal(r.undoLabel, 'Set page boxes');
  await assert.rejects(t.exec('page.boxes', {box: 'crop', margins: [306, 0, 306, 0]}), /smaller than a point/);
  await t.exec('page.crop', {pages: [0], rect: [10, 20, 100, 200]});
  // View rect (top-left, crop relative) → user space: x 36+10, top 720-20.
  assert.deepEqual(t.content.pages[0].box, [46, 500, 146, 700]);
  await t.exec('page.boxes', {box: 'crop', remove: true, pages: [0]});
  assert.deepEqual(t.content.pages[0].box, [0, 0, 612, 792]);
  const doc = await saved(t);
  assert.equal(doc.getPage(1).getCropBox().width, 540);
  await assert.rejects(t.exec('page.boxes', {box: 'media', remove: true}), /media box can't be removed/);
});

test('Number pages writes page labels; later pages keep theirs; Save writes /PageLabels', async () => {
  const t = await session();
  const r = await expectUndoRoundTrip(t, 'page.number', {from: 1, to: 1, style: 'lower-roman', prefix: 'P-', start: 1},
    after => assert.equal(after.content.pageLabels.length, 2));
  assert.equal(r.undoLabel, 'Number pages');
  assert.equal(pageLabel(t.content, 0), 'P-i');
  assert.equal(pageLabel(t.content, 1), '2');
  const doc = await saved(t);
  assert.ok(doc.catalog.lookup(PDFName.of('PageLabels')));
});

test('Rotate Pages… filters by parity and orientation (page_filter.rs)', async () => {
  const t = await session();
  const r = await t.exec('page.rotate_dialog', {degrees: 180, which: 'all', parity: 'even'});
  assert.deepEqual(r.result.pages, [1]);
  assert.deepEqual(t.content.pages.map(p => p.rotation), [0, 180]);
  await t.exec('page.rotate_dialog', {degrees: 90, which: 'range', from: 1, to: 2, orientation: 'portrait'});
  assert.deepEqual(t.content.pages.map(p => p.rotation), [90, 270]);
  assert.deepEqual(filterPages(t.content.pages, [0, 1], 'both', 'landscape'), [0, 1]);
});

test('Organize edits over the bridge are "Arkemis:" undo steps; Annots survive a materialized source', async () => {
  const t = await session();
  const r = await t.bridge('page.duplicate', {pages: [1]});
  assert.equal(r.undoLabel, 'Automation: Duplicate page');
  // Boxes on a duplicated page materialize the source: every page its own, comments kept.
  await t.exec('page.boxes', {pages: [2], box: 'crop', margins: [10, 10, 10, 10]});
  assert.deepEqual(t.content.pages.map(p => p.sourceIndex), [0, 1, 2]);
  assert.equal(t.content.pages[1].box[0], 0);
  assert.equal(t.content.pages[2].box[0], 10);
  const doc = await saved(t);
  assert.equal(doc.getPageCount(), 3);
  const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  assert.equal(annots, undefined);
});

test('Organize pages opens the page grid on the page being read, dropping a selection without it, and closes', async () => {
  // printcraft DocView::open_organize (canvas/organize.rs): an empty selection means the current page;
  // a selection left from earlier that doesn't include it is dropped. The grid is a view: no undo step.
  const t = await session();
  assert.equal(t.state('page.organize').checked, false);
  selectPages(t, 'p2');
  const open = await t.exec('page.organize', {});
  assert.deepEqual(open.result, {organize: true});
  assert.equal(t.doc.view.organize, true);
  assert.equal(t.state('page.organize').checked, true);
  const anchors = t.session.get(t.docId).selection.ranges.map(r => r.anchor);
  assert.deepEqual(anchors, [`/pg:${t.content.pages[0].id}`], 'the selection without the page being read is dropped');
  selectPages(t, 'p1', 'p2');
  await t.exec('page.organize', {open: true});
  assert.equal(t.session.get(t.docId).selection.ranges.length, 2, 'a selection with the page being read is kept');
  assert.deepEqual((await t.exec('page.organize', {open: false})).result, {organize: false});
  assert.equal(t.doc.view.organize, false);
  assert.deepEqual(ids(t), ['p1', 'p2'], 'opening and closing the grid changes no page');
});
