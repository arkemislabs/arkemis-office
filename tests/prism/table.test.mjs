// U:prism/table: the Table Design and Table Layout tabs on schema-2 presentations.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/cmd/table.rs (rows and columns, merge, split,
//    style and its options, cell fill, borders, margins, alignment, sizes, selecting cells),
//    drawtable.rs (the pencil and the eraser), render/src/table.rs (the look of a cell from its
//    table style) and ribbon/table.rs. PowerPoint: Table Design / Layout do the same on the cells
//    that are selected, with the options as check boxes and the styles as a drawn gallery.
// 2. Ours: the same commands over the kernel; a range of cells is a selection range of two cell
//    addresses; every edit is one undo step; the style look is computed from the theme.
// 3. Proved by these tests, tests/prism/upstream/model_tests.test.mjs (the model) and the bridge E2E
//    tests/e2e/prism/table.e2e.mjs (the ribbon on a real surface, with captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {withNew, curSlide} from './upstream/text_deck.mjs';
import table from '../../core/prism/commands/table.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import tool from '../../core/prism/commands/tool.mjs';
import {cellSelection, cellBlock, tableFrame} from '../../core/prism/lib/table-sel.mjs';
import {lookOf, styleArt, rowHeights, cellRects} from '../../core/prism/model/table-style.mjs';
import {ctxForSlide, xfrm as resolveXfrm} from '../../core/prism/model/resolve.mjs';
import {drawLine, eraseAt, splitCell} from '../../core/prism/model/table-draw.mjs';
import {newTable} from '../../core/prism/model/table.mjs';
import {bodyText} from '../../core/prism/model/text.mjs';
import {textSelection} from '../../core/prism/model/doc.mjs';
import {planKey, planTyping} from '../../core/prism/lib/keys.mjs';
import splitDialog from '../../core/prism/dialogs/splitCells.mjs';
import marginsDialog from '../../core/prism/dialogs/cellMargins.mjs';

const mk = () => withNew({extra: [table, insert, tool]});
const grid = t => t.rows.map(r => r.cells.map(c => (c.hMerge || c.vMerge ? '.' : c.gridSpan > 1 || c.rowSpan > 1 ? 'M' : 'o')).join('')).join('/');
const tableOf = t => curSlide(t).shapes.find(s => s.kind?.type === 'table');

async function withTable(rows = 3, cols = 3, data) {
  const t = await mk();
  const r = await t.exec('insert.table', {rows, cols, rect: [100, 100, cols * 100, rows * 40], data});
  return {t, id: r.result.id};
}

