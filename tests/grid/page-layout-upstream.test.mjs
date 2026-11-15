// U:grid/page-layout, checked against gridcraft fb1e59f: the paper list (JIS B sizes, the ISO series, Ledger,
// the Japanese postcards and envelopes), page setup with gridcraft's own keys, header and footer fields,
// the first and even page texts, the 255-character cap, and the seven GridCraft themes.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: crates/engine/src/cmd/print/layout.rs (`known_paper`), cmd/print.rs (`page_setup`),
//    cmd/view.rs (`header_footer`, `themes`, `theme`), cmd/print/header_footer.rs (`split_header_footer`,
//    `fields_to_codes`, `codes_to_fields`), crates/xlsx tables.rs (paper ids).
// 2. Ours: the same keys on our sheet model (core/grid/lib/page-setup.mjs).
// 3. These tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readXlsx} from '../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx} from '../../core/grid/formats/xlsx-write.mjs';
import {session, workbook, run, fails} from './edit-helpers.mjs';
import {titlesParts, paperByName, paperPoints, PAPER_NAMES, splitHeaderFooter, fieldsToCodes, codesToFields} from '../../core/grid/lib/page-setup.mjs';

const sheet = t => t.content.sheets[0];
const data = () => workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 'a'}, B1: {v: 'b'}, A2: {v: 1}, B2: {v: 2}}}}]);

test('paper sizes: the JIS B sizes, the ISO series, Ledger, the Japanese postcards and envelopes, loose spelling', async () => {
  assert.equal(PAPER_NAMES.length, 21);
  assert.deepEqual(paperPoints('B4'), [728.5, 1031.81], 'B4 is the JIS size, 257 x 364 mm');
  assert.deepEqual(paperPoints('b4 (iso)'), [708.66, 1000.63]);
  assert.deepEqual(paperPoints('B5-JIS'), paperPoints('B5'));
  assert.deepEqual(paperPoints('Ledger'), [1224, 792]);
  assert.deepEqual(paperPoints('chou#3'), paperPoints('Japanese Envelope #3'));
  assert.deepEqual(paperPoints('nonsense'), [612, 792], 'an unknown name is Letter');
  assert.equal(paperByName('Japanese Postcard')[1], 43);
  assert.equal(paperByName('B5 (ISO)')[1], null, 'the file has no paperSize code for the ISO B5');
  const t = await session(data());
  await run(t, 'pageLayout.size', {paper: 'Japanese Envelope Kaku #2'});
  assert.equal(sheet(t).pageSetup.paper, 'Japanese Envelope Kaku #2');
  await run(t, 'pageLayout.size', {paper: 'b6 (iso)'});
  assert.equal(sheet(t).pageSetup.paper, 'B6 (ISO)');
  const back = await readXlsx(await writeXlsx(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}}}, pageSetup: {paper: 'Japanese Double Postcard'}}])));
  assert.equal(back.sheets[0].pageSetup.paper, 'Japanese Double Postcard');
});

test('orientation without a value is portrait; page setup takes the margins as an object, title rows and columns, breaks, fit to page', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.orientation', {orientation: 'landscape'});
  await run(t, 'pageLayout.orientation', {});
  assert.equal(sheet(t).pageSetup.orientation, 'portrait');
  await run(t, 'pageLayout.pageSetup', {margins: {left: 0.4, bottom: 20}, titleRows: '1:2', titleCols: 'A:A', rowBreaks: [46, 91, 1], colBreaks: ['K', 3], fitToPage: true, centerH: true, gridlines: true, headings: true});
  const p = sheet(t).pageSetup;
  assert.equal(p.margins.left, 0.4);
  assert.equal(p.margins.bottom, 20);
  assert.deepEqual(p.rowBreaks, [45, 90], 'a break above row 46 and 91; row 1 cannot break');
  assert.deepEqual(p.colBreaks, [2, 10]);
  assert.deepEqual([p.fitWidth, p.fitHeight, p.centerH, p.printGridlines, p.printHeadings], [1, 1, true, true, true]);
  assert.deepEqual(titlesParts(sheet(t).printTitles), {cols: 'A:A', rows: '1:2'});
  await run(t, 'pageLayout.pageSetup', {titleRows: null, fitToPage: false});
  assert.deepEqual(titlesParts(sheet(t).printTitles), {cols: 'A:A', rows: ''}, 'null clears one axis and leaves the other');
  assert.equal(sheet(t).pageSetup.fitWidth, undefined);
  await fails(t, 'pageLayout.margins', {left: 21});
});

