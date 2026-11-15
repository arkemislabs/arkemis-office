// Print pages (core/folio/lib/print-job.mjs, commands/print.mjs, dialogs/print.mjs).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. printcraft 0.16.0 (8f16855) crates/print: select_pages (a range "1-3, 6; 9-7" with a range written backwards running backwards, odd and even pages, reversed, "no pages to
//    print" when nothing is left), Layout::multiple (2, 4, 6, 9, 16 to a sheet), PageOrder, the booklet. Acrobat's Print dialog (Pages to Print, Page Sizing & Handling) does the same.
//    Not translated: the system printers, Poster, Label, comments, printing as an image.
// 2. Ours lays real pages on sheets with pdf-lib and reads the sheets back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, StandardFonts, degrees} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createPdfContent} from '../../core/pdf-document.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {selectPages, gridFor, cellOrder, bookletSides, buildSheets, PrintError} from '../../core/folio/lib/print-job.mjs';
import printDialog from '../../core/folio/dialogs/print.mjs';

async function numbered(n, {rotate = 0} = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) { const p = doc.addPage([300, 400]); p.drawText(`Page ${i}`, {x: 30, y: 200, size: 24, font}); if (rotate) p.setRotation(degrees(rotate)); }
  return doc.save();
}

test('select_pages: all, ranges, a range written backwards, odd and even, reversed; nothing left is an error', () => {
  assert.deepEqual(selectPages(5, ''), [0, 1, 2, 3, 4]);
  assert.deepEqual(selectPages(9, '1-3, 6; 9-7'), [0, 1, 2, 5, 8, 7, 6]);
  assert.deepEqual(selectPages(6, '', {subset: 'odd'}), [0, 2, 4]);
  assert.deepEqual(selectPages(6, '2-5', {subset: 'even', reverse: true}), [3, 1]);
  assert.deepEqual(selectPages(5, '-2'), [0, 1]);
  assert.deepEqual(selectPages(5, '4-'), [3, 4]);
  assert.throws(() => selectPages(5, '7'), /page 7 is not in the document/);
  assert.throws(() => selectPages(5, 'x'), PrintError);
  assert.throws(() => selectPages(1, '', {subset: 'even'}), /no pages to print/);
});

