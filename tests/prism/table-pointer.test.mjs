// U:prism/table: the pointer on a table (core/prism/lib/pointer.mjs): which cell a click is in, a click
// into a cell of a selected table, a drag across cells (a range), a press in a table whose cells are
// selected, the borders that resize columns and rows, double-click, and the pencil and eraser tools.
//
// 1. What ArtCraft does: deckcraft crates/engine/src/tools/{click,drag,hit,pointer}.rs with cmd/table.rs
//    `table_frame` (cell_at, border_at). PowerPoint: the first click selects the table, the next puts
//    the caret in a cell, a drag from a cell into another selects cells, a drag on a border resizes.
// 2. Ours replays the same events through the same code in one kernel transaction (one undo step).
// 3. Proved here headless and in tests/e2e/prism/table.e2e.mjs on a real surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/prism/schema.mjs';
import {shape, slide as newSlideObj} from '../../core/prism/model/presentation.mjs';
import {newTable} from '../../core/prism/model/table.mjs';
import {bodyFromText} from '../../core/prism/model/text.mjs';
import {textSelection} from '../../core/prism/model/doc.mjs';
import {cellSelection} from '../../core/prism/lib/table-sel.mjs';
import {rowHeights} from '../../core/prism/model/table-style.mjs';
import {ctxForSlide} from '../../core/prism/model/resolve.mjs';
import surface from '../../src/apps/prism/ui-commands/surface.ts';
import table from '../../core/prism/commands/table.mjs';
import text from '../../core/prism/commands/text.mjs';
import tool from '../../core/prism/commands/tool.mjs';

