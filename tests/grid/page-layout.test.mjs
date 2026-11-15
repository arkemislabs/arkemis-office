// U:grid/page-layout: Margins, Orientation, Size, Print Area, Breaks, Print Titles, Scale to Fit, print
// Gridlines and Headings, Header & Footer and the Page Setup dialog's command, Themes, and Arrange
// (Bring Forward, Send Backward), each with its undo round trip, and the xlsx round trip of the page
// setup.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/print.rs and print/layout.rs, ui-egui ribbon/page_layout.rs
//    (the groups and their presets), cmd/view.rs (themes), print/header_footer.rs, checked against
//    fb1e59f: Normal margins 0.7 / 0.75 / 0.3 inches, Wide 1 / 1 / 0.5, Narrow 0.25 / 0.75 / 0.3; a page
//    break goes above and left of the active cell; scaling by percentage and fit to pages exclude each
//    other; Print Titles are the names Print_Titles of the sheet. tests/grid/page-layout-upstream.test.mjs
//    holds the paper list, the header and footer fields and the themes of gridcraft.
// 2. Ours stores the setup on the sheet (core/grid/lib/page-setup.mjs) and writes the same elements
//    Excel does (pageSetup, pageMargins, printOptions, headerFooter, rowBreaks, colBreaks).
// 3. These tests; tests/e2e/grid/page-layout.e2e.mjs drives the ribbon and the dialog.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';
import {sections, joinSections, titlesParts, titlesText} from '../../core/grid/lib/page-setup.mjs';
import {sheetObjects} from '../../core/grid/lib/objects.mjs';

const sel = (t, range) => run(t, 'selection.set', {range});
const sheet = t => t.content.sheets[0];
const data = () => workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 'a'}, B1: {v: 'b'}, A2: {v: 1}, B2: {v: 2}}}}]);

test('margins: the three presets, custom values, and the last custom setting', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.margins', {preset: 'wide'});
  assert.deepEqual(sheet(t).pageSetup.margins, {left: 1, right: 1, top: 1, bottom: 1, header: 0.5, footer: 0.5});
  await run(t, 'pageLayout.margins', {preset: 'narrow'});
  assert.equal(sheet(t).pageSetup.margins.left, 0.25);
  await run(t, 'pageLayout.margins', {left: 0.5, top: 1.25});
  assert.deepEqual([sheet(t).pageSetup.margins.left, sheet(t).pageSetup.margins.top, sheet(t).pageSetup.margins.right], [0.5, 1.25, 0.25]);
  await run(t, 'pageLayout.margins', {preset: 'normal'});
  await run(t, 'pageLayout.margins', {preset: 'last'});
  assert.equal(sheet(t).pageSetup.margins.top, 1.25, 'Last Custom Setting brings the custom margins back');
  await fails(t, 'pageLayout.margins', {preset: 'huge'});
  await expectUndoRoundTrip(t, 'pageLayout.margins', {preset: 'wide'}, () => {});
});

test('orientation, paper size, headings and gridlines when printed', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.orientation', {orientation: 'landscape'});
  assert.equal(sheet(t).pageSetup.orientation, 'landscape');
  assert.equal((await run(t, 'pageLayout.orientation', {})).orientation, 'portrait', 'with none given it turns the page');
  await run(t, 'pageLayout.size', {paper: 'a4'});
  assert.equal(sheet(t).pageSetup.paper, 'A4');
  await fails(t, 'pageLayout.size', {paper: 'Folio'});
  await run(t, 'pageLayout.printGridlines', {});
  await run(t, 'pageLayout.printHeadings', {on: true});
  assert.deepEqual([sheet(t).pageSetup.printGridlines, sheet(t).pageSetup.printHeadings], [true, true]);
  await run(t, 'pageLayout.printGridlines', {});
  assert.equal(sheet(t).pageSetup.printGridlines, undefined);
  await expectUndoRoundTrip(t, 'pageLayout.size', {paper: 'Legal'}, () => {});
});

test('print area: set to the selection, add another, clear', async () => {
  const t = await session(data());
  await sel(t, 'A1:B2');
  await run(t, 'pageLayout.printArea', {});
  assert.equal(sheet(t).printArea, 'A1:B2');
  await sel(t, 'D4:E5');
  await run(t, 'pageLayout.printArea', {add: true});
  assert.equal(sheet(t).printArea, 'A1:B2,D4:E5');
  await run(t, 'pageLayout.printArea', {range: 'C3'});
  assert.equal(sheet(t).printArea, 'C3');
  await run(t, 'pageLayout.printArea', {clear: true});
  assert.equal(sheet(t).printArea, undefined);
  await expectUndoRoundTrip(t, 'pageLayout.printArea', {range: 'A1:B2'}, () => {});
});