test('rows and columns: insert above and below, left and right, delete; the shape follows the table; one undo each', async () => {
  const {t, id} = await withTable(3, 3);
  await expectUndoRoundTrip(t, 'table.insertRowAbove', {id, row: 1}, after => {
    const tb = after.content.slides[0].shapes.find(s => s.id === id);
    assert.equal(tb.kind.rows.length, 4);
    assert.equal(tb.xfrm.h, 160);
  });
  await t.exec('table.insertRowBelow', {id, row: 3});
  await t.exec('table.insertColumnLeft', {id, col: 0});
  await t.exec('table.insertColumnRight', {id, col: 3});
  assert.deepEqual([tableOf(t).kind.rows.length, tableOf(t).kind.cols.length], [5, 5]);
  assert.equal(tableOf(t).xfrm.w, 500);
  await t.exec('table.deleteRow', {id, row: 0});
  await t.exec('table.deleteColumn', {id, col: 0});
  assert.deepEqual([tableOf(t).kind.rows.length, tableOf(t).kind.cols.length], [4, 4]);
  const one = await withTable(1, 1);
  await assert.rejects(one.t.exec('table.deleteRow', {id: one.id}), /can't delete the last row/);
  await assert.rejects(one.t.exec('table.deleteColumn', {id: one.id}), /can't delete the last column/);
  await assert.rejects(t.exec('table.insertRowAbove', {id: '999'}), /select a table/);
});

test('the caret\'s cell decides where a row goes; a range of cells is a selection of two cell addresses', async () => {
  const {t, id} = await withTable(3, 3, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
  await t.exec('text.edit', {id, cell: [2, 1]});
  await t.exec('table.insertRowAbove', {});
  const rows = tableOf(t).kind.rows;
  assert.equal(rows.length, 4);
  assert.equal(bodyText(rows[2].cells[1].text), '', 'the new row is above row 2');
  assert.equal(bodyText(rows[3].cells[1].text), 'h');
  await t.exec('table.selectCells', {id, from: [0, 0], to: [1, 1]});
  const cs = cellSelection(t.content, t.doc.selection);
  assert.deepEqual([cs.shape, cs.from, cs.to], [id, [0, 0], [1, 1]]);
  assert.equal(t.doc.selection.ranges[0].anchor, `/sl:${curSlide(t).id}/sp:${id}/r:0/c:0`);
  await t.exec('table.selectCells', {id, mode: 'column'});
  assert.deepEqual([cellSelection(t.content, t.doc.selection).from, cellSelection(t.content, t.doc.selection).to], [[0, 0], [3, 0]]);
  await t.exec('table.selectCells', {id, mode: 'table'});
  assert.deepEqual(cellSelection(t.content, t.doc.selection).to, [3, 2]);
});

test('merge and split: the selected cells, the grown block, text kept, the dialog\'s columns and rows', async () => {
  const {t, id} = await withTable(3, 3, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
  await assert.rejects(t.exec('table.merge', {id}), /select two or more cells/);
  await t.exec('table.selectCells', {id, from: [0, 0], to: [1, 1]});
  await expectUndoRoundTrip(t, 'table.merge', {}, after => {
    assert.equal(grid(after.content.slides[0].shapes.find(s => s.id === id).kind), 'M.o/..o/ooo');
  });
  assert.equal(bodyText(tableOf(t).kind.rows[0].cells[0].text), 'a\nb\nd\ne');
  // The merged cell is the selection afterwards.
  assert.deepEqual(cellSelection(t.content, t.doc.selection).from, [0, 0]);
  await t.exec('table.split', {id, cell: [0, 0]});
  assert.equal(grid(tableOf(t).kind), 'ooo/ooo/ooo');
  await assert.rejects(t.exec('table.split', {id, cell: [0, 0]}), /isn't merged/);
  // Split Cells (columns x rows): the other rows' cells widen over the new column.
  await t.exec('table.split', {id, cell: [0, 0], cols: 2, rows: 2});
  const tb = tableOf(t).kind;
  assert.equal(tb.cols.length, 4);
  assert.equal(tb.rows.length, 4);
  assert.deepEqual(tb.cols.slice(0, 2), [50, 50]);
  assert.equal(tb.rows[2].cells[0].gridSpan, 2, 'a cell of another row now spans the two new columns');
  assert.equal(Math.round(tb.cols.reduce((a, b) => a + b, 0)), 300, 'the table keeps its width');
  // A merged cell split into the columns and rows it spans just comes apart.
  await t.exec('table.merge', {id, from: [2, 2], to: [3, 3]});
  assert.equal(tableOf(t).kind.rows[2].cells[2].rowSpan, 2);
  await t.exec('table.split', {id, cell: [2, 2], cols: 2, rows: 2});
  assert.ok(tableOf(t).kind.rows[2].cells.slice(2).every(c => !c.hMerge && !c.vMerge && c.gridSpan === 1 && c.rowSpan === 1));
});

test('merge is disabled until two cells are selected; split opens its dialog with the spans of a merged cell', async () => {
  const {t, id} = await withTable(2, 2);
  const state = (cmd, p) => t.state(cmd, p);
  assert.equal((await state('table.merge')).enabled, false);
  await t.exec('table.selectCells', {id, from: [0, 0], to: [0, 1]});
  assert.equal((await state('table.merge')).enabled, true);
  await t.exec('table.merge', {});
  const init = splitDialog.init({doc: t.content, selection: t.doc.selection});
  assert.deepEqual(init, {cols: 2, rows: 1});
  assert.deepEqual(splitDialog.toCommand({cols: 3, rows: '2'}), {command: 'table.split', params: {cols: 3, rows: 2}});
  assert.equal(splitDialog.validate({cols: 0, rows: 1}).length, 1);
  await t.exec('table.selectCells', {id, from: [1, 1], to: [1, 1]});
  assert.deepEqual(splitDialog.init({doc: t.content, selection: t.doc.selection}), {cols: 2, rows: 1});
});

test('table.style and table.options: the built-in styles, the options as check boxes (toggle), unknown styles refused', async () => {
  const {t, id} = await withTable(3, 3);
  await expectUndoRoundTrip(t, 'table.style', {style: 'dark1-accent3'}, after => {
    assert.equal(after.content.slides[0].shapes.find(s => s.id === id).kind.style, 'dark1-accent3');
  });
  await assert.rejects(t.exec('table.style', {style: 'nope'}), /unknown table style/);
  await t.exec('table.options', {toggle: 'totalRow'});
  assert.equal(tableOf(t).kind.lastRow, true);
  await t.exec('table.options', {toggle: 'totalRow'});
  assert.equal(tableOf(t).kind.lastRow, false);
  await t.exec('table.options', {headerRow: false, firstColumn: true, bandedRows: false, lastColumn: true, bandedColumns: true});
  const k = tableOf(t).kind;
  assert.deepEqual([k.firstRow, k.firstCol, k.bandRow, k.lastCol, k.bandCol], [false, true, false, true, true]);
  // A check box reads its state.
  const st = await t.state('table.options', {toggle: 'firstColumn'});
  assert.equal(st.checked, true);
  assert.equal((await t.state('table.options', {toggle: 'headerRow'})).checked, false);
  // The gallery: every built-in style drawn, the current one selected.
  await t.exec('table.style', {style: 'light2-accent4'});
  const gal = (await t.state('table.style')).value;
  assert.equal(gal.length, 2 + 5 * 7);
  assert.equal(gal.filter(g => g.selected).length, 1);
  assert.equal(gal.find(g => g.selected).id, 'light2-accent4');
  assert.ok(gal.every(g => g.art.kind === 'tablestyle' && g.art.cells.length === 12));
  assert.equal(gal.filter(g => g.inline).length, 8);
  const none = gal.find(g => g.id === 'none');
  assert.ok(none.art.cells.every(c => c.fill === null));
  // Not enabled without a table.
  const empty = await mk();
  assert.equal((await empty.state('table.style')).enabled, false);
});

test('the look of a cell from its style: header, bands, first and last columns, the total row; a style the file defines', async () => {
  const {t, id} = await withTable(4, 3);
  const sl = curSlide(t);
  const rc = ctxForSlide(t.content, sl);
  const tb = {...tableOf(t).kind, style: 'medium2-accent1', firstRow: true, bandRow: true};
  const head = lookOf(rc, tb, 0, 0), b1 = lookOf(rc, tb, 1, 0), b2 = lookOf(rc, tb, 2, 0);
  assert.equal(head.bold, true);
  assert.deepEqual(head.text, {r: 255, g: 255, b: 255, a: 255});
  assert.notDeepEqual(b1.fill, b2.fill, 'banded rows alternate');
  assert.equal(b1.bold, false);
  assert.deepEqual(lookOf(rc, {...tb, style: 'none'}, 1, 1).fill, null);
  assert.deepEqual(lookOf(rc, {...tb, style: 'dark1-accent1'}, 0, 0).fill, {r: 0, g: 0, b: 0, a: 255});
  const total = lookOf(rc, {...tb, lastRow: true}, 3, 1);
  assert.equal(total.bold, true);
  assert.equal(lookOf(rc, {...tb, firstCol: true}, 2, 0).bold, true);
  // A style the file defines wins over the built-in ones, part by part.
  const def = {id: '{AAAA}', name: 'Mine', parts: [['wholeTbl', {fill: null, fillRef: null, borders: [null, null, null, null, null, null], textColor: null, bold: null, italic: null}],
    ['firstRow', {fill: {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 1, g: 2, b: 3, a: 255}}}}, fillRef: null, borders: [null, null, {kind: 'line', line: {fill: {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 9, g: 9, b: 9, a: 255}}}}, width: 3}}, null, null, null],
      textColor: {base: {kind: 'rgb', rgb: {r: 7, g: 7, b: 7, a: 255}}}, bold: true, italic: null}]], background: null, raw: ''};
  const rc2 = ctxForSlide({...t.content, tableStyles: [def]}, sl);
  const l = lookOf(rc2, {...tb, style: '{aaaa}'}, 0, 1);
  assert.deepEqual(l.fill, {r: 1, g: 2, b: 3, a: 255});
  assert.equal(l.bold, true);
  assert.deepEqual(l.sides[2], [{r: 9, g: 9, b: 9, a: 255}, 3]);
  assert.equal(lookOf(rc2, {...tb, style: '{aaaa}'}, 1, 1).fill, null);
  const art = styleArt(rc2, '{AAAA}', {}, def);
  assert.equal(art.cells[0].fill, 'rgb(1,2,3)');
});

