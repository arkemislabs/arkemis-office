// Ported from gridcraft crates/engine/src/cmd/format.rs `mod tests` and crates/engine/src/tests.rs
// (no_border_clears_only_shared_edges_and_undo_restores_them, no_border_handles_sheet_corners_*,
// borders_respect_sheet_formatting_protection, formatting_and_styles, line_breaks_grow_a_row_*,
// autofit_skips_merged_cells, changing_the_font_name_*, accounting_format_takes_the_symbol_*,
// vertical_alignment_commands_*, row_height_and_column_width_take_a_list_of_areas,
// line_sizes_and_freeze_panes_take_a_sheet (sizes part), row_height_and_column_width_take_pixels_*)
// at 146161b4b450a56e5e59a083ba0478582d1e602b.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: format.rs apply_style (cell, then row, then column style; whole lines keep their own
//    format), borders (presets, None clears the facing edges of the neighbours), merge (only the
//    upper-left value survives), sizes.rs (pixels or Excel's points/characters). Excel does the
//    same from Home › Font / Alignment / Number / Cells › Format.
// 2. Ours runs the same steps on schema-2 workbooks (style ids interned in content.styles), with the
//    same messages and limits; what the grid paints comes from those styles (E2E captures).
// 3. These tests (engine) and tests/e2e/grid/format-ribbon.e2e.mjs (bridge flow and captures).

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, run, fails, style, stored, text} from '../edit-helpers.mjs';
import {adjustDecimals, accountingFormat, ACCOUNTING} from '../../../core/grid/commands/format/number.mjs';
import {charsToPx} from '../../../core/grid/commands/format/cells.mjs';
import {pointsToChars, rowHeight, colWidth} from '../../../core/grid/model/sheet.mjs';

const sheet0 = t => t.content.sheets[0];

test('merge_across_keeps_the_first_value_of_each_row', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1, 2], [3, 4]]});
  await run(t, 'cell.set', {cell: 'D1', input: '=SUM(A1:B2)'});
  await run(t, 'home.mergeAcross', {range: 'A1:B2'});
  assert.equal(stored(t, 'B1')?.v, undefined);
  assert.equal(stored(t, 'B2')?.v, undefined);
  const {v} = await import('../edit-helpers.mjs');
  assert.equal(v(t, 'D1'), 4);
  assert.deepEqual(sheet0(t).merges, ['A1:B1', 'A2:B2']);
});

test('the_default_symbol_reproduces_the_accounting_format', () => {
  assert.equal(accountingFormat('$'), ACCOUNTING);
});

test('decimal_steps', () => {
  assert.equal(adjustDecimals('General', 1.5, 1), '0.00');
  assert.equal(adjustDecimals('General', 1.5, -1), '0');
  assert.equal(adjustDecimals('0', 1.5, 1), '0.0');
  assert.equal(adjustDecimals('0.00', 1.5, -1), '0.0');
  assert.equal(adjustDecimals('0.0', 1.5, -1), '0');
  assert.equal(adjustDecimals('#,##0.00;[Red]-#,##0.00', 1.5, 1), '#,##0.000;[Red]-#,##0.000');
  assert.equal(adjustDecimals('0%', 1.5, 1), '0.0%');
});

test('format_cells_takes_the_documented_keys', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: '5'});
  await run(t, 'home.formatCells', {range: 'A1', style: {numFmt: '0.0', borders: {diagUp: {style: 'Thin'}}}});
  assert.equal(style(t, 'A1').numFmt, '0.0');
  assert.equal(style(t, 'A1').borders.diagUp.style, 'thin');
  // The style's own snake_case keys keep working.
  await run(t, 'home.formatCells', {range: 'A1', style: {num_fmt: '0.00'}});
  assert.equal(style(t, 'A1').numFmt, '0.00');
});

test('width_units', () => {
  assert.equal(charsToPx(8.43), 64);
  assert.ok(Math.abs(pointsToChars(64) - 8.43) < 0.01);
});

test('no_border_clears_only_shared_edges_and_undo_restores_them', async () => {
  for (const [range, neighbors] of [
    ['B2', [['B1', 'bottom'], ['B3', 'top'], ['A2', 'right'], ['C2', 'left']]],
    ['B2:C3', [['B1', 'bottom'], ['C1', 'bottom'], ['B4', 'top'], ['C4', 'top'], ['A2', 'right'], ['A3', 'right'], ['D2', 'left'], ['D3', 'left']]],
  ]) {
    const t = await session();
    await run(t, 'range.setValues', {range: 'A1', values: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]});
    await run(t, 'cell.set', {cell: 'D4', input: '=SUM(A1:C1)'});
    await run(t, 'home.bold', {range: 'A1:D4', on: true});
    for (const preset of ['all', 'diagonalDown']) await run(t, 'home.borders', {range: 'A1:D4', preset, style: 'double', color: '#CC3344'});
    const cells = [];
    for (const r of [1, 2, 3, 4]) for (const c of 'ABCD') cells.push(`${c}${r}`);
    const before = Object.fromEntries(cells.map(a => [a, {stored: stored(t, a), style: style(t, a)}]));
    await run(t, 'home.borders', {range, preset: 'none'});
    const sel = new Set(range === 'B2' ? ['B2'] : ['B2', 'C2', 'B3', 'C3']);
    for (const a of cells) {
      const after = style(t, a);
      if (sel.has(a)) assert.deepEqual(Object.values(after.borders).filter(Boolean), [], `clearing ${range}, cell ${a}`);
      else {
        const hit = neighbors.find(([cell]) => cell === a);
        const expected = {...before[a].style.borders};
        if (hit) expected[hit[1]] = null;
        assert.deepEqual(after.borders, expected, `clearing ${range}, cell ${a}`);
        assert.equal(after.font.bold, true);
      }
    }
    await t.undo();
    for (const a of cells) assert.deepEqual(style(t, a), before[a].style, `undo ${a}`);
  }
});

