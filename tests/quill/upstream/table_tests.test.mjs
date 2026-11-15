// Ports of the upstream Rust table tests in wordcraft crates/engine/src/tests.rs at
// aadb077e072b7de05f724e359d8db82e151f125c (tables_commands, inserting_a_column_keeps_cell_widths_
// in_step_with_the_grid, table_properties_apply_in_one_step, table_text_direction_cycles_and_turns_
// the_text, table_border_presets_mask_the_sides_they_clear, tables_nest_at_most_24_deep). Each test
// names the Rust test it ports.
//
// Behaviour fidelity:
// 1. ArtCraft (cmd/table.rs + table/{structure,layout,convert}.rs): Insert Above/Below/Left/Right,
//    Delete, Table Properties in one undo step, Text Direction cycling horizontal → down → up, the
//    border presets writing "none" over the sides they clear so a style's grid doesn't show
//    through. Word's Table Layout and Table Design tabs behave the same.
// 2. Ours runs the same code on schema-2 tables; the layout reads the same props.
// 3. These tests, tests/quill/table.test.mjs (undo round trip of every table command) and
//    tests/e2e/quill/table-layout.e2e.mjs (the contextual tabs through the bridge, with captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {doc, firstTable, lay, rejects, ready, caretIn, selectCells, tableIndex} from '../table-helpers.mjs';
import {tableCols} from '../../../core/quill/model/table.mjs';

await ready();

test('tests.rs tables_commands', async () => {
  const t = await doc('');
  await t.exec('insert.table', {rows: 2, cols: 3});
  assert.match(t.doc.selection.ranges[0].focus, /\/r:/);
  await t.exec('text.insert', {text: 'A1'});
  await t.exec('text.tab');
  await t.exec('text.insert', {text: 'B1'});
  await t.exec('table.insertRowBelow');
  await t.exec('table.insertColumnRight');
  const tb = firstTable(t);
  assert.equal(tb.rows.length, 3);
  assert.equal(tableCols(tb), 4);
  await t.exec('table.deleteTable');
  assert.equal(firstTable(t), undefined);
  await rejects(() => t.exec('table.merge'));
});

test('tests.rs inserting_a_column_keeps_cell_widths_in_step_with_the_grid', async () => {
  const t = await doc('');
  await t.exec('insert.table', {rows: 2, cols: 2});
  const before = firstTable(t).grid.slice();
  assert.ok(before.every(w => w > 0));
  await t.exec('table.insertColumnRight');
  const tb = firstTable(t);
  const sum = v => v.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(tb.grid) - sum(before)) < 0.5);
  const cells = tb.rows[0].cells.map(c => c.props.width ?? 0);
  assert.equal(cells.length, tb.grid.length);
  tb.grid.forEach((g, i) => assert.ok(Math.abs(cells[i] - g) < 0.01, `cell width ${cells[i]} vs grid ${g}`));
});

test('tests.rs table_properties_apply_in_one_step', async () => {
  const t = await doc('');
  await t.exec('insert.table', {rows: 2, cols: 2});
  const t0 = structuredClone(firstTable(t));
  await t.exec('table.properties', {align: 'center', indent: 18, width: 300, rowHeight: 40, rowHeightRule: 'exact', allowBreak: false,
    headerRow: true, columnWidth: 120, cellWidth: 110, valign: 'bottom'});
  const tb = firstTable(t);
  assert.deepEqual([tb.props.align, tb.props.indent, tb.props.width], ['center', 18, 300]);
  const row = tb.rows[0];
  assert.deepEqual([row.props.height, row.props.heightRule, row.props.cantSplit, row.props.header], [40, 'exact', true, true]);
  assert.equal(tb.grid[0], 120);
  assert.deepEqual([row.cells[0].props.width, row.cells[0].props.valign], [110, 'bottom']);
  const applied = structuredClone(tb);
  await t.undo();
  assert.deepEqual(firstTable(t), t0, 'one undo step per apply');
  await t.redo();
  assert.deepEqual(firstTable(t), applied);
  await t.exec('table.properties', {rowHeight: null});
  assert.equal(firstTable(t).rows[0].props.heightRule ?? 'auto', 'auto');
  await rejects(() => t.exec('table.properties', {valign: 'middle'}));
});