test('table.cellFill and table.background: the selected cells, a range grown over merges, no fill, the caret\'s cell', async () => {
  const {t, id} = await withTable(3, 3);
  await t.exec('table.selectCells', {id, from: [0, 0], to: [1, 1]});
  await expectUndoRoundTrip(t, 'table.cellFill', {color: '#336699'}, after => {
    const rows = after.content.slides[0].shapes.find(s => s.id === id).kind.rows;
    assert.equal(rows[1].cells[1].fill.kind, 'solid');
    assert.equal(rows[2].cells[1].fill, null);
  });
  assert.equal((await t.state('table.cellFill')).value, '#336699');
  await t.exec('table.cellFill', {none: true, cells: [[2, 2]]});
  assert.equal(tableOf(t).kind.rows[2].cells[2].fill.kind, 'none');
  await t.exec('table.cellFill', {color: 'auto'});
  assert.equal(tableOf(t).kind.rows[0].cells[0].fill.kind, 'none');
  await assert.rejects(t.exec('table.cellFill', {color: 'not a colour'}), /invalid `color`/);
  await t.exec('text.edit', {id, cell: [2, 0]});
  await t.exec('table.cellFill', {color: 'accent2'});
  assert.equal(tableOf(t).kind.rows[2].cells[0].fill.color.base.slot, 'accent2');
  assert.equal(tableOf(t).kind.rows[2].cells[1].fill, null);
  await t.exec('table.background', {color: '#ff0000'});
  assert.equal(tableOf(t).kind.background.kind, 'solid');
  await t.exec('table.background', {none: true});
  assert.equal(tableOf(t).kind.background, undefined);
});

