// U:prism/table: a table's style, options, cell fills, borders, margins, anchor, text direction, merges and
// the style definitions of a file survive File > Save and File > Open as a .pptx (a:tbl, a:tblPr,
// a:tableStyleId, a:tcPr, ppt/tableStyles.xml).
//
// 1. What ArtCraft does: deckcraft pptx tables.rs / read/shapes.rs / write/shapes.rs. PowerPoint writes
//    and reads the same elements.
// 2. Ours: core/prism/formats/pptx-write.mjs / pptx-read.mjs; the table commands made the deck.
// 3. Proved here through the format worker's contract (electron/formats-v2.cjs), no Electron.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createFile} from '../../core/model.mjs';
import {withNew, curSlide} from './upstream/text_deck.mjs';
import table from '../../core/prism/commands/table.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import {ctxForSlide} from '../../core/prism/model/resolve.mjs';
import {lookOf} from '../../core/prism/model/table-style.mjs';
import {bodyText} from '../../core/prism/model/text.mjs';

const require = createRequire(import.meta.url);
const {exportFile, importFile} = require('../../electron/formats-v2.cjs');

async function roundTrip(content) {
  const file = createFile('prism', 'Tables', {schema: 2});
  file.content = content;
  const bytes = await exportFile(file, 'pptx');
  return {bytes, back: (await importFile(bytes, 'pptx', {title: 'Tables', kind: 'prism', newHost: true})).content};
}

test('a table edited through the commands comes back from a .pptx as it was', async () => {
  const t = await withNew({extra: [table, insert]});
  const id = (await t.exec('insert.table', {rows: 3, cols: 3, rect: [60, 100, 450, 120], data: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]})).result.id;
  await t.exec('table.style', {id, style: 'dark1-accent4'});
  await t.exec('table.options', {id, totalRow: true, firstColumn: true, bandedColumns: true});
  await t.exec('table.selectCells', {id, from: [1, 1], to: [1, 2]});
  await t.exec('table.merge', {});
  await t.exec('table.cellFill', {color: '#336699', cells: [[0, 0]]});
  await t.exec('table.cellMargins', {left: 20, right: 2, top: 1, bottom: 9, cells: [[2, 0]]});
  await t.exec('table.cellAlign', {anchor: 'bottom', cells: [[2, 0]]});
  await t.exec('table.textDirection', {dir: 'rotate270', cells: [[2, 1]]});
  await t.exec('table.pen', {weight: 3, dash: 'dash', color: '#ff0000'});
  await t.exec('table.borders', {which: 'outside', cells: [[0, 1]]});
  await t.exec('table.borders', {which: 'diagDown', cells: [[2, 2]]});
  await t.exec('table.background', {color: '#eeeeee'});
  await t.exec('table.columnWidth', {id, col: 0, width: 90});
  const was = curSlide(t).shapes.find(s => s.id === id).kind;
  const {back, bytes} = await roundTrip(t.content);
  const got = back.slides[0].shapes.find(s => s.kind?.type === 'table').kind;
  assert.equal(got.style, 'dark1-accent4');
  assert.deepEqual([got.firstRow, got.firstCol, got.lastRow, got.lastCol, got.bandRow, got.bandCol], [was.firstRow, was.firstCol, was.lastRow, was.lastCol, was.bandRow, was.bandCol]);
  assert.deepEqual(got.cols.map(c => Math.round(c * 100) / 100), was.cols.map(c => Math.round(c * 100) / 100));
  assert.deepEqual([got.rows[1].cells[1].gridSpan, got.rows[1].cells[2].hMerge], [2, true]);
  assert.equal(got.rows[0].cells[0].fill.kind, 'solid');
  assert.deepEqual(got.rows[2].cells[0].margins, [20, 2, 1, 9]);
  assert.equal(got.rows[2].cells[0].anchor, 'bottom');
  assert.equal(got.rows[2].cells[1].vertical, 'vertical270');
  const top = got.rows[0].cells[1].borders[2];
  assert.equal(top.width, 3);
  assert.deepEqual(top.dash, {kind: 'preset', name: 'dash'});
  assert.ok(got.rows[2].cells[2].diagDown);
  assert.equal(got.background.kind, 'solid');
  assert.equal(bodyText(got.rows[2].cells[2].text), 'i');
  // The style is a definition in the package: PowerPoint draws it as we do.
  const zip = Buffer.from(bytes).toString('latin1');
  assert.ok(zip.includes('ppt/tableStyles.xml'));
  // The look comes out the same on both sides (the same style, the same theme).
  const was0 = lookOf(ctxForSlide(t.content, curSlide(t)), was, 0, 0);
  const got0 = lookOf(ctxForSlide(back, back.slides[0]), got, 0, 0);
  assert.deepEqual(got0.fill, was0.fill);
});

test('a style a file defines is kept and drawn; a table of every built-in style comes back as the same style', async () => {
  const t = await withNew({extra: [table, insert]});
  const ids = [];
  for (const style of ['none', 'grid', 'light1-tx1', 'light2-accent5', 'medium2-accent3', 'medium4-accent6', 'dark1-accent2']) {
    const id = (await t.exec('insert.table', {rows: 2, cols: 2})).result.id;
    await t.exec('table.style', {id, style});
    ids.push([id, style]);
  }
  const {back} = await roundTrip(t.content);
  const tables = back.slides[0].shapes.filter(s => s.kind?.type === 'table').map(s => s.kind.style);
  assert.deepEqual(tables, ids.map(x => x[1]));
  // Written again: the same.
  const second = await roundTrip(back);
  assert.deepEqual(second.back.slides[0].shapes.filter(s => s.kind?.type === 'table').map(s => s.kind.style), tables);
  assert.ok(back.tableStyles.length >= 5, 'the styles are definitions in the file');
  // A style of the file is in the gallery and applies.
  const def = back.tableStyles[0];
  const t2 = await withNew({extra: [table, insert]});
  t2.session.get(t2.docId).file.content.tableStyles = [def];
  const id2 = (await t2.exec('insert.table', {rows: 2, cols: 2})).result.id;
  await t2.exec('table.style', {id: id2, style: def.id.toLowerCase()});
  assert.equal(curSlide(t2).shapes.find(s => s.id === id2).kind.style, def.id);
  assert.ok((await t2.state('table.style', {id: id2})).value.some(g => g.id === def.id && g.selected));
});