test('page breaks go above and left of the active cell, a whole row or column breaks on its own line', async () => {
  const t = await session(data());
  await sel(t, 'C4');
  await run(t, 'pageLayout.breaks', {insert: true});
  assert.deepEqual([sheet(t).pageSetup.rowBreaks, sheet(t).pageSetup.colBreaks], [[3], [2]]);
  await sel(t, '/sh:s1/row:10');
  await run(t, 'pageLayout.breaks', {insert: true});
  assert.deepEqual(sheet(t).pageSetup.rowBreaks, [3, 9]);
  assert.deepEqual(sheet(t).pageSetup.colBreaks, [2], 'a whole row adds no column break');
  await sel(t, 'C4');
  await run(t, 'pageLayout.breaks', {remove: true});
  assert.deepEqual(sheet(t).pageSetup.rowBreaks, [9]);
  assert.equal(sheet(t).pageSetup.colBreaks, undefined);
  await run(t, 'pageLayout.breaks', {reset: true});
  assert.equal(sheet(t).pageSetup, undefined);
  await sel(t, 'A1');
  await run(t, 'pageLayout.breaks', {insert: true});
  assert.equal(sheet(t).pageSetup, undefined, 'there is no break above row 1 or left of column A');
});

test('print titles repeat rows and columns, and the text is the Print_Titles name of the sheet', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.printTitles', {rows: '1:2', cols: 'A:A'});
  assert.equal(sheet(t).printTitles, 'Sheet1!$A:$A,Sheet1!$1:$2');
  await run(t, 'pageLayout.printTitles', {rows: '1'});
  assert.deepEqual(titlesParts(sheet(t).printTitles), {cols: 'A:A', rows: '1:1'});
  await fails(t, 'pageLayout.printTitles', {rows: 'x'});
  await run(t, 'pageLayout.printTitles', {clear: true});
  assert.equal(sheet(t).printTitles, undefined);
  assert.equal(titlesText('My Sheet', '', '3:4'), "'My Sheet'!$3:$4");
});

test('scale to fit: percentage and fit to pages exclude each other', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.scaleToFit', {scale: 80});
  assert.equal(sheet(t).pageSetup.scale, 80);
  await run(t, 'pageLayout.scaleToFit', {width: '1 page'});
  assert.deepEqual([sheet(t).pageSetup.fitWidth, sheet(t).pageSetup.fitHeight, sheet(t).pageSetup.scale], [1, 0, undefined]);
  await run(t, 'pageLayout.scaleToFit', {height: 'Automatic', width: 2});
  assert.deepEqual([sheet(t).pageSetup.fitWidth, sheet(t).pageSetup.fitHeight], [2, 0]);
  await run(t, 'pageLayout.scaleToFit', {scale: 120});
  assert.deepEqual([sheet(t).pageSetup.scale, sheet(t).pageSetup.fitWidth], [120, undefined]);
  await fails(t, 'pageLayout.scaleToFit', {scale: 5});
});

test('header and footer: the text Excel stores and its sections', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.headerFooter', {headerLeft: 'Report', headerRight: '&D', footer: '&CPage &P of &N', differentFirst: true});
  assert.deepEqual(sheet(t).pageSetup.headerFooter, {header: '&LReport&R&D', footer: '&CPage &P of &N', differentFirst: true});
  assert.deepEqual(sections('&LReport&R&D'), {left: 'Report', center: '', right: '&D'});
  assert.equal(joinSections({center: 'x'}), '&Cx');
  await run(t, 'pageLayout.headerFooter', {header: '', footer: '', differentFirst: false});
  assert.equal(sheet(t).pageSetup, undefined);
});

test('the Page Setup dialog command sets every box of its four tabs', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.pageSetup', {orientation: 'landscape', paper: 'A4', scaling: 'fit', fitWidth: 1, fitHeight: 0, left: 0.4, headerMargin: 0.2, centerHorizontally: true,
    header: '&A', footer: '&P', printArea: 'A1:B2', printTitleRows: '1:1', gridlines: true, headings: true, comments: 'end', errors: 'dash', pageOrder: 'over', firstPage: 3, blackAndWhite: true});
  const p = sheet(t).pageSetup;
  assert.deepEqual([p.orientation, p.paper, p.fitWidth, p.fitHeight, p.scale], ['landscape', 'A4', 1, 0, undefined]);
  assert.deepEqual([p.margins.left, p.margins.header, p.centerH, p.printGridlines, p.printHeadings, p.comments, p.errors, p.pageOrder, p.firstPage, p.blackAndWhite], [0.4, 0.2, true, true, true, 'end', 'dash', 'over', 3, true]);
  assert.deepEqual(p.headerFooter, {header: '&A', footer: '&P'});
  assert.equal(sheet(t).printArea, 'A1:B2');
  assert.equal(sheet(t).printTitles, 'Sheet1!$1:$1');
  await expectUndoRoundTrip(t, 'pageLayout.pageSetup', {orientation: 'portrait', scaling: 'adjust', scale: 90}, () => {});
});