test('table.borders: all, outside, inside, one side, diagonals, none; the facing side of the neighbour; the pen', async () => {
  const {t, id} = await withTable(3, 3);
  await t.exec('table.selectCells', {id, from: [1, 1], to: [1, 1]});
  await expectUndoRoundTrip(t, 'table.borders', {which: 'outside', width: 3, color: '#ff0000'}, after => {
    const rows = after.content.slides[0].shapes.find(s => s.id === id).kind.rows;
    assert.equal(rows[1].cells[1].borders[0].width, 3);
    assert.equal(rows[1].cells[0].borders[1].width, 3, 'the left neighbour\'s right side');
    assert.equal(rows[0].cells[1].borders[3].width, 3, 'the cell above\'s bottom');
  });
  await t.exec('table.selectCells', {id, from: [0, 0], to: [2, 2]});
  await t.exec('table.borders', {which: 'inside', width: 2});
  const rows = tableOf(t).kind.rows;
  assert.equal(rows[0].cells[0].borders[0], null, 'the table\'s outer left stays as it was');
  assert.equal(rows[0].cells[0].borders[1].width, 2);
  assert.equal(rows[1].cells[1].borders[2].width, 2);
  await t.exec('table.borders', {which: 'diagDown', cells: [[0, 0]]});
  assert.ok(tableOf(t).kind.rows[0].cells[0].diagDown);
  assert.equal(tableOf(t).kind.rows[0].cells[0].diagUp, null);
  await t.exec('table.borders', {which: 'none'});
  const c = tableOf(t).kind.rows[1].cells[1];
  assert.equal(c.borders[0].fill.kind, 'none');
  assert.equal(tableOf(t).kind.rows[0].cells[0].diagDown, null);
  await assert.rejects(t.exec('table.borders', {which: 'sideways'}), /which must be one of/);
  // The pen: Borders draws with it when no colour, weight or dash is given.
  await t.exec('table.pen', {weight: 4.5});
  await t.exec('table.pen', {dash: 'sysDot'});
  await t.exec('table.pen', {color: '#00ff00'});
  assert.equal((await t.state('table.pen', {weight: 4.5})).checked, true);
  assert.equal((await t.state('table.pen', {weight: 1})).checked, false);
  assert.equal((await t.state('table.pen', {dash: 'sysDot'})).checked, true);
  await t.exec('table.borders', {which: 'top', cells: [[1, 1]]});
  const top = tableOf(t).kind.rows[1].cells[1].borders[2];
  assert.equal(top.width, 4.5);
  assert.deepEqual(top.dash, {kind: 'preset', name: 'sysDot'});
  assert.equal(top.fill.color.base.rgb.g, 255);
});

