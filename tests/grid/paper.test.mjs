// U:grid/view and U:grid/header-and-footer: Page Layout view (the pages and the cell <-> page mapping), the Ruler, the margins
// dragged on a ruler, the header and footer edited in place (Header & Footer tab) and the text they print.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/paper.rs (PageGrid and its tests: pages match print pagination and cells map
//    both ways; margins, gaps and header zones; header zones and text follow Scale with Document and Align with Page
//    Margins), crates/ui-egui/src/paper_view.rs (margin_from_drag and its test, begin, commit, cancel, insert_field,
//    go_to, set_option, ribbon_tab), crates/engine/src/cmd/print/header_footer.rs (expand_header_footer) at fb1e59f.
// 2. Ours: the edit in progress is the document view's `hf`; the pages are core/grid/lib/paper.mjs.
// 3. These tests; tests/e2e/grid/view.e2e.mjs and header-footer.e2e.mjs drive the ribbon and the surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import {PageGrid, needFor, marginFromDrag} from '../../core/grid/lib/paper.mjs';
import {expandHeaderFooter, hfPageKind, hfText, hfDateTime} from '../../core/grid/lib/page-setup.mjs';
import {evaluate as flags} from '../../core/grid/context.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';

/** A sheet with `rows` by `cols` cells of numbers. */
function grid(rows, cols, extra = {}) {
  const blocks = {};
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) (blocks[Math.floor(r / 64)] ??= {})[`${String.fromCharCode(65 + (c % 26))}${r + 1}`] = {v: 1};
  return workbook([{id: 's1', name: 'Sheet1', blocks, ...extra}]);
}
const sheetOf = t => t.content.sheets[0];

test('the pages are the printed pages: every cell maps to one page and back', async () => {
  const t = await session(grid(120, 3));
  const sh = sheetOf(t);
  const pg = PageGrid.build(sh, 0, 0);
  assert.ok(pg.rowBands.length >= 3, 'a 120 row sheet is several pages tall');
  assert.equal(pg.colBands.length >= 1, true);
  // Bands tile the rows without gaps.
  for (let i = 1; i < pg.rowBands.length; i++) assert.equal(pg.rowBands[i][0], pg.rowBands[i - 1][1] + 1);
  // A cell's top-left corner maps back to the cell, in every band.
  for (const row of [0, 10, pg.rowBands[1][0], pg.rowBands[1][1], 119]) {
    for (const col of [0, 1, 2]) {
      const x = pg.colX(col) + 1, y = pg.rowY(row) + 1;
      assert.equal(pg.rowAt(y), row, `row ${row}`);
      assert.equal(pg.colAt(x), col, `col ${col}`);
      assert.equal(pg.onCells(x, y), true, 'on cells');
    }
  }
  // Pages sit in a grid with a gap; the margins hold no cells and hit the nearest one.
  const [px, py, w, h] = pg.pageRect(0, 0);
  assert.equal(px, pg.gap);
  assert.equal(pg.pageRect(1, 0)[1], py + h + pg.gap);
  assert.equal(pg.onCells(px + 1, py + 1), false, 'the top-left margin');
  assert.equal(pg.onCells(px + w + pg.gap / 2, py + 5), false, 'the gap');
  assert.equal(pg.rowAt(py + 1), 0);
  assert.equal(pg.pageNumber(0, 0)[0], 1);
  assert.equal(pg.pageNumber(1, 0)[0], 2);
  const more = PageGrid.build(sh, 400, 0);
  assert.ok(more.rowBands.length > pg.rowBands.length, 'pages go on past the data');
  assert.equal(more.pageNumber(more.rowBands.length - 1, 0), null, 'a page past the data is "Click to add data"');
});

test('the margins, the gap and the header zones: thirds between the side margins, the footer at the bottom', async () => {
  const t = await session(grid(5, 3));
  const pg = PageGrid.build(sheetOf(t), 0, 0);
  const [px, py, w, h] = pg.pageRect(0, 0);
  const [l, r, tm, bm] = pg.margins;
  // Letter at 100%: 0.7 in side margins and 0.75 in top and bottom, in 96 dpi pixels.
  assert.ok(Math.abs(l - 0.7 * 96) < 1e-6);
  assert.ok(Math.abs(tm - 0.75 * 96) < 1e-6);
  const [cx, cy, cw, ch] = pg.contentRect(0, 0);
  assert.deepEqual([cx, cy], [px + l, py + tm]);
  assert.ok(Math.abs(cw - (w - l - r)) < 1e-6 && Math.abs(ch - (h - tm - bm)) < 1e-6);
  const inner = w - pg.hfSides[0] - pg.hfSides[1];
  const zone = (x, y) => pg.hfZoneAt(x, y);
  assert.deepEqual(zone(px + pg.hfSides[0] + 1, py + 2), {page: [0, 0], footer: false, section: 0});
  assert.equal(zone(px + pg.hfSides[0] + inner / 2, py + 2).section, 1);
  assert.equal(zone(px + w - pg.hfSides[1] - 1, py + 2).section, 2);
  assert.deepEqual(zone(px + pg.hfSides[0] + inner / 2, py + h - 2), {page: [0, 0], footer: true, section: 1});
  assert.equal(zone(px + w / 2, py + h / 2), null, 'the middle of the page is not a zone');
});