test('no_border_handles_sheet_corners_without_creating_out_of_bounds_cells', async () => {
  for (const [range, corner, neighbors] of [
    ['A1:B2', 'A1', [['B1', 'left'], ['A2', 'top']]],
    ['XFC1048575:XFD1048576', 'XFD1048576', [['XFC1048576', 'right'], ['XFD1048575', 'bottom']]],
  ]) {
    const t = await session();
    await run(t, 'home.borders', {range, preset: 'all'});
    await run(t, 'home.borders', {range: corner, preset: 'none'});
    for (const [n, edge] of neighbors) assert.equal(style(t, n).borders[edge], null);
    let count = 0;
    for (const b of Object.values(sheet0(t).blocks)) count += Object.keys(b).length;
    assert.ok(count <= 4);
  }
});

test('borders_respect_sheet_formatting_protection', async () => {
  // review.protectSheet (U:grid/review) writes the sheet's protection record; here it is set directly.
  const t = await session();
  await run(t, 'home.borders', {range: 'A1:B2', preset: 'all'});
  const protectedBook = extra => workbook([{id: 's1', name: 'Sheet1', blocks: structuredClone(sheet0(t).blocks), protection: {enabled: true, ...extra}}],
    {styles: structuredClone(t.content.styles)});
  const tp = await session(protectedBook({}));
  const snap = JSON.stringify(tp.content);
  const undo = tp.doc.undo.size;
  for (const preset of ['none', 'left']) {
    const e = await fails(tp, 'home.borders', {range: 'A1', preset});
    assert.match(e.message, /protected sheet/);
    assert.equal(JSON.stringify(tp.content), snap);
    assert.equal(tp.doc.undo.size, undo);
  }
  const tf = await session(protectedBook({formatCells: true}));
  await run(tf, 'home.borders', {range: 'A1', preset: 'none'});
  assert.equal(style(tf, 'B1').borders.left, null);
});

test('formatting_and_styles', async () => {
  const t = await session();
  t.session.setSelection(t.docId, {ranges: [{anchor: '/sh:s1/A1', focus: '/sh:s1/B2'}], primary: 0});
  await run(t, 'home.bold', {});
  await run(t, 'home.fillColor', {color: '#FFFF00'});
  await run(t, 'home.mergeCenter', {});
  assert.equal(style(t, 'B2').font.bold, true);
  assert.deepEqual(sheet0(t).merges, ['A1:B2']);
  await run(t, 'home.cellStyle', {range: 'D1', name: 'Good'});
  assert.equal(style(t, 'D1').fill.fg, '#C6EFCE');
  assert.equal(style(t, 'D1').font.color, '#006100');
});

test('line_breaks_grow_a_row_only_when_the_cell_wraps', async () => {
  const txt = 'first line\n\n\nfourth line';
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {B2: {v: txt}}}}]));
  const deflt = rowHeight(sheet0(t), 1);
  await run(t, 'home.wrapText', {range: 'B2', on: true});
  const wrapped = rowHeight(sheet0(t), 1);
  assert.ok(wrapped > deflt * 2.5, `wrapped four-line text grows the row, got ${wrapped} vs ${deflt}`);
  await run(t, 'home.wrapText', {range: 'B2', on: false});
  assert.equal(rowHeight(sheet0(t), 1), deflt, 'wrap off: back to a one-line row');
});

test('autofit_skips_merged_cells', async () => {
  const t = await session();
  const long = 'This is a long sentence that should wrap across the merged width of five columns';
  await run(t, 'cell.set', {cell: 'A1', input: long});
  await run(t, 'home.mergeCells', {range: 'A1:E1'});
  await run(t, 'home.wrapText', {range: 'A1:E1', on: true});
  await run(t, 'cell.set', {cell: 'A3', input: long});
  await run(t, 'home.wrapText', {range: 'A3', on: true});
  assert.equal(sheet0(t).rows?.[0]?.size, undefined, 'merged wrap must not auto-fit row 1');
  assert.ok(sheet0(t).rows?.[2]?.size > 15, 'unmerged wrap still fits its row');
});