test('cell margins, vertical and horizontal alignment, text direction; the dialog', async () => {
  const {t, id} = await withTable(2, 2, [['a', 'b'], ['c', 'd']]);
  await t.exec('table.selectCells', {id, from: [0, 0], to: [0, 1]});
  await expectUndoRoundTrip(t, 'table.cellMargins', {preset: 'wide'}, after => {
    assert.deepEqual(after.content.slides[0].shapes.find(s => s.id === id).kind.rows[0].cells[1].margins, [14.4, 14.4, 14.4, 14.4]);
  });
  assert.equal(tableOf(t).kind.rows[1].cells[0].margins, null);
  await t.exec('table.cellMargins', {preset: 'none'});
  assert.deepEqual(tableOf(t).kind.rows[0].cells[0].margins, [0, 0, 0, 0]);
  await t.exec('table.cellMargins', {preset: 'normal'});
  assert.deepEqual(tableOf(t).kind.rows[0].cells[0].margins, [7.2, 7.2, 3.6, 3.6]);
  await t.exec('table.cellMargins', {left: 20, top: 1});
  assert.deepEqual(tableOf(t).kind.rows[0].cells[1].margins, [20, 7.2, 1, 3.6]);
  await assert.rejects(t.exec('table.cellMargins', {preset: 'huge'}), /preset must be one of/);
  await t.exec('table.cellAlign', {anchor: 'bottom'});
  assert.equal(tableOf(t).kind.rows[0].cells[0].anchor, 'bottom');
  assert.equal(tableOf(t).kind.rows[1].cells[0].anchor, null);
  assert.equal((await t.state('table.cellAlign', {anchor: 'bottom'})).checked, true);
  assert.equal((await t.state('table.cellAlign', {anchor: 'top'})).checked, false);
  await t.exec('table.cellAlign', {align: 'center'});
  assert.equal(tableOf(t).kind.rows[0].cells[0].text.paragraphs[0].props.align, 'center');
  assert.equal(tableOf(t).kind.rows[0].cells[0].anchor, 'bottom', 'align alone leaves the vertical anchor');
  await assert.rejects(t.exec('table.cellAlign', {anchor: 5}), /anchor must be a string/);
  await t.exec('table.textDirection', {dir: 'rotate270'});
  assert.equal(tableOf(t).kind.rows[0].cells[0].vertical, 'vertical270');
  assert.equal((await t.state('table.textDirection', {dir: 'rotate270'})).checked, true);
  await t.exec('table.textDirection', {dir: 'horizontal'});
  assert.equal(tableOf(t).kind.rows[0].cells[0].vertical, null);
  // The Cell Text Layout dialog.
  const v = marginsDialog.init({doc: t.content, selection: t.doc.selection});
  assert.deepEqual(v, {anchor: 'bottom', direction: 'horizontal', left: 0.28, right: 0.1, top: 0.01, bottom: 0.05});
  const cmd = marginsDialog.toCommand({...v, left: 0.5, direction: 'stacked'});
  assert.equal(cmd.params.left, 36);
  assert.equal(cmd.params.direction, 'stacked');
  assert.equal(marginsDialog.validate({...v, top: -1}).length, 1);
  await t.exec(cmd.command, cmd.params);
  assert.deepEqual([tableOf(t).kind.rows[0].cells[0].margins[0], tableOf(t).kind.rows[0].cells[0].vertical], [36, 'stacked']);
});

test('sizes: distribute, column width (keeping the total), row height, Table Size scales the table, lock aspect ratio', async () => {
  const {t, id} = await withTable(3, 3);
  await t.exec('table.columnWidth', {id, col: 0, width: 50});
  await t.exec('table.rowHeight', {id, row: 1, height: 10});
  assert.deepEqual(tableOf(t).kind.cols, [50, 100, 100]);
  assert.equal(tableOf(t).xfrm.w, 250);
  await t.exec('table.distributeColumns', {id});
  await t.exec('table.distributeRows', {id});
  assert.ok(tableOf(t).kind.cols.every(c => Math.abs(c - 250 / 3) < 1e-9));
  assert.ok(tableOf(t).kind.rows.every(r => Math.abs(r.height - 30) < 1e-9), 'rows 40, 10, 40 share their 90 pt');
  await t.exec('table.columnWidth', {id, col: 0, width: 150, keepTotal: true});
  const cols = tableOf(t).kind.cols;
  assert.equal(cols[0], 150);
  assert.ok(Math.abs(cols.reduce((a, b) => a + b, 0) - 250) < 1e-9);
  await t.exec('table.selectCells', {id, from: [2, 1], to: [2, 1]});
  assert.equal((await t.state('table.rowHeight')).value, 30);
  assert.equal((await t.state('table.columnWidth')).value, Math.round(cols[1] * 10) / 10);
  await assert.rejects(t.exec('table.columnWidth', {id, col: 0}), /width is required/);
  // Table Size.
  await t.exec('table.size', {id, w: 500});
  assert.equal(tableOf(t).xfrm.w, 500);
  assert.ok(Math.abs(tableOf(t).kind.rows.reduce((a, r) => a + r.height, 0) - 90) < 1e-9, 'the height is untouched without the lock');
  await t.exec('table.lockAspect', {});
  assert.equal((await t.state('table.lockAspect')).checked, true);
  await t.exec('table.size', {id, h: 220});
  assert.ok(Math.abs(tableOf(t).xfrm.w - 500 * 220 / 90) < 1e-6, 'the width follows the height when the aspect is locked');
  assert.equal((await t.state('table.size', {dim: 'width'})).value, Math.round(500 * 220 / 90 * 10) / 10);
  assert.equal((await t.state('table.size', {dim: 'height'})).value, 220);
  await expectUndoRoundTrip(t, 'table.size', {id, h: 110, lockAspect: false}, after => {
    assert.ok(Math.abs(after.content.slides[0].shapes.find(s => s.id === id).xfrm.h - 110) < 1e-9);
  });
});

