// Ports of the upstream Rust tests for Draw Table and Eraser: wordcraft
// crates/engine/src/cmd/table_draw.rs `mod tests` at aadb077e072b7de05f724e359d8db82e151f125c.
// Each test names the Rust test it ports.
//
// Behaviour fidelity:
// 1. ArtCraft (table_draw.rs:104 `draw`, :514 `eraser`): a pen stroke outside a table draws a
//    one-cell table the size of the rectangle; a straight line in a table splits the cells it
//    crosses; the eraser merges the two cells beside a border, or hides the border when they
//    can't make one rectangle. Word (Table Layout › Draw › Draw Table / Eraser) does the same.
// 2. Ours runs the same code on the schema-2 model, reading the same laid-out cell boxes from the
//    translated layout; each stroke or click is one command and one undo step.
// 3. These tests (engine) and tests/e2e/quill/table-draw.e2e.mjs (the bridge flow with captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {doc, tableSession, firstTable, shape, cellRect, lay, cellText, rejects, ready, caretIn} from '../table-helpers.mjs';

await ready();

test('table_draw.rs a_drawn_rectangle_inserts_a_table', async () => {
  const t = await doc('Above the table');
  const before = structuredClone(t.content.body);
  const body = lay(t).pages[0].body;
  const x0 = body.x + 40, y0 = body.y + 2;
  await t.exec('table.draw', {page: 0, x0, y0, x1: x0 + 200, y1: y0 + 60});
  const tb = firstTable(t);
  assert.deepEqual([tb.rows.length, tb.rows[0].cells.length], [1, 1]);
  assert.equal(tb.props.width, 200);
  assert.equal(tb.rows[0].props.height, 60);
  assert.ok(Math.abs(tb.props.indent - 40) < 0.5, `indent ${tb.props.indent}`);
  const sel = t.doc.selection.ranges[0].focus;
  assert.match(sel, /\/r:/, 'the caret goes into the new cell');
  const r = cellRect(t, 0, 0);
  assert.ok(Math.abs(r.w - 200) < 1 && r.h >= 59.5, JSON.stringify(r));
  await t.undo();
  assert.deepEqual(t.content.body, before, 'one undo step');
  // Too small, or nowhere: errors, never a crash.
  await rejects(() => t.exec('table.draw', {page: 0, x0, y0, x1: x0 + 5, y1: y0 + 5}));
  await rejects(() => t.exec('table.draw', {page: 9, x0: 1, y0: 1, x1: 100, y1: 100}));
  await rejects(() => t.exec('table.draw', {}));
});

test('table_draw.rs a_line_through_an_exact_row_keeps_its_drawn_height', async () => {
  const t = await tableSession(2, 2);
  // Upstream edits the table in place; here the same props go in through Table Properties' model.
  const ti = t.content.body.chunks.flat().findIndex(b => b.kind === 'table');
  const c = structuredClone(t.content);
  const tb0 = c.body.chunks.flat()[ti];
  tb0.props.cellMargins = [4, 5.4, 4, 5.4];
  tb0.rows[0].props = {...tb0.rows[0].props, height: 60, heightRule: 'exact'};
  const t2 = await doc('', () => c);
  const a = cellRect(t2, 0, 0), b = cellRect(t2, 0, 1);
  assert.ok(Math.abs(a.h - 64) < 0.5, `an exact 60pt row with a 4pt bottom margin: ${a.h}`);
  const y = a.y + 25;
  await t2.exec('table.draw', {page: 0, x0: b.x + 1, y0: y, x1: b.right - 1, y1: y});
  const tb = firstTable(t2);
  assert.deepEqual([tb.rows[0].props.heightRule, tb.rows[1].props.heightRule], ['exact', 'exact']);
  const top = cellRect(t2, 0, 1), low = cellRect(t2, 1, 1);
  assert.ok(Math.abs(top.h - 25) < 0.5 && Math.abs(top.y - a.y) < 0.01, JSON.stringify(top));
  assert.ok(Math.abs(low.bottom - a.bottom) < 0.5, `the pair keeps the row's height: ${low.bottom} vs ${a.bottom}`);
});

test('table_draw.rs erasing_a_horizontal_border_lays_the_merge_out_as_one_cell', async () => {
  const t = await tableSession(3, 2);
  const a = cellRect(t, 0, 0), b = cellRect(t, 1, 0);
  await t.exec('table.eraser', {page: 0, x: a.x + a.w / 2, y: a.bottom + 0.5});
  let tb = firstTable(t);
  assert.deepEqual([tb.rows[0].cells[0].props.vmerge, tb.rows[1].cells[0].props.vmerge], ['restart', 'continue']);
  const merged = cellRect(t, 0, 0);
  assert.ok(Math.abs(merged.bottom - b.bottom) < 0.5 && merged.h > a.h * 1.9, JSON.stringify(merged));
  const l = lay(t);
  assert.ok(l.pages[0].items.some(i => i.kind === 'cell' && i.row === 1 && i.cell === 0 && i.covered), 'the continuation row\'s box is covered');
  const hit = l.cellAt(0, merged.x + 3, b.y + b.h / 2);
  assert.deepEqual(hit && [hit[2], hit[3]], [0, 0], 'a click in the lower half is in the merged cell');
  // The border below the merge: the merge grows to three rows.
  await t.exec('table.eraser', {page: 0, x: merged.x + merged.w / 2, y: merged.bottom + 0.5});
  tb = firstTable(t);
  assert.equal(tb.rows[2].cells[0].props.vmerge, 'continue');
});