test('themes: a theme, a colour set and a font pair are stored on the workbook', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.theme', {name: 'Office 2013 - 2022'});
  assert.equal(t.content.theme.name, 'Office 2013 - 2022');
  assert.equal(t.content.theme.colors[4], 0x4472C4);
  assert.equal(t.content.theme.majorFont, 'Calibri Light');
  await run(t, 'pageLayout.themeColors', {name: 'office 2007 - 2010'});
  assert.equal(t.content.theme.colors[4], 0x4F81BD);
  assert.equal(t.content.theme.majorFont, 'Calibri Light', 'colours leave the fonts');
  await run(t, 'pageLayout.themeFonts', {name: 'Arial'});
  assert.deepEqual([t.content.theme.majorFont, t.content.theme.minorFont], ['Arial', 'Arial']);
  await fails(t, 'pageLayout.theme', {name: 'Nope'});
  await expectUndoRoundTrip(t, 'pageLayout.theme', {name: 'Craft'}, () => {});
});

test('arrange: bring forward and send backward reorder the stack across chart, picture and shape', async () => {
  const t = await session(data());
  await run(t, 'insert.shape', {kind: 'rectangle', at: 'D2'});
  await run(t, 'insert.shape', {kind: 'ellipse', at: 'D2'});
  await run(t, 'insert.chart', {type: 'column', range: 'A1:B2', at: 'D2'});
  const kinds = () => sheetObjects(sheet(t)).map(o => (o.kind === 'shape' ? o.object.kind : o.kind));
  assert.deepEqual(kinds(), ['chart', 'rectangle', 'ellipse'], 'charts first, then shapes, as they were added');
  await run(t, 'arrange.bringForward', {toFront: true});
  assert.deepEqual(kinds(), ['rectangle', 'ellipse', 'chart']);
  await run(t, 'arrange.sendBackward', {});
  assert.deepEqual(kinds(), ['rectangle', 'chart', 'ellipse']);
  await run(t, 'insert.icons', {name: 'check', at: 'D2'});
  assert.equal(kinds()[3], 'icon', 'a new object goes on top');
  await run(t, 'object.select', {kind: 'shape', id: sheet(t).shapes.find(s => s.kind === 'rectangle').id});
  await run(t, 'arrange.bringForward', {toFront: true});
  assert.equal(kinds()[3], 'rectangle');
  await run(t, 'arrange.sendBackward', {toBack: true});
  assert.equal(kinds()[0], 'rectangle');
  await run(t, 'object.select', {});
  await fails(t, 'arrange.bringForward', {});
});

test('page setup survives .xlsx: margins, paper, orientation, scale or fit, centring, headers, breaks, titles and print area', async () => {
  const c = workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}}}, printArea: 'A1:C5', printTitles: 'Sheet1!$1:$1', pageSetup: {
    orientation: 'landscape', paper: 'A4', fitWidth: 1, fitHeight: 0, margins: {left: 0.4, right: 0.5, top: 0.6, bottom: 0.7, header: 0.2, footer: 0.25}, centerH: true, printGridlines: true, printHeadings: true,
    comments: 'end', errors: 'dash', pageOrder: 'over', firstPage: 3, blackAndWhite: true, headerFooter: {header: '&LReport&R&D', footer: '&CPage &P of &N', differentFirst: true}, rowBreaks: [10, 20], colBreaks: [4]}},
  {id: 's2', name: 'Sheet2', blocks: {}, pageSetup: {scale: 75, paper: 'Legal'}}]);
  const bytes = await writeXlsx(c);
  const xml = await (await JSZip.loadAsync(bytes)).file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<pageSetUpPr fitToPage="1"\/>/);
  assert.match(xml, /<printOptions horizontalCentered="1" headings="1" gridLines="1"\/>/);
  assert.match(xml, /<pageMargins left="0.4" right="0.5" top="0.6" bottom="0.7" header="0.2" footer="0.25"\/>/);
  assert.match(xml, /<pageSetup paperSize="9" fitToWidth="1" fitToHeight="0" firstPageNumber="3" useFirstPageNumber="1" orientation="landscape" blackAndWhite="1" cellComments="atEnd" errors="dash" pageOrder="overThenDown"\/>/);
  assert.match(xml, /<headerFooter differentFirst="1"><oddHeader>&amp;LReport&amp;R&amp;D<\/oddHeader><oddFooter>&amp;CPage &amp;P of &amp;N<\/oddFooter><\/headerFooter>/);
  assert.match(xml, /<rowBreaks count="2" manualBreakCount="2"><brk id="10" max="16383" man="1"\/><brk id="20" max="16383" man="1"\/><\/rowBreaks><colBreaks count="1" manualBreakCount="1"><brk id="4" max="1048575" man="1"\/><\/colBreaks>/);
  const back = (await readXlsx(bytes)).content ?? (await readXlsx(bytes));
  const [s1, s2] = back.sheets;
  assert.deepEqual(s1.pageSetup, c.sheets[0].pageSetup);
  assert.equal(s1.printArea, 'A1:C5');
  assert.deepEqual(s2.pageSetup, {scale: 75, paper: 'Legal'});
});