test('tests.rs table_text_direction_cycles_and_turns_the_text (#226)', async () => {
  const t = await doc('');
  await t.exec('insert.table', {rows: 1, cols: 3});
  await t.exec('text.insert', {text: 'Turned'});
  const dirs = () => firstTable(t).rows[0].cells.map(c => c.props.textDirection ?? 'horizontal');
  await t.exec('table.textDirection');
  assert.deepEqual(dirs(), ['down', 'horizontal', 'horizontal']);
  await t.exec('table.textDirection');
  assert.equal(dirs()[0], 'up');
  await t.exec('table.textDirection');
  assert.equal(dirs()[0], 'horizontal');
  selectCells(t, [0, 0, 0], [0, 1, 0]);
  await t.exec('table.textDirection');
  assert.deepEqual(dirs(), ['down', 'down', 'horizontal']);
  await t.exec('table.textDirection', {value: 'up'});
  assert.deepEqual(dirs(), ['up', 'up', 'horizontal']);
  await rejects(() => t.exec('table.textDirection', {value: 'sideways'}));
  await t.undo();
  assert.deepEqual(dirs(), ['down', 'down', 'horizontal']);
});

// The layout half waits on F:quill: core/quill/layout/table.mjs `regionLook` takes the whole-table
// part's borders as region borders, so they win over the table's own (upstream layout/table.rs
// `region_look` leaves WholeTable out: "the whole table's borders are the table borders").
// design note U-quill-table--quill-layout--whole-table-style-borders
test('tests.rs table_border_presets_mask_the_sides_they_clear (#143), layout half', {todo: 'layout regionLook (F:quill)'}, async () => {
  const t = await doc('');
  await t.exec('insert.table', {rows: 2, cols: 2});
  const rulePos = () => {
    const vx = new Set(), hy = new Set();
    for (const it of lay(t).pages[0].items) {
      if (it.kind !== 'rule') continue;
      if (Math.abs(it.x0 - it.x1) < 1e-3) vx.add(Math.round(it.x0 * 1000));
      if (Math.abs(it.y0 - it.y1) < 1e-3) hy.add(Math.round(it.y0 * 1000));
    }
    return [vx.size, hy.size];
  };
  assert.deepEqual(rulePos(), [3, 3], 'baseline grid');
  await t.exec('table.borders', {kind: 'outside'});
  assert.deepEqual(rulePos(), [2, 2], 'outside keeps only the frame');
  let b = firstTable(t).props.borders;
  assert.equal(b.between.style, 'none');
  assert.equal(b.inside_v.style, 'none');
  await t.exec('table.borders', {kind: 'inside'});
  assert.deepEqual(rulePos(), [1, 1], 'inside keeps only the inner rules');
  b = firstTable(t).props.borders;
  for (const side of ['top', 'bottom', 'left', 'right']) assert.equal(b[side].style, 'none', side);
});

test('tests.rs table_border_presets_mask_the_sides_they_clear (#143), model half', async () => {
  const t = await doc('');
  await t.exec('insert.table', {rows: 2, cols: 2});
  await t.exec('table.borders', {kind: 'outside'});
  let b = firstTable(t).props.borders;
  assert.deepEqual([b.between.style, b.inside_v.style, b.top.style], ['none', 'none', 'single']);
  await t.exec('table.borders', {kind: 'inside'});
  b = firstTable(t).props.borders;
  for (const side of ['top', 'bottom', 'left', 'right']) assert.equal(b[side].style, 'none', side);
  assert.deepEqual([b.between.style, b.inside_v.style], ['single', 'single']);
});

test('tests.rs tables_nest_at_most_24_deep', async () => {
  const t = await doc('');
  await t.exec('insert.table', {rows: 1, cols: 1});
  let refused = null;
  for (let i = 0; i < 30 && !refused; i++) {
    try { await t.exec('insert.table', {rows: 1, cols: 1}); } catch (e) { refused = e; }
  }
  assert.ok(refused, 'a 25th level is refused');
  let depth = 0;
  let b = firstTable(t);
  while (b) { depth++; b = b.rows[0].cells[0].blocks.find(x => x.kind === 'table'); }
  assert.equal(depth, 24);
  void caretIn; void tableIndex;
});