test('Scale with Document and Align with Page Margins change the header and footer sides and text size', async () => {
  const t = await session(grid(5, 3, {pageSetup: {scale: 50, margins: {left: 2, right: 2, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3}}}));
  const sh = sheetOf(t);
  const aligned = PageGrid.build(sh, 0, 0);
  // At 50% a layout unit is two pixels of paper: the 2 in margins keep their 192 sheet pixels at that scale.
  assert.ok(Math.abs(aligned.hfSides[0] - aligned.margins[0]) < 1e-9, 'aligned with the page margins');
  assert.equal(aligned.hfTextK, 1, 'scaled with the document: the text keeps its size at the print scale');
  const loose = PageGrid.build({...sh, pageSetup: {...sh.pageSetup, headerFooter: {alignWithMargins: false, scaleWithDoc: false}}}, 0, 0);
  const fixed = 0.7 * 96 / 0.5;
  assert.ok(Math.abs(loose.hfSides[0] - fixed) < 1e-6, `0.7 in fixed sides, not the margin: ${loose.hfSides[0]}`);
  assert.ok(Math.abs(loose.hfTextK - 2) < 1e-9, 'not scaled: 1 / scale');
});

test('print scale and hostile settings stay bounded: huge margins, a tiny scale, an empty sheet', async () => {
  const t = await session(workbook());
  const empty = PageGrid.build(sheetOf(t), 0, 0);
  assert.equal(empty.rowBands.length >= 1, true);
  assert.equal(empty.pageNumber(0, 0)[1], 1);
  const wild = PageGrid.build({...sheetOf(t), pageSetup: {scale: 10, margins: {left: 20, right: 20, top: 20, bottom: 20, header: 20, footer: 20}}}, 40, 5);
  assert.ok(wild.rowBands.length >= 1 && Number.isFinite(wild.pageW) && wild.pageW > 0);
  assert.ok(wild.contentRect(0, 0)[2] >= 1);
  assert.deepEqual(needFor(sheetOf(t), -5, -5).map(Number.isFinite), [true, true]);
});

test('margins dragged on a ruler map to inches and stay inside the page (upstream test, A4)', () => {
  const A4 = [595, 842];
  const m = [0.7, 0.7, 0.75, 0.75, 0.3, 0.3];
  assert.equal(marginFromDrag('left', 72, A4, m), 1);
  assert.equal(marginFromDrag('right', A4[0] - 36, A4, m), 0.5);
  assert.equal(marginFromDrag('top', 108, A4, m), 1.5);
  assert.equal(marginFromDrag('left', -50, A4, m), 0);
  assert.equal(marginFromDrag('bottom', A4[1] + 99, A4, m), 0.3);
  const max = marginFromDrag('left', 10000, A4, m);
  assert.ok(Math.abs(max * 72 - (A4[0] - 0.7 * 72 - 36)) < 1);
  assert.equal(marginFromDrag('left', NaN, A4, m), null);
  assert.equal(marginFromDrag('left', Infinity, A4, m), null);
  assert.equal(marginFromDrag('left', 10, [0, 0], m), null);
  assert.equal(marginFromDrag('left', 10, A4, [0.7, NaN, 0.7, 0.7, 0.3, 0.3]), null);
  assert.equal(marginFromDrag('left', 300, A4, [0, 40, 0, 0, 0.3, 0.3]), 0);
  assert.equal(marginFromDrag('header', 36, A4, m), 0.5);
  assert.equal(marginFromDrag('footer', A4[1] - 18, A4, m), 0.25);
  assert.equal(marginFromDrag('footer', 1e9, A4, m), 0);
  assert.equal(marginFromDrag('header', 500, A4, m), 0.75, 'the header stays within the top margin');
  assert.equal(marginFromDrag('footer', A4[1] - 500, A4, m), 0.75);
  assert.equal(marginFromDrag('top', 2, A4, m), 0.3, 'the top margin cannot go inside the header');
  assert.equal(marginFromDrag('bottom', A4[1] - 2, A4, m), 0.3);
  assert.equal(marginFromDrag('header', 10, A4, [0.7, 0.7, 0.75, 0.75, NaN, 0.3]), 0.14);
  assert.equal(marginFromDrag('top', 300, A4, [0.7, 0.7, 0.75, 0.75, -5, Infinity]), 4.17);
  assert.equal(marginFromDrag('header', NaN, A4, m), null);
  const v = marginFromDrag('footer', 10, A4, [0, 0, 1e9, 1e9, 0.3, 1e9]);
  assert.ok(v >= 0 && v <= 11.7);
});

