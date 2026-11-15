// Ports of the upstream Rust tests for the table mouse (selection areas, insert buttons, the move
// handle, double-click fit): wordcraft crates/engine/src/cmd/table_mouse/tests.rs at
// aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test it ports.
//
// Behaviour fidelity:
// 1. ArtCraft (table_mouse.rs:407 `select_at`, :474 `insert_at`, :521 `move_drag`, :565
//    `fit_column`): just above a column selects it, left of a row (or in the page margin beside it)
//    the row, along a cell's left edge the cell, the handle past the top-left corner the table; the
//    insert buttons add a row or column at their border and select it; a double-click on a column
//    border fits the column left of it, the columns right of it moving along. Word's table mouse
//    does the same.
// 2. Ours runs the same hit areas over the translated layout's cell boxes; selections are the
//    kernel's (one run of the text for rows, one range per cell for a block of cells).
// 3. These tests (engine) and tests/e2e/quill/table-layout.e2e.mjs (bridge flow with captures).
// Not ported: dragging_the_handle_moves_the_table and the #2038 floating-table tests: the
// translated layout lays floating tables out in the text flow (core/quill/layout/table-flow.mjs
// header), so `table.moveDrag` stays disabled until the layout places them (request
// design note U-quill-table--quill-layout--floating-tables). Selection-shading, format painter
// and Shift+arrow tests belong to the caret/format/surface units that own those commands.

import test from 'node:test';
import assert from 'node:assert/strict';
import {tableSession, firstTable, cellRect, lay, rejects, ready, caretIn, fill, cellText, selCells, tableIndex} from '../table-helpers.mjs';
import {targetAt, handle, insertMark, movable} from '../../../core/quill/commands/table_mouse.mjs';
import {tablesOn, REACH} from '../../../core/quill/commands/table_resize.mjs';
import {measureTableColumns} from '../../../core/quill/lib/table-measure.mjs';
import {Document} from '../../../core/quill/model/document.mjs';
import {tableCols} from '../../../core/quill/model/table.mjs';

await ready();
const spotAt = (t, x, y, story = 'body') => targetAt(lay(t), new Document(t.content), story, 0, x, y, REACH)?.spot ?? null;

test('table_mouse/tests.rs the_areas_of_a_table_are_found', async () => {
  const t = await tableSession(3, 3);
  const a = cellRect(t, 0, 0), b = cellRect(t, 0, 1);
  const left = a.x, top = a.y;
  assert.deepEqual(spotAt(t, b.midX, top - 3), {kind: 'column', col: 1});
  assert.deepEqual(spotAt(t, b.midX, top + 1), {kind: 'column', col: 1});
  const r1 = cellRect(t, 1, 0);
  assert.deepEqual(spotAt(t, left - 10, r1.midY), {kind: 'row', row: 1});
  const c = cellRect(t, 1, 2);
  assert.deepEqual(spotAt(t, c.x + 4.5, c.midY), {kind: 'cell', row: 1, cell: 2});
  assert.deepEqual(spotAt(t, r1.x + 2, r1.midY), {kind: 'cell', row: 1, cell: 0}, 'the first column\'s edge has no resize border');
  assert.equal(spotAt(t, c.x + 20, c.midY), null, 'the text is the caret\'s');
  assert.equal(spotAt(t, b.x, a.midY), null, 'a column border resizes');
  assert.deepEqual(spotAt(t, b.x, top - 8), {kind: 'insertColumn', line: 1});
  assert.deepEqual(spotAt(t, left - 10, a.bottom), {kind: 'insertRow', line: 1});
  assert.deepEqual(spotAt(t, left - 10, top), {kind: 'insertRow', line: 0});
  const h = handle(tablesOn(lay(t), new Document(t.content), 0)[0]);
  assert.deepEqual(spotAt(t, h.x + h.w / 2, h.y + h.h / 2), {kind: 'handle'});
  // Another story's tables aren't in reach.
  assert.equal(spotAt(t, b.midX, top - 3, 'p7'), null);
  // The insert button's mark lies on its border.
  const mark = insertMark(targetAt(lay(t), new Document(t.content), 'body', 0, b.x, top - 8, REACH));
  assert.deepEqual(mark.from, [b.x, top]);
  assert.ok(Math.abs(mark.center[1] - (top - 8)) < 0.01);
});