test('header and footer: field names, one section edited in place, first and even pages, 255 characters', async () => {
  assert.equal(fieldsToCodes('Page &[Page] of &[Pages] &[Tab] &&'), 'Page &P of &N &A &&');
  assert.equal(fieldsToCodes('Fish &'), 'Fish &&', 'a dangling ampersand stays a literal one');
  assert.equal(codesToFields('&P / &N &F'), '&[Page] / &[Pages] &[File]');
  assert.deepEqual(splitHeaderFooter('Plain&LLeft&CMid&RRight'), ['Left', 'PlainMid', 'Right'], 'text before the first section code is the centre, which the centre code continues');
  assert.deepEqual(splitHeaderFooter('Plain'), ['', 'Plain', ''], 'text before the first section code belongs to the centre');
  assert.deepEqual(splitHeaderFooter('&L&"Arial,Bold"Left&R&P'), ['&"Arial,Bold"Left', '', '&P']);
  const t = await session(data());
  await run(t, 'pageLayout.headerFooter', {part: 'footer', section: 'center', text: 'Page &[Page] of &[Pages]'});
  assert.equal(sheet(t).pageSetup.headerFooter.footer, '&CPage &P of &N');
  await run(t, 'pageLayout.headerFooter', {part: 'footer', section: 'left', text: '&[File]'});
  assert.equal(sheet(t).pageSetup.headerFooter.footer, '&L&F&CPage &P of &N');
  const r = await run(t, 'pageLayout.headerFooter', {page: 'first', part: 'header', section: 'right', text: '&[Date]', differentFirst: true});
  assert.equal(r.firstHeader, '&R&D');
  assert.equal(r.differentFirst, true);
  await run(t, 'pageLayout.headerFooter', {evenHeader: '&LEven', evenFooter: '&REven', differentOddEven: true});
  await run(t, 'pageLayout.headerFooter', {header: 'x'.repeat(300)});
  assert.equal([...sheet(t).pageSetup.headerFooter.header].length, 255);
  const back = await readXlsx(await writeXlsx(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1}}}, pageSetup: {headerFooter: sheet(t).pageSetup.headerFooter}}])));
  assert.deepEqual(back.sheets[0].pageSetup.headerFooter, sheet(t).pageSetup.headerFooter, 'first and even page texts survive .xlsx');
});

test('the Header & Footer dialog edits the sections with field names and the first and even pages', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.headerFooter', {header: '&L&D&CReport', footer: '&CPage &P of &N', firstHeader: '&RFirst', differentFirst: true});
  const {default: dialog} = await import('../../core/grid/dialogs/headerFooter.mjs');
  const values = dialog.init({doc: t.content, selection: t.doc.selection, view: t.doc.view, app: 'grid', ...{baseDoc: undefined}});
  assert.equal(values.left, '&[Date]');
  assert.equal(values.center, 'Report');
  assert.equal(values.footerCenter, 'Page &[Page] of &[Pages]');
  assert.equal(values.firstRight, 'First');
  assert.equal(values.differentFirst, true);
  const {params} = dialog.toCommand({...values, footerRight: '&[Tab]', evenLeft: 'e', differentOddEven: true});
  assert.equal(params.header, '&L&D&CReport');
  assert.equal(params.footer, '&CPage &P of &N&R&A');
  assert.equal(params.evenHeader, '&Le');
  assert.equal(params.differentOddEven, true);
  assert.equal(dialog.validate({...values, center: 'x'.repeat(260)}).length, 1);
});

