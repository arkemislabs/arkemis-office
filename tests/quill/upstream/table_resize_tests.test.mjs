// Ports of the upstream Rust tests for resizing tables with the mouse: wordcraft
// crates/engine/src/cmd/table_resize/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// Each test names the Rust test it ports.
//
// Behaviour fidelity:
// 1. ArtCraft (table_resize.rs:491 `resize_drag`): a drag from a column border trades width with
//    the neighbour (Shift: only the left column; Ctrl: the columns right of it in proportion), the
//    left edge moves the indent, a row border sets an at-least (or exact) height that draws as
//    dragged, the corner handle scales the table, and selected cells' borders move in their rows
//    only. Word's table borders and the resize handle behave the same way.
// 2. Ours runs the same geometry over the translated layout's cell boxes and changes the schema-2
//    table; one drag is one undo step.
// 3. These tests (engine) and tests/e2e/quill/table-layout.e2e.mjs (bridge flow with captures).
// Not ported: a_selected_cells_border_moves_only_in_its_row, a_single_selected_cells_borders_move_
// only_in_its_row, without_that_cell_selected_the_whole_column_moves and triple_click_selects_a_cell_
// only_on_its_last_paragraph need the kernel selection to carry upstream's one-cell "cell mark"
// (Select Cell vs. all of a cell's text), which schema-2 selections can't tell apart yet (request
// design note U-quill-table--quill-foundation--cell-mark-selection); a_jagged_row_survives_a_docx_
// round_trip is the docx unit's writer.

import test from 'node:test';
import assert from 'node:assert/strict';
import {tableSession, firstTable, cellRect, lay, rejects, ready, caretIn, selectCells} from '../table-helpers.mjs';
import {resizeTarget, shareOut, REACH, HANDLE, MIN_COL} from '../../../core/quill/commands/table_resize.mjs';
import {Document} from '../../../core/quill/model/document.mjs';

await ready();
const target = (t, x, y) => resizeTarget(lay(t), new Document(t.content), 0, x, y, REACH);

test('table_resize/tests.rs a_column_border_drag_trades_width_with_the_neighbour', async () => {
  const t = await tableSession(2, 3);
  const start = structuredClone(firstTable(t));
  const a = cellRect(t, 0, 0), b0 = cellRect(t, 0, 1);
  const total0 = cellRect(t, 0, 2).right - a.x;
  const y = a.midY;
  await t.exec('table.resizeDrag', {page: 0, x: a.right + 1, y, toX: a.right + 31, toY: y});
  const a1 = cellRect(t, 0, 0), b1 = cellRect(t, 0, 1);
  assert.ok(Math.abs(a1.w - (a.w + 30)) < 1, `${a.w} → ${a1.w}`);
  assert.ok(Math.abs(b1.w - (b0.w - 30)) < 1, `${b0.w} → ${b1.w}`);
  assert.ok(Math.abs(cellRect(t, 0, 2).right - a1.x - total0) < 1, 'the table keeps its width');
  assert.ok(Math.abs(cellRect(t, 1, 0).w - a1.w) < 0.5, 'one border for the whole column');
  await t.undo();
  assert.deepEqual(firstTable(t), start, 'one undo step');
});

test('table_resize/tests.rs shift_and_the_right_edge_change_the_table_width', async () => {
  const t = await tableSession(1, 2);
  const a = cellRect(t, 0, 0), b = cellRect(t, 0, 1);
  const y = a.midY;
  await t.exec('table.resizeDrag', {page: 0, x: a.right, y, toX: a.right - 40, toY: y, shift: true});
  const a1 = cellRect(t, 0, 0), b1 = cellRect(t, 0, 1);
  assert.ok(Math.abs(a1.w - (a.w - 40)) < 1 && Math.abs(b1.w - b.w) < 1, `${a1.w} ${b1.w}`);
  await t.exec('table.resizeDrag', {page: 0, x: b1.right - 1, y, toX: b1.right - 51, toY: y});
  const b2 = cellRect(t, 0, 1);
  assert.ok(Math.abs(b2.w - (b1.w - 50)) < 1, `${b1.w} → ${b2.w}`);
});

test('table_resize/tests.rs column_drags_stop_at_the_minimum_width', async () => {
  const t = await tableSession(1, 2);
  const a = cellRect(t, 0, 0), b = cellRect(t, 0, 1);
  const y = a.midY;
  await t.exec('table.resizeDrag', {page: 0, x: a.right, y, toX: a.right + 5000, toY: y});
  const tb = firstTable(t);
  assert.ok(Math.abs(tb.grid[1] - MIN_COL) < 0.01, JSON.stringify(tb.grid));
  assert.ok(Math.abs(tb.grid[0] + tb.grid[1] - (a.w + b.w)) < 1);
});