test('table_mouse/tests.rs a_selected_columns_text_is_its_cells (selection)', async () => {
  const t = await tableSession(3, 3);
  await fill(t);
  const b = cellRect(t, 0, 1);
  await t.exec('table.selectAt', {page: 0, x: b.midX, y: b.y - 3});
  const sc = selCells(t);
  assert.equal(sc.n, 3, 'one range per cell of the column');
  assert.deepEqual([sc.rows, sc.cols], [[0, 2], [1, 1]]);
  // Bold, alignment and Delete on the column are the format/text units' (they take every range:
  // design note U-quill-table--quill-format--column-segments).
});

test('table_mouse/tests.rs rows_cells_and_drags_select_rectangles', async () => {
  const t = await tableSession(3, 3);
  await fill(t);
  const r1 = cellRect(t, 1, 0);
  await t.exec('table.selectAt', {page: 0, x: r1.x - 10, y: r1.midY});
  let sc = selCells(t);
  assert.equal(sc.n, 1, 'a row is one run of the text');
  assert.deepEqual([sc.rows, sc.cols], [[1, 1], [0, 2]]);
  const r2 = cellRect(t, 2, 0);
  await t.exec('table.selectAt', {page: 0, x: r1.x - 10, y: r1.midY, toX: r1.x - 10, toY: r2.midY + 50});
  assert.deepEqual(selCells(t).rows, [1, 2]);
  // From cell (0, 0) to cell (1, 1): four cells, not the row between.
  const a = cellRect(t, 0, 0), d = cellRect(t, 1, 1);
  await t.exec('table.selectAt', {page: 0, x: a.x + 2, y: a.midY, toX: d.midX, toY: d.midY});
  sc = selCells(t);
  assert.equal(sc.n, 4);
  assert.deepEqual([sc.rows, sc.cols], [[0, 1], [0, 1]]);
});

test('table_mouse/tests.rs the_margin_beside_a_row_selects_it (left-to-right)', async () => {
  const t = await tableSession(3, 3);
  const r1 = cellRect(t, 1, 0);
  const page = lay(t).pages[0];
  assert.ok(r1.x - 40 > 0 && r1.x - page.body.x < 24);
  assert.deepEqual(spotAt(t, 10, r1.midY), {kind: 'row', row: 1});
  assert.deepEqual(spotAt(t, page.body.x - 35, r1.midY), {kind: 'row', row: 1});
  assert.equal(spotAt(t, page.body.x + page.body.w + 20, r1.midY), null, 'the right margin is not a row bar of a left-to-right table');
});

test('table_mouse/tests.rs an_anchor_row_param_fixes_the_extend_anchor', async () => {
  const t = await tableSession(3, 3);
  const r0 = cellRect(t, 0, 0), r2 = cellRect(t, 2, 0);
  const x = r0.x - 10;
  await t.exec('table.selectAt', {page: 0, x, y: r2.midY});
  await t.exec('table.selectAt', {page: 0, x, y: r0.midY, extend: true});
  assert.deepEqual(selCells(t).rows, [0, 2]);
  await t.exec('table.selectAt', {page: 0, x, y: r0.midY, toX: x, toY: r0.midY + 1, extend: true, anchorRow: 2});
  assert.deepEqual(selCells(t).rows, [0, 2], 'the press\'s anchor stays');
  await t.exec('table.selectAt', {page: 0, x, y: r0.midY, extend: true, anchorRow: 99999999999});
  assert.deepEqual(selCells(t).rows, [0, 2], 'clamped to the last row');
  await t.exec('table.selectAt', {page: 0, x, y: r0.midY, extend: true, anchorRow: 1});
  assert.deepEqual(selCells(t).rows, [0, 1]);
});