test('Page Layout view and the Ruler are the window view, not edits; the ruler needs Page Layout view', async () => {
  const t = await session(grid(5, 3));
  assert.equal(t.state('view.pageLayout').checked, false);
  assert.equal(t.state('view.ruler').enabled, false, 'rulers exist only in Page Layout view');
  assert.deepEqual(await run(t, 'view.pageLayout', {}), {view: 'pageLayout'});
  assert.equal(t.session.get(t.docId).view.mode, 'pageLayout');
  assert.equal(t.state('view.pageLayout').checked, true);
  assert.equal(t.state('view.normal').checked, false);
  assert.deepEqual(t.state('view.ruler'), {enabled: true, checked: true});
  assert.deepEqual(await run(t, 'view.ruler', {}), {on: false});
  assert.equal(t.state('view.ruler').checked, false);
  await run(t, 'view.ruler', {on: true});
  assert.equal(t.state('view.ruler').checked, true);
  assert.equal(t.session.get(t.docId).undo.size, 0, 'neither is an undo step');
  await run(t, 'view.normal', {});
  assert.equal(t.state('view.pageLayout').checked, false);
  assert.equal(t.state('view.ruler').enabled, false);
});

test('a header being edited in place: begin, type, insert fields, switch sections, Go to Footer, commit as one undo step', async () => {
  const t = await session(grid(5, 3));
  const hf = () => t.session.get(t.docId).view.hf;
  assert.equal(flags(t.content, t.session.get(t.docId).selection, undefined, t.session.get(t.docId).view)['header-and-footer'], false);
  assert.equal(t.state('pageLayout.headerFooterField').enabled, false, 'nothing is being edited');
  await run(t, 'pageLayout.headerFooterEdit', {});
  assert.equal(t.session.get(t.docId).view.mode, 'pageLayout', 'Insert > Header & Footer switches to Page Layout view');
  assert.deepEqual([hf().page, hf().footer, hf().section, hf().kind], [[0, 0], false, 1, 'odd']);
  assert.equal(flags(t.content, t.session.get(t.docId).selection, undefined, t.session.get(t.docId).view)['header-and-footer'], true, 'the Header & Footer tab shows');
  await run(t, 'pageLayout.headerFooterText', {text: 'Report '});
  await run(t, 'pageLayout.headerFooterField', {insertField: '&[Page]'});
  await run(t, 'pageLayout.headerFooterField', {insertField: '&[Tab]'});
  assert.equal(hf().texts[1], 'Report &[Page]&[Tab]');
  assert.equal(sheetOf(t).pageSetup?.headerFooter, undefined, 'nothing is written until the edit ends');
  await run(t, 'pageLayout.headerFooterEdit', {section: 'right'});
  await run(t, 'pageLayout.headerFooterField', {insertField: '&[Date]'});
  await run(t, 'pageLayout.headerFooterField', {insertField: '&[Path]&[File]'});
  assert.equal(hf().texts[2], '&[Date]&[Path]&[File]');
  await fails(() => run(t, 'pageLayout.headerFooterField', {insertField: 'Hello'}), /insertField/);
  // Go to Footer writes the header (one undo step) and edits the footer of the same page.
  await run(t, 'pageLayout.headerFooterGoTo', {footer: true});
  assert.equal(sheetOf(t).pageSetup.headerFooter.header, '&CReport &P&A&R&D&Z&F');
  assert.deepEqual([hf().footer, hf().section], [true, 2]);
  await run(t, 'pageLayout.headerFooterText', {text: 'Confidential', section: 0});
  await run(t, 'pageLayout.headerFooterEnd', {});
  assert.equal(hf(), null);
  assert.equal(sheetOf(t).pageSetup.headerFooter.footer, '&LConfidential');
  assert.equal(t.session.get(t.docId).view.hf, null);
  // Both writes were one undo step each: the footer, then the header.
  await run(t, 'edit.undo', {});
  assert.equal(sheetOf(t).pageSetup.headerFooter.footer, undefined);
  assert.equal(sheetOf(t).pageSetup.headerFooter.header, '&CReport &P&A&R&D&Z&F');
  await run(t, 'edit.undo', {});
  assert.equal(sheetOf(t).pageSetup, undefined);
});