test('table_resize/tests.rs a_row_border_drag_sets_the_row_height', async () => {
  const t = await tableSession(2, 2);
  const a = cellRect(t, 0, 0);
  const x = a.midX;
  await t.exec('table.resizeDrag', {page: 0, x, y: a.bottom + 1, toX: x, toY: a.bottom + 41});
  const tb = firstTable(t);
  assert.equal(tb.rows[0].props.heightRule, 'atLeast');
  assert.ok(tb.rows[0].props.height < a.h + 40, JSON.stringify(tb.rows[0].props));
  const h = cellRect(t, 0, 0).h;
  assert.ok(Math.abs(h - (a.h + 40)) < 0.1, `${a.h} → ${h}`);
  assert.equal(tb.rows[1].props.height, undefined, 'the other row is untouched');
});

test('table_resize/tests.rs an_exact_row_border_drag_leaves_out_the_bottom_margin', async () => {
  const t0 = await tableSession(2, 2);
  const c = structuredClone(t0.content);
  const tb0 = c.body.chunks.flat().find(b => b.kind === 'table');
  tb0.props.cellMargins = [0, 5.4, 4, 5.4];
  tb0.rows[0].props = {...tb0.rows[0].props, height: 30, heightRule: 'exact'};
  const {doc} = await import('../table-helpers.mjs');
  const t = await doc('', () => c);
  const a = cellRect(t, 0, 0);
  assert.ok(Math.abs(a.h - 34) < 0.1, `${a.h}`);
  const x = a.midX;
  await t.exec('table.resizeDrag', {page: 0, x, y: a.bottom, toX: x, toY: a.bottom + 20});
  const tb = firstTable(t);
  assert.equal(tb.rows[0].props.heightRule, 'exact');
  assert.ok(Math.abs(tb.rows[0].props.height - 50) < 0.1, `stored ${tb.rows[0].props.height}`);
  assert.ok(Math.abs(cellRect(t, 0, 0).h - 54) < 0.1, `drawn ${cellRect(t, 0, 0).h}`);
});

test('table_resize/tests.rs the_corner_handle_scales_the_table', async () => {
  const t = await tableSession(2, 2);
  const a = cellRect(t, 0, 0), d = cellRect(t, 1, 1);
  const w = d.right - a.x, h = d.bottom - a.y;
  const hx = d.right + 1 + HANDLE / 2, hy = d.bottom + 1 + HANDLE / 2;
  assert.equal(target(t, hx, hy)?.edge.kind, 'corner');
  await t.exec('table.resizeDrag', {page: 0, x: hx, y: hy, toX: hx - w * 0.5, toY: hy + h});
  const a1 = cellRect(t, 0, 0), d1 = cellRect(t, 1, 1);
  assert.ok(Math.abs((d1.right - a1.x) - w * 0.5) < 1.5, `${w} → ${d1.right - a1.x}`);
  assert.ok(Math.abs((d1.bottom - a1.y) - h * 2) < 0.5, `${h} → ${d1.bottom - a1.y}`);
});

test('table_resize/tests.rs merged_cells_have_no_border_inside', async () => {
  const t = await tableSession(2, 2);
  const a = cellRect(t, 0, 0);
  await t.exec('table.eraser', {page: 0, x: a.right, y: a.midY});
  const m = cellRect(t, 0, 0);
  const mid = target(t, a.right, m.midY);
  assert.ok(!mid || !(mid.edge.kind === 'column' && mid.edge.line === 1), JSON.stringify(mid?.edge));
  const b = cellRect(t, 1, 0);
  const tg = target(t, b.right, b.midY);
  assert.deepEqual(tg?.edge, {kind: 'column', line: 1});
});