test('table_draw.rs lines_split_cells_and_the_eraser_merges_them', async () => {
  const t = await tableSession(2, 2);
  caretIn(t, 0, 0);
  await t.exec('text.insert', {text: 'A'});
  const start = structuredClone(firstTable(t));
  const r = cellRect(t, 0, 0);
  const x = r.x + r.w * 0.25;
  await t.exec('table.draw', {page: 0, x0: x, y0: r.y + 1, x1: x + 1, y1: r.bottom - 1});
  let tb = firstTable(t);
  assert.equal(tb.grid.length, 3);
  assert.deepEqual(shape(tb), [[1, 1, 1], [2, 1]], 'the crossed cell splits, the other row\'s cell spans the new column');
  assert.ok(Math.abs(tb.grid[0] - start.grid[0] * 0.25) < 1, JSON.stringify(tb.grid));
  assert.equal(cellText(t, 0, 0), 'A', 'the text stays in the left part');
  // The eraser on the new border merges the two cells again.
  const r0 = cellRect(t, 0, 0);
  await t.exec('table.eraser', {page: 0, x: r0.right + 1, y: r0.y + r0.h / 2});
  tb = firstTable(t);
  assert.deepEqual(shape(tb), [[2, 1], [2, 1]]);
  // A horizontal line across the second column's first cell splits its row.
  const r1 = cellRect(t, 0, 1);
  const y = r1.y + r1.h / 2;
  await t.exec('table.draw', {page: 0, x0: r1.x + 1, y0: y, x1: r1.right - 1, y1: y});
  tb = firstTable(t);
  assert.equal(tb.rows.length, 3);
  assert.equal(tb.rows[0].cells[0].props.vmerge, 'restart', 'the uncrossed cell spans both rows');
  assert.equal(tb.rows[1].cells[0].props.vmerge, 'continue');
  assert.equal(tb.rows[1].cells[1].props.vmerge ?? 'none', 'none');
  // Erasing that line merges the split cells (a vertical merge).
  const a = cellRect(t, 0, 1);
  await t.exec('table.eraser', {page: 0, x: a.x + a.w / 2, y: a.bottom + 0.5});
  tb = firstTable(t);
  assert.equal(tb.rows[0].cells[1].props.vmerge, 'restart');
  assert.equal(tb.rows[1].cells[1].props.vmerge, 'continue');
  // Four steps, four undos back to the start.
  await t.undo(4);
  assert.deepEqual(firstTable(t), start);
  // Nothing near a border, or a hostile point: an error.
  const c = cellRect(t, 0, 0);
  await rejects(() => t.exec('table.eraser', {page: 0, x: c.x + c.w / 2, y: c.y + c.h / 2}));
  await rejects(() => t.exec('table.eraser', {page: 0, x: 1e30, y: -1e30}));
  assert.deepEqual(firstTable(t), start);
});

/** A 3x3 table with columns 1 and 2 merged down rows 0-1 (made with the eraser itself). */
async function mergedColumnsTable() {
  const t = await tableSession(3, 3);
  for (const cell of [2, 1]) {
    const a = cellRect(t, 0, cell);
    await t.exec('table.eraser', {page: 0, x: a.x + a.w / 2, y: a.bottom + 0.5});
  }
  return t;
}

test('table_draw.rs erasing_between_cells_merged_down_the_same_rows_merges_them', async () => {
  const t = await mergedColumnsTable();
  const start = structuredClone(firstTable(t));
  assert.deepEqual(shape(start), [[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
  const a = cellRect(t, 0, 1);
  await t.exec('table.eraser', {page: 0, x: a.right + 0.5, y: a.y + 3});
  const tb = firstTable(t);
  assert.deepEqual(shape(tb), [[1, 2], [1, 2], [1, 1, 1]]);
  assert.deepEqual([tb.rows[0].cells[1].props.vmerge, tb.rows[1].cells[1].props.vmerge], ['restart', 'continue']);
  const merged = cellRect(t, 0, 1);
  assert.ok(merged.w > a.w * 1.9 && Math.abs(merged.h - a.h) < 0.5, JSON.stringify(merged));
  await t.undo();
  assert.deepEqual(firstTable(t), start);
});

test('table_draw.rs erasing_between_cells_that_dont_line_up_hides_the_border', async () => {
  const t = await mergedColumnsTable();
  const start = structuredClone(firstTable(t));
  let a = cellRect(t, 0, 0);
  await t.exec('table.eraser', {page: 0, x: a.right + 0.5, y: a.y + a.h / 2});
  let tb = firstTable(t);
  assert.deepEqual(shape(tb), shape(start), 'no merge');
  const hidden = b => !!b && (b.style === 'none' || !(b.width > 0));
  for (const r of [0, 1]) {
    assert.ok(hidden(tb.rows[r].cells[0].props.borders?.right) && hidden(tb.rows[r].cells[1].props.borders?.left), `row ${r}`);
  }
  assert.equal(tb.rows[2].cells[0].props.borders, undefined, 'rows outside the edge are untouched');
  await t.undo();
  assert.deepEqual(firstTable(t), start);
  // A cell spanning two columns above single cells: the horizontal border is hidden too.
  a = cellRect(t, 0, 1);
  await t.exec('table.eraser', {page: 0, x: a.right + 0.5, y: a.y + 3});
  const merged = cellRect(t, 0, 1);
  const before = structuredClone(firstTable(t));
  await t.exec('table.eraser', {page: 0, x: merged.x + 3, y: merged.bottom + 0.5});
  tb = firstTable(t);
  assert.deepEqual(shape(tb), shape(before), 'no merge');
  const vis = (r, c, top) => hidden(tb.rows[r].cells[c].props.borders?.[top ? 'top' : 'bottom']);
  assert.ok(vis(1, 1, false) && vis(2, 1, true) && vis(2, 2, true), 'both sides along the whole edge');
  assert.ok(!vis(2, 0, true), 'the first column is not part of the edge');
});