test('Esc cancels an edit; a header with no change writes nothing; the presets set the text and end the edit', async () => {
  const t = await session(grid(5, 3));
  await run(t, 'pageLayout.headerFooterEdit', {});
  await run(t, 'pageLayout.headerFooterText', {text: 'Draft'});
  await run(t, 'pageLayout.headerFooterEnd', {cancel: true});
  assert.equal(sheetOf(t).pageSetup, undefined);
  await run(t, 'pageLayout.headerFooterEdit', {});
  assert.deepEqual(await run(t, 'pageLayout.headerFooterEnd', {}), {wrote: false});
  assert.equal(t.session.get(t.docId).undo.size, 0, 'no change, no undo step');
  // The list a preset button shows: the sample text as the result will read.
  const list = t.state('pageLayout.headerFooterPreset').value.map(x => x.label);
  assert.deepEqual(list, ['(none)', 'Page 1', 'Page 1 of ?', 'Sheet1', 'Test document', 'Sheet1, Page 1', 'Test document, Page 1']);
  await run(t, 'pageLayout.headerFooterEdit', {footer: true});
  await run(t, 'pageLayout.headerFooterText', {text: 'discarded'});
  await run(t, 'pageLayout.headerFooterPreset', {part: 'footer', preset: 2});
  assert.equal(sheetOf(t).pageSetup.headerFooter.footer, '&CPage &P of &N');
  assert.equal(t.session.get(t.docId).view.hf, null, 'a preset ends the edit without writing it');
  await run(t, 'pageLayout.headerFooterPreset', {part: 'footer', preset: 0});
  assert.equal(sheetOf(t).pageSetup, undefined, 'none removes it again');
});

test('Different First Page and Different Odd & Even Pages: the edit follows the page it is on, written texts are kept', async () => {
  const t = await session(grid(120, 3));
  const hf = () => t.session.get(t.docId).view.hf;
  await run(t, 'pageLayout.headerFooterEdit', {});
  await run(t, 'pageLayout.headerFooterText', {text: 'Every page'});
  // Turning an option on writes the edit first, then edits the same page again, which is now the first page.
  await run(t, 'pageLayout.headerFooter', {differentFirst: true});
  assert.equal(sheetOf(t).pageSetup.headerFooter.header, '&CEvery page');
  assert.equal(hf().kind, 'first');
  assert.deepEqual(hf().texts, ['', '', ''], 'the first page has its own, empty header');
  await run(t, 'pageLayout.headerFooterText', {text: 'Title page'});
  await run(t, 'pageLayout.headerFooterEdit', {page: [1, 0]});
  assert.equal(sheetOf(t).pageSetup.headerFooter.firstHeader, '&CTitle page');
  assert.equal(hf().kind, 'odd');
  assert.deepEqual([hf().texts[1]], ['Every page'], 'page 2 shows the rest');
  await run(t, 'pageLayout.headerFooter', {differentOddEven: true});
  assert.equal(hf().kind, 'even', 'page 2 is an even page now');
  assert.equal(hfPageKind({headerFooter: {differentFirst: true, differentOddEven: true}}, 1), 'first');
  assert.equal(hfPageKind({headerFooter: {differentOddEven: true}}, 4), 'even');
  assert.equal(hfText({headerFooter: {evenHeader: '&CE', header: '&CO'}}, 'even', false), '&CE');
});

test('what a header and footer print: the fields, the page and its sections, bold and size', () => {
  const cx = {page: 3, pages: 12, sheet: 'Q1', file: 'Budget', path: 'C:/Files/', date: '10/31/2026', time: '9:05 AM'};
  const [l, c, r] = expandHeaderFooter('&LPrepared &D&CPage &P of &N&R&B&14&A&B &F&Z', cx);
  assert.equal(l.text, 'Prepared 10/31/2026');
  assert.equal(c.text, 'Page 3 of 12');
  assert.deepEqual([r.text, r.bold, r.size], ['Q1 BudgetC:/Files/', false, 14]);
  assert.equal(expandHeaderFooter('&P+2 &P-1', cx)[1].text, '5 2');
  assert.equal(expandHeaderFooter('&&A', cx)[1].text, '&A');
  assert.deepEqual([expandHeaderFooter('&\"Arial,Bold Italic\"x', cx)[1].bold, expandHeaderFooter('&\"Arial,Bold Italic\"x', cx)[1].italic], [true, true]);
  assert.equal(expandHeaderFooter('&KFF0000red', cx)[1].text, 'red', 'colour codes are skipped');
  assert.match(hfDateTime(new Date(2026, 9, 31, 9, 5)).time, /^9:05 AM$/);
  assert.equal(hfDateTime(new Date(2026, 9, 31, 0, 7)).time, '12:07 AM');
  assert.equal(hfDateTime(new Date(2026, 9, 31, 13, 0)).date, '10/31/2026');
});