test('changing_the_font_name_drops_the_old_font', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {s: 1}}}}], {styles: [{}, {font: {name: 'Traditional Arabic'}}]}));
  await run(t, 'home.fontName', {range: 'A1', name: 'Arial'});
  assert.equal(style(t, 'A1').font.name, 'Arial');
});

test('accounting_format_takes_the_symbol_it_is_given', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: '1234.5'});
  await run(t, 'home.accounting', {range: 'A1', symbol: 'L'});
  assert.equal(style(t, 'A1').numFmt, accountingFormat('L'));
  assert.match(text(t, 'A1'), /^ L ?1,234.50 $/);
  await run(t, 'home.accounting', {range: 'A1'});
  assert.equal(style(t, 'A1').numFmt, ACCOUNTING);
  for (const bad of ['"', '\\', '\n', 'L\t']) await fails(t, 'home.accounting', {range: 'A1', symbol: bad});
});

test('vertical_alignment_commands', async () => {
  const t = await session();
  for (const [a, cmd] of [['A1', 'home.alignTop'], ['A2', 'home.alignMiddle'], ['A3', 'home.alignBottom']]) {
    t.session.setSelection(t.docId, {ranges: [{anchor: `/sh:s1/${a}`, focus: `/sh:s1/${a}`}], primary: 0});
    await run(t, cmd, {});
  }
  assert.deepEqual(['A1', 'A2', 'A3'].map(a => style(t, a).align.v), ['top', 'center', 'bottom']);
});

test('row_height_and_column_width_take_a_list_of_areas', async () => {
  const t = await session();
  await run(t, 'home.columnWidth', {cols: 'B:B,D:E', width: 120});
  await run(t, 'home.rowHeight', {rows: '2:2,4:5', height: 40});
  for (const c of [1, 3, 4]) assert.equal(colWidth(sheet0(t), c), 120);
  for (const c of [0, 2, 5]) assert.notEqual(colWidth(sheet0(t), c), 120);
  for (const r of [1, 3, 4]) assert.equal(rowHeight(sheet0(t), r), 40);
  for (const r of [0, 2, 5]) assert.notEqual(rowHeight(sheet0(t), r), 40);
  await fails(t, 'home.columnWidth', {cols: 'B:B,nope', width: 50});
  assert.equal(colWidth(sheet0(t), 1), 120, 'a bad list changes nothing');
});

test('line_sizes_take_a_sheet', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1'}, {id: 's2', name: 'Data'}]));
  const before = JSON.stringify(sheet0(t));
  await run(t, 'home.columnWidth', {sheet: 'Data', cols: 'A:A', width: 150});
  await run(t, 'home.columnWidth', {cols: 'Data!B:B,D:D', chars: 20});
  await run(t, 'home.columnWidth', {sheet: null, cols: 'Data!C:C', chars: 20});
  await run(t, 'home.rowHeight', {sheet: 1, rows: '1:1', height: 40});
  await run(t, 'home.hideColumns', {sheet: 'Data', cols: 'E:E'});
  await run(t, 'home.defaultWidth', {sheet: 'Data', width: 80});
  const data = t.content.sheets[1];
  assert.deepEqual([0, 1, 2, 3].map(c => colWidth(data, c)), [150, 145, 145, 145]);
  assert.equal(rowHeight(data, 0), 40);
  assert.equal(data.cols[4].hidden, true);
  assert.equal(data.defaultColWidth, 80);
  assert.equal(JSON.stringify(sheet0(t)), before, 'the active sheet is untouched');
  await fails(t, 'home.columnWidth', {sheet: 'Data', width: 10});
  await fails(t, 'home.columnWidth', {sheet: 'Sheet1', cols: 'Data!B:B', width: 10});
  await fails(t, 'home.rowHeight', {rows: 'Nope!1:1', height: 10});
  assert.equal(JSON.stringify(sheet0(t)), before);
});

test('row_height_and_column_width_take_pixels_or_excel_units', async () => {
  const t = await session();
  await run(t, 'home.rowHeight', {rows: '1:1', points: 30});
  await run(t, 'home.rowHeight', {rows: '2:2', height: 30});
  await run(t, 'home.rowHeight', {rows: '3:3', points: 409.5});
  await run(t, 'home.columnWidth', {cols: 'A:A', chars: 8.43});
  await run(t, 'home.columnWidth', {cols: 'B:B', width: 100});
  assert.deepEqual([0, 1, 2].map(r => rowHeight(sheet0(t), r)), [40, 30, 546]);
  assert.deepEqual([0, 1].map(c => colWidth(sheet0(t), c)), [64, 100]);
  for (const [id, params, message] of [
    ['home.rowHeight', {height: 547}, 'Row height must be between 0 and 546 pixels (409.5 points).'],
    ['home.rowHeight', {points: 410}, 'Row height must be between 0 and 409.5 points.'],
    ['home.columnWidth', {width: 1801}, 'Column width must be between 0 and 1800 pixels.'],
    ['home.columnWidth', {chars: 256}, 'Column width must be between 0 and 255 characters.'],
  ]) assert.equal((await fails(t, id, params)).message, message);
});