test('Draw Table and Table Eraser: the pencil splits only the cells it crosses, the eraser merges across a border', async () => {
  const {t, id} = await withTable(1, 1);
  await t.exec('table.size', {id, w: 300, h: 100});
  // The table sits at (100, 100): a line across at y = 140 adds a row 40 tall.
  await expectUndoRoundTrip(t, 'table.drawLine', {from: [100, 140], to: [400, 140]}, after => {
    assert.equal(after.content.slides[0].shapes.find(s => s.id === id).kind.rows.length, 2);
  });
  assert.deepEqual(tableOf(t).kind.rows.map(r => r.height), [40, 60]);
  await t.exec('table.drawLine', {from: [220, 140], to: [220, 200]});
  assert.equal(grid(tableOf(t).kind), 'M./oo');
  await assert.rejects(t.exec('table.drawLine', {from: [100, 101], to: [400, 101]}), /doesn't divide any cell/);
  await assert.rejects(t.exec('table.drawLine', {from: [10, 10], to: [20, 10]}), /no table there/);
  await t.exec('table.eraseLine', {at: [220, 170], tol: 5});
  assert.equal(grid(tableOf(t).kind), 'M./M.');
  await assert.rejects(t.exec('table.eraseLine', {at: [150, 150]}), /no border to erase/);
  // The two tools are the same toggles as the ribbon's.
  await t.exec('tool.drawTable', {});
  assert.equal(t.doc.view.tool.preset, 'drawTable');
  await t.exec('tool.tableEraser', {});
  assert.equal(t.doc.view.tool.preset, 'tableEraser');
});

test('the pencil and the eraser as pure operations; the cap on the grid', () => {
  let tb = newTable(1, 1, 300, 100);
  tb = drawLine(tb, [0, 40], [300, 40]);
  tb = drawLine(tb, [120, 40], [120, 100]);
  assert.equal(grid(tb), 'M./oo');
  assert.deepEqual(tb.cols, [120, 180]);
  tb = drawLine(tb, [120, 0], [120, 40]);
  assert.equal(grid(tb), 'oo/oo');
  assert.equal(drawLine(tb, [0, 1], [300, 1]), null, 'on the outer border');
  assert.equal(drawLine(tb, [NaN, 1], [300, 1]), null);
  const two = newTable(2, 2, 200, 50);
  two.rows[0].cells[0].text = {body: {}, paragraphs: [{level: 0, runs: [{text: 'A'}]}]};
  two.rows[0].cells[1].text = {body: {}, paragraphs: [{level: 0, runs: [{text: 'B'}]}]};
  const merged = eraseAt(two, [100, 25], 5);
  assert.equal(grid(merged), 'M./oo');
  assert.equal(merged.rows[0].cells[0].text.paragraphs.length, 2);
  assert.equal(eraseAt(two, [50, 75], 5), null);
  let big = newTable(1, 1, 300, 4000);
  let n = 0;
  for (let i = 1; i < 400; i++) { const o = drawLine(big, [0, i * 9.9], [300, i * 9.9]); if (o) { big = o; n++; } }
  assert.ok(big.rows.length <= 200 && n > 100);
  assert.equal(splitCell(newTable(2, 2, 100, 100), 0, 0, 1, 1), null);
});

test('cell blocks grow over merged cells; the table frame finds the cell and the draggable border at a point', async () => {
  const tb = newTable(3, 3, 300, 90);
  const m = structuredClone(tb);
  m.rows[0].cells[1].gridSpan = 2; m.rows[0].cells[2].hMerge = true;
  assert.deepEqual(cellBlock(m, [0, 0], [0, 1]), [[0, 0], [0, 2]]);
  assert.deepEqual(cellBlock(m, [1, 2], [0, 2]), [[1, 1], [0, 2]], 'grown over the merged cell, each corner on its own side');
  const heights = [30, 30, 30];
  const f = tableFrame(m, heights, p => p, p => p);
  assert.deepEqual(f.cellAt({x: 50, y: 10}), [0, 0]);
  assert.deepEqual(f.cellAt({x: 250, y: 10}), [0, 1], 'a merged cell answers for the columns it covers');
  assert.deepEqual(f.borderAt({x: 100, y: 45}, 3), {column: 0});
  assert.equal(f.borderAt({x: 200, y: 10}, 3), null, 'the border inside the merged cell is not shown');
  assert.deepEqual(f.borderAt({x: 50, y: 60}, 3), {row: 1});
  assert.equal(f.borderAt({x: 0, y: 45}, 3), null, 'the left edge moves the table');
  assert.equal(f.inCell({x: -5, y: 10}), false);
});

test('rows grow to fit their text: drawn heights, cell rectangles', async () => {
  const {t, id} = await withTable(2, 2, [['a'.repeat(400), 'b'], ['c', 'd']]);
  const sl = curSlide(t);
  const rc = ctxForSlide(t.content, sl);
  const sh = tableOf(t);
  const hs = rowHeights(rc, sh.kind, sh);
  assert.ok(hs[0] > 40, `row 0 grew to ${hs[0]}`);
  assert.equal(hs[1], 40);
  const rects = cellRects(sh.kind, hs);
  assert.equal(rects.length, 4);
  assert.equal(rects[2].y0, hs[0]);
  void id;
});

test('a table is needed: commands say so; a non-table shape is refused', async () => {
  const t = await mk();
  await assert.rejects(t.exec('table.merge', {from: [0, 0], to: [1, 1]}), /select a table|no such shape|table/);
  for (const c of ['table.insertRowAbove', 'table.style', 'table.cellFill']) assert.equal((await t.state(c, {style: 'none'})).enabled, false);
  const title = curSlide(t).shapes[0].id;
  await assert.rejects(t.exec('table.insertRowAbove', {id: title}), /not a table/);
});

test('keys on selected cells: Shift+arrow extends the range past merged cells, Delete clears their text, Enter and typing go into the first cell', async () => {
  const {t, id} = await withTable(3, 3, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
  const key = async (k, mods = {}) => {
    const plan = planKey(t.content, t.doc.selection, k, mods);
    assert.ok(plan.handled, `${k} is handled`);
    for (const st of plan.steps ?? []) await t.exec(st.command, st.params);
  };
  await t.exec('table.selectCells', {id, from: [0, 0], to: [0, 0]});
  await key('ArrowRight', {shift: true});
  await key('ArrowDown', {shift: true});
  assert.deepEqual([cellSelection(t.content, t.doc.selection).from, cellSelection(t.content, t.doc.selection).to], [[0, 0], [1, 1]]);
  await key('ArrowLeft', {shift: true});
  assert.deepEqual(cellSelection(t.content, t.doc.selection).to, [1, 0]);
  await key('ArrowLeft', {shift: true});
  assert.deepEqual(cellSelection(t.content, t.doc.selection).to, [1, 0], 'at the table\'s edge it stays');
  await expectUndoRoundTrip(t, 'table.clearCells', {}, after => {
    const rows = after.content.slides[0].shapes.find(s => s.id === id).kind.rows;
    assert.equal(bodyText(rows[0].cells[0].text), '');
    assert.equal(bodyText(rows[1].cells[0].text), '');
    assert.equal(bodyText(rows[0].cells[1].text), 'b', 'outside the range');
    assert.equal(bodyText(rows[2].cells[0].text), 'g');
  });
  await key('Enter');
  assert.deepEqual(textSelection(t.content, t.doc.selection).cell, [0, 0]);
  await t.exec('table.selectCells', {id, from: [1, 1], to: [2, 2]});
  const steps = planTyping(t.content, t.doc.selection, 'x');
  assert.deepEqual(steps.map(s => s.command), ['text.edit', 'text.selectAll', 'text.insert']);
  assert.deepEqual(steps[0].params.cell, [1, 1]);
  // A merged cell in the way: the range moves on until it changes.
  await t.exec('table.merge', {id, from: [0, 1], to: [0, 2]});
  await t.exec('table.selectCells', {id, from: [0, 0], to: [0, 0]});
  await t.exec('table.extendCells', {dr: 0, dc: 1});
  const cs = cellSelection(t.content, t.doc.selection);
  assert.deepEqual(cellBlock(tableOf(t).kind, cs.from, cs.to), [[0, 0], [0, 2]], 'the merged cell is taken in whole');
});

test('a table\'s box is as tall as its rows are drawn (rows grown to their text), so handles and hit tests match what is shown', async () => {
  const {t, id} = await withTable(2, 2, [['a'.repeat(300), 'b'], ['c', 'd']]);
  const sh = tableOf(t);
  const sl = curSlide(t);
  const rc = ctxForSlide(t.content, sl);
  const drawn = rowHeights(rc, sh.kind, sh).reduce((a, b) => a + b, 0);
  assert.ok(drawn > sh.xfrm.h, `drawn ${drawn} vs stored ${sh.xfrm.h}`);
  assert.equal(resolveXfrm(rc, sh).h, drawn, 'the box follows the drawn rows');
  assert.equal(sh.xfrm.h, 80, 'the stored box is the table\'s own');
  // A short table keeps its box (the very same object).
  const short = await withTable(2, 2, [['a', 'b'], ['c', 'd']]);
  const s2 = tableOf(short.t);
  assert.equal(resolveXfrm(ctxForSlide(short.t.content, curSlide(short.t)), s2), s2.xfrm);
  void id;
});

test('table.cellFill: gradient, pattern, picture and light and dark variations of the cell\'s own colour; the table background too', async () => {
  const {t, id} = await withTable(2, 2);
  await t.exec('table.selectCells', {id, from: [0, 0], to: [0, 1]});
  await t.exec('table.cellFill', {gradient: {stops: [[0, '#ff0000'], [1, '#0000ff']], kind: 'linear', angle: 0}});
  let k = tableOf(t).kind;
  assert.equal(k.rows[0].cells[0].fill.kind, 'gradient');
  assert.equal(k.rows[0].cells[0].fill.stops.length, 2);
  assert.equal(k.rows[1].cells[0].fill, null);
  await t.exec('table.cellFill', {pattern: {preset: 'dkUpDiag', fg: '#003366', bg: '#ffffff'}, cells: [[1, 0]]});
  assert.equal(tableOf(t).kind.rows[1].cells[0].fill.preset, 'dkUpDiag');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgAJPwF+4uP4SAAAAAASUVORK5CYII=';
  await expectUndoRoundTrip(t, 'table.cellFill', {picture: PNG, name: 'dot.png', cells: [[1, 1]]}, after => {
    const f = after.content.slides[0].shapes.find(s => s.id === id).kind.rows[1].cells[1].fill;
    assert.equal(f.kind, 'picture');
    assert.ok(after.content.media.some(m => m.id === f.media));
  });
  await t.exec('table.cellFill', {color: '#336699', cells: [[0, 1]]});
  await t.exec('table.cellFill', {variation: 'dark', angle: 270, cells: [[0, 1], [0, 0]]});
  k = tableOf(t).kind;
  const dark = k.rows[0].cells[1].fill;
  assert.deepEqual([dark.kind, dark.shape.angle, dark.stops[0].color.base.rgb.b], ['gradient', 270, 0x99]);
  assert.deepEqual(dark.stops[1].color.mods, [{op: 'shade', val: 50000}]);
  assert.equal(k.rows[0].cells[0].fill.stops[0].color.base.slot, 'accent1', 'a cell without a solid colour starts from accent 1');
  await t.exec('table.cellFill', {variation: 'light', cells: [[0, 1]]});
  assert.deepEqual(tableOf(t).kind.rows[0].cells[1].fill.stops[0].color.mods, [{op: 'tint', val: 40000}]);
  await t.exec('table.background', {gradient: {stops: [[0, '#fff'], [1, '#ccc']]}});
  assert.equal(tableOf(t).kind.background.kind, 'gradient');
});

test('the pencil leaves a split column at least 40 pt wide, and a cell too narrow to give two of them alone', () => {
  const cell = () => ({text: {body: {}, paragraphs: []}});
  const table = {type: 'table', cols: [200, 60], rows: [{height: 40, cells: [cell(), cell()]}, {height: 40, cells: [cell(), cell()]}], style: null};
  const out = drawLine(table, [20, 0], [20, 80]);   // 20 pt in from the left edge of the wide column
  assert.ok(out, 'the 200 pt column splits');
  assert.ok(out.cols.every(w => w >= 40), JSON.stringify(out.cols));
  assert.equal(drawLine(table, [230, 0], [230, 80]), null, 'a 60 pt column cannot give two 40 pt pieces');
});