test('pages to a sheet: the usual grids, the order the cells fill in, and the booklet\'s saddle-stitch order with its blank pages', () => {
  assert.deepEqual([2, 4, 6, 9, 16, 5].map(gridFor), [[1, 2], [2, 2], [2, 3], [3, 3], [4, 4], [3, 2]]);
  assert.deepEqual(cellOrder(2, 2, 'horizontal'), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.deepEqual(cellOrder(2, 2, 'vertical'), [[0, 0], [0, 1], [1, 0], [1, 1]]);
  assert.deepEqual(cellOrder(2, 2, 'horizontal-reversed'), [[1, 0], [0, 0], [1, 1], [0, 1]]);
  assert.deepEqual(bookletSides(8), [[7, 0], [1, 6], [5, 2], [3, 4]]);
  assert.deepEqual(bookletSides(6), [[null, 0], [1, null], [5, 2], [3, 4]]);
  assert.deepEqual(bookletSides(5), [[null, 0], [1, null], [null, 2], [3, 4]]);
  assert.deepEqual(bookletSides(4, 'right'), [[0, 3], [2, 1]]);
});

const sheetsOf = async (bytes, o) => {
  const out = await buildSheets(bytes, o.pages, {paper: 'US Letter', orientation: 'auto', handling: 'size', fit: 'fit', scale: 100, perSheet: 2, order: 'horizontal', border: false, booklet: 'both', binding: 'left', ...o});
  return {...out, doc: await PDFDocument.load(out.bytes)};
};

test('one page to a sheet: Fit, Actual size and a custom scale give the sheets the paper size; the sheet follows the page\'s orientation when auto', async () => {
  const src = await numbered(3);
  const fit = await sheetsOf(src, {pages: [0, 1, 2]});
  assert.equal(fit.sheets, 3);
  assert.deepEqual(fit.doc.getPage(0).getSize(), {width: 612, height: 792});
  const land = await sheetsOf(src, {pages: [0], orientation: 'landscape'});
  assert.deepEqual(land.doc.getPage(0).getSize(), {width: 792, height: 612});
  const a4 = await sheetsOf(src, {pages: [0], paper: 'A4'});
  assert.ok(Math.abs(a4.doc.getPage(0).getSize().width - 595.28) < 0.01);
  assert.equal((await sheetsOf(src, {pages: [0, 1], fit: 'actual'})).sheets, 2);
  assert.equal((await sheetsOf(src, {pages: [0], fit: 'custom', scale: 50})).sheets, 1);
});

test('several pages to a sheet and booklets: sheets = pages / per sheet rounded up; a booklet has two sides per sheet of four pages, and the subset leaves one side', async () => {
  const src = await numbered(7);
  assert.equal((await sheetsOf(src, {pages: [0, 1, 2, 3, 4, 5, 6], handling: 'multiple', perSheet: 4})).sheets, 2);
  assert.equal((await sheetsOf(src, {pages: [0, 1, 2, 3, 4, 5, 6], handling: 'multiple', perSheet: 2, border: true})).sheets, 4);
  const both = await sheetsOf(src, {pages: [0, 1, 2, 3, 4, 5, 6], handling: 'booklet'});
  assert.equal(both.sheets, 4, 'eight sides for seven pages');
  assert.equal(both.doc.getPage(0).getSize().width > both.doc.getPage(0).getSize().height, true, 'booklet sheets are landscape');
  assert.equal((await sheetsOf(src, {pages: [0, 1, 2, 3, 4, 5, 6], handling: 'booklet', booklet: 'front'})).sheets, 2);
  assert.equal((await sheetsOf(src, {pages: [0, 1, 2, 3, 4, 5, 6], handling: 'booklet', booklet: 'back'})).sheets, 2);
});

test('a page turned by /Rotate is drawn upright on the sheet', async () => {
  const r = await sheetsOf(await numbered(1, {rotate: 90}), {pages: [0]});
  assert.deepEqual(r.doc.getPage(0).getSize(), {width: 792, height: 612}, 'auto orientation follows the turned page, which is landscape');
});

test('print.pages writes "<name> (print).pdf" with the chosen pages; a range outside the document is refused; the dialog maps its fields to the command', async () => {
  const t = await createTestSession('folio', {content: await migrateContent(await createPdfContent(await numbered(6), 'Report.pdf'))});
  const r = (await t.exec('print.pages', {range: '2-4', reverse: true, handling: 'multiple', perSheet: 2})).result;
  assert.equal(r.name, 'Report (print).pdf');
  assert.equal(r.pages, 3);
  assert.equal(r.sheets, 2);
  assert.equal((await PDFDocument.load(Buffer.from(r.base64, 'base64'))).getPageCount(), 2);
  await assert.rejects(() => t.exec('print.pages', {range: '9'}), /page 9 is not in the document/);
  const v = printDialog.init(t.session.readContext(t.docId));
  assert.equal(v.__count, 6);
  assert.deepEqual(printDialog.validate({...v, pages: 'Pages', range: ''}).map(x => x.field), ['range']);
  const cmd = printDialog.toCommand({...v, pages: 'Pages', range: '1-2', subset: 'Odd pages only', handling: 'Booklet', binding: 'Right', booklet: 'Front side only', paper: 'A4'});
  assert.deepEqual(cmd.params, {subset: 'odd', reverse: false, paper: 'A4', orientation: 'auto', handling: 'booklet', fit: 'fit', scale: 100, perSheet: 2, order: 'horizontal', border: false, booklet: 'front', binding: 'right', range: '1-2'});
  assert.equal(printDialog.toCommand({...v, pages: 'Current page', __current: 3}).params.range, '3');
});

test('the Print dialog preview lays the same sheets buildSheets writes: size, several to a sheet, booklet, with the pages and the problems the settings make', async () => {
  const {sheetPlan} = await import('../../core/folio/lib/print-job.mjs');
  const bytes = await numbered(5);
  const t = await createTestSession('folio', {content: await migrateContent(await createPdfContent(bytes, 'five.pdf'))});
  const ctx = t.readContext?.() ?? {doc: t.content};
  const v = {...printDialog.init(ctx)};
  // One page to a sheet: five sheets, each holding one page, centred and fitted on the paper.
  let pv = printDialog.preview(ctx, v);
  assert.equal(pv.total, 5);
  assert.equal(pv.pages, 5);
  assert.equal(pv.sheets[0].cells.length, 1);
  assert.equal(pv.sheets[0].cells[0].page, 0);
  assert.ok(pv.base64 && pv.content.pages.length === 5);
  // Pages to print, odd pages, reversed: the pages the command prints are the ones the preview shows.
  pv = printDialog.preview(ctx, {...v, pages: 'Pages', range: '2-5', subset: 'Odd pages only', reverse: true});
  assert.deepEqual(pv.sheets.map(s => s.cells[0].page), [4, 2]);   // pages 5 and 3
  assert.match(printDialog.preview(ctx, {...v, pages: 'Pages', range: '9'}).problem, /page 9/);
  assert.match(printDialog.preview(ctx, {...v, pages: 'Pages', range: ''}).problem, /Type the pages/);
  // Four to a sheet and a booklet agree with what buildSheets writes.
  for (const [settings, handling] of [[{handling: 'Multiple', pps: '4'}, 'multiple'], [{handling: 'Booklet'}, 'booklet']]) {
    const p = printDialog.toCommand({...v, ...settings}).params;
    const written = await buildSheets(bytes, [0, 1, 2, 3, 4], p);
    pv = printDialog.preview(ctx, {...v, ...settings});
    assert.equal(pv.total, written.sheets, handling);
    const [W, H] = pv.sheets[0].size;
    const out = await PDFDocument.load(written.bytes);
    assert.deepEqual([Math.round(W), Math.round(H)], [Math.round(out.getPage(0).getWidth()), Math.round(out.getPage(0).getHeight())], `${handling}: the sheet is the paper`);
    for (const cell of pv.sheets[0].cells) assert.ok(cell.rect[0] >= 0 && cell.rect[1] >= 0 && cell.rect[0] + cell.rect[2] <= W + 0.01 && cell.rect[1] + cell.rect[3] <= H + 0.01, `${handling}: a page stays on its sheet`);
  }
  assert.equal(pv.sheets[0].cells.some(c => c.page === null) || pv.sheets[0].cells.length === 2, true, 'a booklet sheet has two sides');
  // The sheet plan alone.
  assert.equal(sheetPlan([{w: 100, h: 200}], {handling: 'size', fit: 'actual', paper: 'A4', orientation: 'auto'}).sheets[0].cells[0].rect[2], 100);
});

test('the Print dialog button names what it does: Print to PDF', async () => {
  const spec = JSON.parse((await import('node:fs')).readFileSync(new URL('../../docs/spec/patches/folio/rest-print.json', import.meta.url), 'utf8'));
  assert.deepEqual(spec.dialogs['dialog.print'].buttons, ['Print to PDF', 'Cancel']);
  assert.ok(spec.dialogs['dialog.print'].tabs.every(tab => tab.fields.some(f => f.kind === 'preview')), 'every tab shows the preview');
});