test('themes: the seven GridCraft themes with their palettes; fonts stay unless named; twelve colours of one\'s own', async () => {
  const t = await session(data());
  await run(t, 'pageLayout.theme', {name: 'Slate'});
  assert.equal(t.content.theme.name, 'Slate');
  assert.equal(t.content.theme.colors[4], 0x4F6D8A);
  const fonts = [t.content.theme.majorFont, t.content.theme.minorFont];
  await run(t, 'pageLayout.theme', {name: 'graphite'});
  assert.deepEqual([t.content.theme.majorFont, t.content.theme.minorFont], fonts, 'GridCraft themes change the colours only');
  assert.equal(t.content.theme.colors[1], 0x111111);
  await run(t, 'pageLayout.theme', {name: 'Mine', colors: ['#FFFFFF', '000000', 'EEEEEE', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '0000FF', '800080'], majorFont: 'Georgia'});
  assert.equal(t.content.theme.name, 'Mine');
  assert.equal(t.content.theme.colors[3], 0x111111);
  assert.equal(t.content.theme.majorFont, 'Georgia');
  await fails(t, 'pageLayout.theme', {name: 'Nope'});
  const tiles = t.state('pageLayout.theme').value;
  assert.deepEqual(tiles.slice(0, 7).map(x => x.label), ['Craft', 'Slate', 'Meadow', 'Ember', 'Ocean', 'Orchid', 'Graphite']);
});

test('arrange: the selection pane lists the stack, align and group move objects together, rotate swaps width and height', async () => {
  const t = await session(data());
  await run(t, 'insert.shape', {kind: 'rectangle', at: 'D2', width: 100, height: 40});
  await run(t, 'insert.shape', {kind: 'ellipse', at: 'F6', width: 60, height: 80});
  await run(t, 'insert.shape', {kind: 'triangle', at: 'H3', width: 20, height: 20});
  const [a, b, c] = sheet(t).shapes.map(x => x.id);
  const list = await run(t, 'arrange.selectionPane', {list: true});
  assert.deepEqual(list.map(x => [x.kind, x.id, x.at]), [['shape', a, 'D2'], ['shape', b, 'F6'], ['shape', c, 'H3']]);
  const rect = o => ({x: o.x, y: o.y, w: o.w, h: o.h});
  const geo = async id => { const {objectRect} = await import('../../core/grid/lib/objects.mjs'); return rect(objectRect(sheet(t), sheet(t).shapes.find(s => s.id === id).anchor)); };
  const before = [await geo(a), await geo(b), await geo(c)];
  await run(t, 'arrange.align', {kind: 'shape', ids: [a, b], align: 'right'});
  const [ra, rb, rc] = [await geo(a), await geo(b), await geo(c)];
  assert.equal(ra.x + ra.w, rb.x + rb.w, 'the right edges line up');
  assert.deepEqual(rc, before[2], 'objects not named stay');
  assert.deepEqual([ra.w, ra.h, rb.w, rb.h], [100, 40, 60, 80], 'sizes stay');
  await run(t, 'arrange.align', {kind: 'shape', ids: [a, b, c], align: 'middle'});
  const mid = [await geo(a), await geo(b), await geo(c)].map(g => g.y + g.h / 2);
  assert.ok(Math.abs(mid[0] - mid[1]) < 1.5 && Math.abs(mid[1] - mid[2]) < 1.5, 'the vertical middles line up');
  await run(t, 'arrange.group', {kind: 'shape', ids: [a, b]});
  assert.equal((await geo(a)).x, (await geo(b)).x, 'group lines the left edges up, as gridcraft does');
  assert.equal(sheet(t).shapes.find(x => x.id === a).group, sheet(t).shapes.find(x => x.id === b).group, 'and keeps them as one group');
  const one = await run(t, 'arrange.align', {kind: 'shape', ids: [a], align: 'left'});
  assert.equal(one, null, 'fewer than two objects do nothing');
  await run(t, 'object.select', {kind: 'shape', id: a});
  assert.deepEqual(await run(t, 'arrange.rotate', {}), {id: a, width: 40, height: 100});
  assert.deepEqual(await run(t, 'arrange.rotate', {id: b}), {id: b, width: 80, height: 60});
  // gridcraft rejects `flip` (shapes have no flip state); Excel flips, so ours mirrors the shape.
  await run(t, 'arrange.rotate', {flip: 'horizontal'});
  assert.equal(sheet(t).shapes.find(x => x.id === a).flipH, true);
  await fails(t, 'arrange.rotate', {flip: 'sideways'});
  await fails(t, 'arrange.rotate', {id: 999});
});