test('table_resize/tests.rs a_vertical_merge_keeps_each_rows_border', async () => {
  const t = await tableSession(3, 2);
  const m = cellRect(t, 0, 0), a = cellRect(t, 0, 1), b = cellRect(t, 1, 1);
  await t.exec('table.eraser', {page: 0, x: m.midX, y: m.bottom + 0.5});
  assert.equal(firstTable(t).rows[1].cells[0].props.vmerge, 'continue');
  const x = b.midX;
  assert.deepEqual(target(t, x, a.bottom + 1)?.edge, {kind: 'row', row: 0}, 'the border between the merged rows is still there');
  assert.deepEqual(target(t, x, b.bottom + 1)?.edge, {kind: 'row', row: 1}, 'the merge\'s bottom is the second row\'s border');
  await t.exec('table.resizeDrag', {page: 0, x, y: a.bottom + 1, toX: x, toY: a.bottom + 21});
  const tb = firstTable(t);
  const h = cellRect(t, 0, 1).h;
  assert.ok(Math.abs(h - (a.h + 20)) < 0.1, `${a.h} → ${h}`);
  assert.equal(tb.rows[1].props.height, undefined, 'the other rows are untouched');
  assert.ok(Math.abs(cellRect(t, 1, 1).h - b.h) < 0.1);
});

test('table_resize/tests.rs misses_and_hostile_params_change_nothing', async () => {
  const t = await tableSession(2, 2);
  const start = structuredClone(firstTable(t));
  const c = cellRect(t, 0, 0);
  await rejects(() => t.exec('table.resizeDrag', {page: 0, x: c.midX, y: c.midY, toX: 10, toY: 10}));
  await rejects(() => t.exec('table.resizeDrag', {page: 0, x: 1e30, y: -1e30, toX: 1e30, toY: 1e30}));
  await rejects(() => t.exec('table.resizeDrag', {page: 99, x: 1, y: 1, toX: 1, toY: 1}));
  await rejects(() => t.exec('table.resizeDrag', {}));
  await t.exec('table.resizeDrag', {page: 0, x: c.right, y: c.midY, toX: 3.4e38, toY: c.midY, reach: 1e9});
  assert.ok(firstTable(t).grid.every(w => Number.isFinite(w) && w >= MIN_COL));
  await t.undo();
  assert.deepEqual(firstTable(t), start);
});

test('table_resize/tests.rs ctrl_shares_a_border_drag_among_the_columns_right_of_it', async () => {
  const t = await tableSession(1, 4);
  const a = cellRect(t, 0, 0), b = cellRect(t, 0, 1), d = cellRect(t, 0, 3);
  const y = a.midY;
  await t.exec('table.resizeDrag', {page: 0, x: a.right, y, toX: a.right + 30, toY: y, ctrl: true, shift: true});
  assert.ok(Math.abs(cellRect(t, 0, 0).w - (a.w + 30)) < 1);
  for (const c of [1, 2, 3]) assert.ok(Math.abs(cellRect(t, 0, c).w - (b.w - 10)) < 1, `column ${c}`);
  assert.ok(Math.abs(cellRect(t, 0, 3).right - d.right) < 1, 'the table keeps its width');
  let w = [100, 40, 80];
  assert.equal(shareOut(w, 0, 30, 'proportional'), 30);
  assert.ok(Math.abs(w[1] - 30) < 0.01 && Math.abs(w[2] - 60) < 0.01, JSON.stringify(w));
  w = [100, 12, 120];
  shareOut(w, 0, 500, 'proportional');
  assert.ok(Math.abs(w[1] - MIN_COL) < 0.01 && Math.abs(w.reduce((x, y) => x + y, 0) - 232) < 0.01, JSON.stringify(w));
  assert.equal(shareOut(w, 3, 1, 'proportional'), null);
});