test('table_mouse/tests.rs the_insert_buttons_add_rows_and_columns', async () => {
  const t = await tableSession(2, 3);
  await fill(t);
  const a = cellRect(t, 0, 0);
  await t.exec('table.insertAt', {page: 0, x: a.x - 10, y: a.bottom});
  assert.equal(firstTable(t).rows.length, 3);
  assert.ok(cellText(t, 1, 0) === '' && cellText(t, 2, 0) === 'r1c0', 'the new row is the second');
  assert.deepEqual([selCells(t).rows, selCells(t).cols], [[1, 1], [0, 2]], 'it\'s selected');
  await t.undo();
  assert.equal(firstTable(t).rows.length, 2, 'one undo step');
  // Above the first row.
  await t.exec('table.insertAt', {page: 0, x: a.x - 10, y: a.y});
  assert.ok(cellText(t, 0, 0) === '' && cellText(t, 1, 0) === 'r0c0');
  assert.deepEqual(selCells(t).rows, [0, 0]);
  await t.undo();
  // A column at the border between the first two, the table keeping its width.
  const width = firstTable(t).grid.reduce((x, y) => x + y, 0);
  const b = cellRect(t, 0, 1);
  await t.exec('table.insertAt', {page: 0, x: b.x, y: a.y - 8});
  let tb = firstTable(t);
  assert.equal(tableCols(tb), 4);
  assert.ok(cellText(t, 0, 1) === '' && cellText(t, 0, 2) === 'r0c1');
  assert.ok(Math.abs(tb.grid.reduce((x, y) => x + y, 0) - width) < 0.5);
  assert.deepEqual([selCells(t).rows, selCells(t).cols], [[0, 1], [1, 1]], 'it\'s selected');
  // And at the right edge.
  const e = cellRect(t, 0, 3);
  await t.exec('table.insertAt', {page: 0, x: e.right, y: a.y - 8});
  tb = firstTable(t);
  assert.equal(tableCols(tb), 5);
  assert.ok(cellText(t, 0, 4) === '' && cellText(t, 0, 3) === 'r0c2');
  assert.deepEqual(selCells(t).cols, [4, 4]);
});

test('table_mouse/tests.rs a_double_click_on_a_border_fits_the_column', async () => {
  const t = await tableSession(1, 3);
  caretIn(t, 0, 0);
  await t.exec('text.insert', {text: 'ab'});
  const a = cellRect(t, 0, 0), b = cellRect(t, 0, 1), c = cellRect(t, 0, 2);
  const fit = measureTableColumns(t.content, firstTable(t));
  await t.exec('table.fitColumn', {page: 0, x: a.right, y: a.midY});
  const a1 = cellRect(t, 0, 0), b1 = cellRect(t, 0, 1), c1 = cellRect(t, 0, 2);
  assert.ok(Math.abs(a1.w - fit[0][1]) < 0.5 && a1.w < a.w - 50, `${a.w} → ${a1.w}, ${JSON.stringify(fit)}`);
  assert.ok(Math.abs(b1.w - b.w) < 0.5 && Math.abs(c1.w - c.w) < 0.5, 'the columns right of it keep their widths');
  assert.ok(Math.abs(b1.x - b.x - (a1.w - a.w)) < 0.5 && Math.abs(c1.right - c.right - (a1.w - a.w)) < 0.5, 'and move along');
  await t.exec('table.fitColumn', {page: 0, x: c1.right, y: c1.midY});
  const c2 = cellRect(t, 0, 2);
  assert.ok(Math.abs(c2.w - fit[2][1]) < 0.5 && c2.w < c.w, `${c.w} → ${c2.w}`);
});

test('table_mouse/tests.rs misses_and_hostile_params_change_nothing', async () => {
  const t = await tableSession(2, 2);
  const start = structuredClone(firstTable(t));
  const c = cellRect(t, 1, 1);
  const mid = {page: 0, x: c.midX, y: c.midY, toX: 1, toY: 1};
  for (const id of ['table.selectAt', 'table.insertAt', 'table.moveDrag', 'table.fitColumn']) {
    await rejects(() => t.exec(id, mid));
    await rejects(() => t.exec(id, {page: 99, x: 1, y: 1, toX: 1, toY: 1}));
    await rejects(() => t.exec(id, {page: 0, x: 1e30, y: -1e30, toX: 1e30, toY: 1e30, reach: 1e30}));
    await rejects(() => t.exec(id, {}));
  }
  const a = cellRect(t, 0, 0);
  await rejects(() => t.exec('table.selectAt', {page: 0, x: a.x - 10, y: a.bottom}));
  await rejects(() => t.exec('table.insertAt', {page: 0, x: a.x - 10, y: a.midY}));
  assert.deepEqual(firstTable(t), start);
  // Only a table of the main text, not a nested one, can be moved.
  const g = tablesOn(lay(t), new Document(t.content), 0)[0];
  assert.ok(movable(g));
  g.table = [tableIndex(t), 0, 0, 1];
  assert.ok(!movable(g));
});