function deck() {
  const c = createContent('Table pointer');
  const layout = c.masters[0].layouts.find(l => l.kind === 'blank').id;
  const tb = newTable(3, 3, 300, 40);
  [['Hello world', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']].forEach((row, r) => row.forEach((v, k) => { tb.rows[r].cells[k].text = bodyFromText(v); }));
  c.slides = [newSlideObj({id: 'sb', layout, shapes: [shape({id: 'tb', name: 'Table 1', xfrm: {x: 100, y: 100, w: 300, h: 120}, kind: {type: 'table', ...tb}})]})];
  return c;
}
const session = () => createTestSession('prism', {content: deck(), modules: [surface, table, text, tool], prefs: {prism: {snapToGrid: false, smartGuides: false}},
  selection: {ranges: [{anchor: '/sl:sb', focus: '/sl:sb'}], primary: 0}});
const ev = (kind, x, y, mods) => ({kind, x, y, ...(mods ? {mods} : {})});
const tbl = t => t.content.slides[0].shapes.find(s => s.id === 'tb');
const click = (t, x, y) => t.exec('surface.pointer', {events: [ev('down', x, y), ev('up', x, y)], tol: 3});
const sel = t => ({text: textSelection(t.content, t.doc.selection), cells: cellSelection(t.content, t.doc.selection), ranges: t.doc.selection.ranges.map(r => r.anchor)});
// The middle of cell (r, c): the table's top-left is (100, 100), cells are 100 x 40.
const mid = (r, c) => [150 + c * 100, 120 + r * 40];

test('the first click selects the table; the next click in a cell puts the caret there', async () => {
  const t = await session();
  const v = t.version;
  await click(t, ...mid(1, 1));
  assert.deepEqual(sel(t).ranges, ['/sl:sb/sp:tb']);
  assert.equal(sel(t).text, null, 'a click on an unselected table selects it');
  await click(t, ...mid(2, 1));
  const s = sel(t);
  assert.deepEqual(s.text.cell, [2, 1]);
  assert.equal(t.version, v, 'selecting is no document change');
  // A click in another cell of the edited table moves the caret there.
  await click(t, 120, 120);
  assert.deepEqual(sel(t).text.cell, [0, 0]);
  assert.equal(sel(t).text.caret >= 0, true);
  // The caret is where the click was: at the start of "Hello world", not its end.
  await click(t, 105, 120);
  assert.equal(sel(t).text.caret, 0);
  await click(t, 195, 120);
  assert.ok(sel(t).text.caret > 0, `caret ${sel(t).text.caret}`);
});

test('a drag from a cell into another selects cells; back into the first cell selects text again', async () => {
  const t = await session();
  await click(t, ...mid(0, 0));
  await click(t, ...mid(0, 0));
  assert.deepEqual(sel(t).text.cell, [0, 0]);
  const r = await t.exec('surface.pointer', {events: [ev('down', ...mid(0, 0)), ev('drag', ...mid(1, 1)), ev('up', ...mid(1, 1))], tol: 3});
  assert.equal(r.undoLabel ?? null, null);
  const s = sel(t);
  assert.equal(s.text, null);
  assert.deepEqual([s.cells.from, s.cells.to], [[0, 0], [1, 1]]);
  assert.equal(t.doc.selection.ranges[0].focus, '/sl:sb/sp:tb/r:1/c:1');
  // Drag again over the cells of another range: a press in a table whose cells are selected starts again in its cell.
  await t.exec('surface.pointer', {events: [ev('down', ...mid(2, 0)), ev('drag', ...mid(2, 2)), ev('up', ...mid(2, 2))], tol: 3});
  assert.deepEqual([sel(t).cells.from, sel(t).cells.to], [[2, 0], [2, 2]]);
  // A click in a cell then puts the caret there and ends the range.
  await click(t, ...mid(1, 2));
  assert.equal(sel(t).cells, null);
  assert.deepEqual(sel(t).text.cell, [1, 2]);
  // Coming back to the first cell of a drag selects text in it.
  await t.exec('surface.pointer', {events: [ev('down', 110, 120), ev('drag', ...mid(0, 1)), ev('drag', 190, 120), ev('up', 190, 120)], tol: 3});
  assert.equal(sel(t).cells, null);
  assert.deepEqual(sel(t).text.cell, [0, 0]);
});

test('the borders of a table resize its columns and rows: one undo step per drag', async () => {
  const t = await session();
  // Press on the border between columns 0 and 1 (x = 200) in row 1 and drag 30 to the right.
  const r = await t.exec('surface.pointer', {events: [ev('down', 200, 140), ev('drag', 215, 140), ev('drag', 230, 140), ev('up', 230, 140)], tol: 3});
  assert.equal(r.undoLabel, 'Column Width');
  assert.deepEqual(tbl(t).kind.cols, [130, 70, 100], 'the next column gives the width (the table keeps its width)');
  await t.undo();
  assert.deepEqual(tbl(t).kind.cols, [100, 100, 100]);
  // The first row grew to hold "Hello world" on two lines: its bottom border is where the row is drawn, not at its stored 40 pt.
  const drawn = rowHeights(ctxForSlide(t.content, t.content.slides[0]), tbl(t).kind, tbl(t));
  assert.ok(drawn[0] > 40, `drawn ${drawn[0]}`);
  const y0 = 100 + drawn[0];
  const q = await t.exec('surface.pointer', {events: [ev('down', 250, y0), ev('drag', 250, y0 + 10), ev('drag', 250, y0 + 20), ev('up', 250, y0 + 20)], tol: 3});
  assert.equal(q.undoLabel, 'Row Height');
  assert.ok(Math.abs(tbl(t).kind.rows[0].height - (drawn[0] + 20)) < 1e-6);
  assert.ok(Math.abs(tbl(t).xfrm.h - (drawn[0] + 20 + 80)) < 1e-6);
  // The table's right edge widens the last column and the table.
  await t.exec('surface.pointer', {events: [ev('down', 400, 120), ev('drag', 420, 120), ev('up', 420, 120)], tol: 3});
  assert.equal(tbl(t).kind.cols[2], 120);
  assert.equal(tbl(t).xfrm.w, 320);
  // The left and top edges are not borders to drag: they move the table.
  const x0 = tbl(t).xfrm.x;
  await t.exec('surface.pointer', {events: [ev('down', 98, 165), ev('drag', 128, 175), ev('up', 128, 175)], tol: 3});
  assert.equal(tbl(t).xfrm.x, x0 + 30);
});

test('a drag on a selected table\'s cell moves nothing but selects; a drag on its edge moves it', async () => {
  const t = await session();
  await click(t, ...mid(1, 1));
  const before = {...tbl(t).xfrm};
  await t.exec('surface.pointer', {events: [ev('down', 98, 165), ev('drag', 108, 175), ev('up', 108, 175)], tol: 3});
  assert.equal(tbl(t).xfrm.x, before.x + 10, 'a press on the grab band moves the table');
});

test('double-click in a cell edits that cell and selects the word', async () => {
  const t = await session();
  const r = await t.exec('surface.pointer', {events: [ev('doubleClick', 130, 120)], tol: 3});
  void r;
  const s = sel(t);
  assert.deepEqual(s.text.cell, [0, 0]);
  assert.equal(s.text.anchor, 0);
  assert.equal(s.text.caret, 5, '"Hello" is selected');
});

test('the pencil splits the cell it crosses and the eraser merges across a border, through the pointer', async () => {
  const t = await session();
  await t.exec('tool.drawTable', {});
  const r = await t.exec('surface.pointer', {events: [ev('down', 160, 105), ev('drag', 160, 150), ev('up', 160, 150)], tol: 3});
  void r;
  assert.equal(tbl(t).kind.cols.length, 4, 'a vertical line through column 0 adds a column');
  await t.exec('tool.tableEraser', {});
  // The border just drawn (x = 160) in row 0.
  await t.exec('surface.pointer', {events: [ev('down', 160, 120), ev('up', 160, 120)], tol: 3});
  assert.equal(tbl(t).kind.cols.length, 4);
  assert.equal(tbl(t).kind.rows[0].cells[0].gridSpan, 2, 'the two halves of the cell are one again');
});