test('table_resize/tests.rs the_left_edge_moves_the_indent_and_the_first_column', async () => {
  const t = await tableSession(2, 3);
  const start = structuredClone(firstTable(t));
  const a = cellRect(t, 0, 0), b = cellRect(t, 0, 1);
  const y = a.midY;
  assert.deepEqual(target(t, a.x - 2, y)?.edge, {kind: 'column', line: 0});
  assert.equal(target(t, a.x + 2.5, y), null, 'inside the first cell');
  await t.exec('table.resizeDrag', {page: 0, x: a.x - 1, y, toX: a.x + 35, toY: y});
  const a1 = cellRect(t, 0, 0), b1 = cellRect(t, 0, 1);
  assert.ok(Math.abs(a1.x - (a.x + 36)) < 0.5 && Math.abs(a1.right - a.right) < 0.5, `${a.x} → ${a1.x}`);
  assert.ok(Math.abs(b1.x - b.x) < 0.5 && Math.abs(b1.w - b.w) < 0.5, 'the other columns stay');
  assert.ok(Math.abs(cellRect(t, 1, 0).x - a1.x) < 0.01, 'the whole table moved in');
  assert.ok(Math.abs(firstTable(t).props.indent - 36) < 0.5, `${firstTable(t).props.indent}`);
  await t.undo();
  assert.deepEqual(firstTable(t), start, 'one undo step');
  caretIn(t, 0, 0);
  await t.exec('table.properties', {align: 'center', width: 300});
  let c = cellRect(t, 0, 0), e = cellRect(t, 0, 2);
  const y2 = c.midY;
  await t.exec('table.resizeDrag', {page: 0, x: c.x, y: y2, toX: c.x - 20, toY: y2});
  let c1 = cellRect(t, 0, 0), e1 = cellRect(t, 0, 2);
  assert.ok(Math.abs(c1.w - (c.w + 20)) < 0.5, `the first column takes the drag: ${c.w} → ${c1.w}`);
  assert.ok(Math.abs(e1.w - e.w) < 0.5, 'the other columns keep their widths');
  assert.ok(Math.abs((c1.x + e1.right) - (c.x + e.right)) < 1, 'the table stays centred');
  assert.equal(firstTable(t).props.align, 'center');
  await t.undo();
  await t.exec('table.properties', {align: 'right'});
  c = cellRect(t, 0, 0); e = cellRect(t, 0, 2);
  await t.exec('table.resizeDrag', {page: 0, x: c.x, y: y2, toX: c.x - 20, toY: y2});
  c1 = cellRect(t, 0, 0); e1 = cellRect(t, 0, 2);
  assert.ok(Math.abs(c1.x - (c.x - 20)) < 0.5 && Math.abs(e1.right - e.right) < 0.5, `only the left edge moves: ${c.x} → ${c1.x}`);
  assert.equal(firstTable(t).props.align, 'right');
});

test('table_resize/tests.rs with_cells_selected_their_border_moves_only_in_their_rows', async () => {
  const t = await tableSession(3, 3);
  caretIn(t, 1, 1);
  await t.exec('text.insert', {text: 'Wide'});
  const start = structuredClone(firstTable(t));
  const b = cellRect(t, 1, 1), c = cellRect(t, 1, 2);
  const y = b.midY;
  const drag = {page: 0, x: b.right, y, toX: b.right + 30, toY: y};
  selectCells(t, [1, 1, 0], [1, 1, 4]);
  await t.exec('table.resizeDrag', drag);
  assert.ok(Math.abs(cellRect(t, 0, 1).w - (b.w + 30)) < 1, 'text in one cell: every row');
  await t.undo();
  // From the second row's cell down into the third's.
  selectCells(t, [1, 1, 2], [2, 1, 0]);
  await t.exec('table.resizeDrag', drag);
  for (const r of [1, 2]) {
    const b1 = cellRect(t, r, 1), c1 = cellRect(t, r, 2);
    assert.ok(Math.abs(b1.w - (b.w + 30)) < 1 && Math.abs(c1.w - (c.w - 30)) < 1, `row ${r}: ${b1.w} ${c1.w}`);
  }
  assert.ok(Math.abs(cellRect(t, 0, 1).right - b.right) < 0.5, 'the first row keeps its border');
  const tb = firstTable(t);
  assert.equal(tb.grid.length, 4, JSON.stringify(tb.grid));
  assert.deepEqual(tb.rows[0].cells.map(x => x.props.span ?? 1), [1, 1, 2]);
  assert.deepEqual(tb.rows[2].cells.map(x => x.props.span ?? 1), [1, 2, 1]);
  const a = cellRect(t, 0, 0);
  await t.exec('table.resizeDrag', {page: 0, x: a.right, y: a.midY, toX: a.right - 10, toY: a.midY});
  assert.ok(Math.abs(cellRect(t, 1, 0).w - (a.w - 10)) < 1, 'a row outside the selection: the whole column');
  await t.undo(2);
  assert.deepEqual(firstTable(t), start, 'one undo step each');
});

test('table_resize/tests.rs a_border_of_a_cell_merged_past_the_selection_moves_in_every_row', async () => {
  const t = await tableSession(3, 3);
  selectCells(t, [0, 1, 0], [1, 1]);
  await t.exec('table.merge');
  const c = cellRect(t, 1, 2), e = cellRect(t, 2, 2);
  selectCells(t, [1, 2, 0], [2, 2]);
  await t.exec('table.resizeDrag', {page: 0, x: c.x, y: c.midY, toX: c.x + 20, toY: c.midY});
  assert.equal(firstTable(t).grid.length, 3, 'no new grid line');
  assert.ok(Math.abs(cellRect(t, 0, 2).x - (c.x + 20)) < 1, 'the first row follows');
  void e;
});
