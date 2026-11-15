// Ported from gridcraft crates/engine/src/fill.rs (#[cfg(test)] mod tests) and the fill tests of
// crates/engine/src/tests.rs at 146161b4b450a56e5e59a083ba0478582d1e602b (Rust test names in titles).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: cmd/edit/fill.rs `auto_fill` (the fill handle, Ctrl+drag, the right-drag menu's
//    Fill Series / Fill Without Formatting / Fill Days..Years), `fill_series` (Series dialog),
//    `flash_fill` (Flash Fill learning from examples), fill.rs patterns. Excel: dragging 1,3 gives
//    5,7,9...; Ctrl+drag swaps copy and series; Mon → Tue; Item 9 → Item 10; Fill Weekdays skips
//    weekends; Fill Months clamps to the month's end; a target that does not hold the source in a
//    corner is refused.
// 2. Ours runs the same commands, through the foundation's translated fill.rs, on schema-2
//    workbooks, writing through the kernel (one undo step each).
// 3. These tests; the fill-handle drag through the surface is tests/e2e/grid/edit-cells.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {session, workbook, v, text, style, run, fails} from '../edit-helpers.mjs';
import {holdsSourceInCorner, startsWithDate, splitNum} from '../../../core/grid/model/fill.mjs';
import {learn} from '../../../core/grid/lib/edit-series.mjs';
import {parseRange} from '../../../core/grid/lib/addr.mjs';
import {serialFromYmd} from '../../../core/grid/lib/date.mjs';

const ymd = (y, m, d, sys = 1900) => serialFromYmd(sys, y, m, d);

test('flash_programs', () => {
  let p = learn([['John Smith', 'Smith, John']]);
  assert.equal(p.apply('Ada Lovelace'), 'Lovelace, Ada');
  p = learn([['jane doe', 'JD']]);
  assert.equal(p.apply('alan turing'), 'AT');
  p = learn([['alice@example.com', 'alice']]);
  assert.equal(p.apply('bob@example.com'), 'bob');
});

test('flash_fill_reads_shown_text', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [['2024-01-15', '15/01/2024'], ['2023-12-03', null]]});
  await run(t, 'selection.set', {cell: 'B2'});
  await run(t, 'edit.flashFill', {});
  assert.equal(v(t, 'B2'), '03/12/2023');
});

test('split_numbers', () => {
  assert.deepEqual(splitNum('Item 7'), ['Item ', 7n, '', 1]);
  assert.deepEqual(splitNum('Q003x'), ['Q', 3n, 'x', 3]);
  assert.equal(splitNum('abc'), null);
});

test('times_quarters_ordinals_and_mixed_sources', async () => {
  const t = await session();
  const fill = async (values, source, target) => {
    await run(t, 'range.setValues', {range: source.slice(0, 2), values});
    await run(t, 'edit.autoFill', {source, target});
    const r = parseRange(target);
    const out = [];
    for (let row = r.start.row; row <= r.end.row; row++) out.push(text(t, `${String.fromCharCode(65 + r.start.col)}${row + 1}`));
    return out;
  };
  assert.deepEqual(await fill([['9:00']], 'A1', 'A1:A3'), ['9:00', '10:00', '11:00']);
  assert.deepEqual(await fill([['Qtr3']], 'B1', 'B1:B3'), ['Qtr3', 'Qtr4', 'Qtr1']);
  assert.deepEqual(await fill([['Quarter 4']], 'C1', 'C1:C2'), ['Quarter 4', 'Quarter 1']);
  assert.deepEqual(await fill([['1st Period']], 'D1', 'D1:D4'), ['1st Period', '2nd Period', '3rd Period', '4th Period']);
  assert.deepEqual(await fill([['Product 1'], ['On backorder']], 'E1:E2', 'E1:E6'), ['Product 1', 'On backorder', 'Product 2', 'On backorder', 'Product 3', 'On backorder']);
});

test('falling_growth_series_stops_at_its_stop_value', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: '5'});
  await run(t, 'edit.fillSeries', {range: 'A1:A6', type: 'growth', step: 0.5, stop: 1});
  assert.deepEqual(['A2', 'A3', 'A4', 'A5', 'A6'].map(a => text(t, a)), ['2.5', '1.25', '', '', '']);
});

test('text_series_near_i64_max_neither_wraps_nor_panics', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: 'X 0'});
  await run(t, 'cell.set', {cell: 'A2', input: 'X 9223372036854775807'});
  await run(t, 'edit.autoFill', {source: 'A1:A2', target: 'A1:A3'});
  assert.equal(text(t, 'A3'), 'X 0');
});

test('autofill_refuses_targets_that_do_not_extend_the_source', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A2', values: [[1, 'Item 1'], [2, 'Item 2']]});
  await run(t, 'range.setValues', {range: 'H4', values: [[10], [20]]});
  const before = JSON.stringify(t.content.sheets[0].blocks);
  for (const [mode, source, target] of [
    ['series', '2:3', 'A:A'], ['alternate', '2:3', 'A:A'], ['series', '8:10', 'C:E'], ['copy', '24:24', 'B:D'], ['values', 'H4:H9', 'D:F'],
    ['series', 'H4:H9', 'H:H'], ['series', 'A2:A3', 'A1:A5'], ['series', 'A2:A6', 'A2:A4'], ['series', 'B2:B3', 'A2:A3'],
  ]) {
    await fails(t, 'edit.autoFill', {mode, source, target});
  }
  assert.equal(JSON.stringify(t.content.sheets[0].blocks), before, 'a refused fill writes nothing');
  // Targets holding the source in a corner still fill, whole rows and diagonal drags included.
  await run(t, 'edit.autoFill', {source: '2:3', target: '2:6'});
  await run(t, 'edit.autoFill', {source: 'A2:A3', target: 'A1:A3'});
  assert.deepEqual([text(t, 'A1'), text(t, 'A6'), text(t, 'B6')], ['0', '5', 'Item 5']);
  assert.ok(holdsSourceInCorner(parseRange('B5'), parseRange('B3:B5')));
  assert.ok(holdsSourceInCorner(parseRange('A:A'), parseRange('A:C')));
  assert.ok(holdsSourceInCorner(parseRange('B5:C9'), parseRange('B5:D13')));
  assert.ok(holdsSourceInCorner(parseRange('B1:B2'), parseRange('A1:B4')));
  assert.ok(!holdsSourceInCorner(parseRange('A:A'), parseRange('1:1')));
});

test('fill_series', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [[1], [3]]});
  await run(t, 'edit.autoFill', {source: 'A1:A2', target: 'A1:A6'});
  assert.equal(v(t, 'A6'), 11);
  await run(t, 'cell.set', {cell: 'B1', input: 'Mon'});
  await run(t, 'edit.autoFill', {source: 'B1', target: 'B1:B3'});
  assert.equal(v(t, 'B3'), 'Wed');
  await run(t, 'cell.set', {cell: 'C1', input: 'Item 9'});
  await run(t, 'edit.autoFill', {source: 'C1', target: 'C1:C2'});
  assert.equal(v(t, 'C2'), 'Item 10');
});

test('ctrl_drag_fill_swaps_copy_and_series', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: '7'});
  await run(t, 'edit.autoFill', {source: 'A1', target: 'A1:A4'});
  assert.equal(v(t, 'A4'), 7, 'a plain drag copies a lone number');
  await run(t, 'edit.autoFill', {source: 'A1', target: 'A1:A4', mode: 'alternate'});
  assert.equal(v(t, 'A2'), 8);
  assert.equal(v(t, 'A4'), 10);
  await run(t, 'cell.set', {cell: 'B5', input: '7'});
  await run(t, 'edit.autoFill', {source: 'B5', target: 'B3:B5', mode: 'alternate'});
  assert.equal(v(t, 'B3'), 5);
  await run(t, 'range.setValues', {range: 'C1', values: [[1], [3]]});
  await run(t, 'edit.autoFill', {source: 'C1:C2', target: 'C1:C4', mode: 'alternate'});
  assert.equal(v(t, 'C3'), 1);
  assert.equal(v(t, 'C4'), 3);
  await run(t, 'cell.set', {cell: 'D1', input: 'Mon'});
  await run(t, 'edit.autoFill', {source: 'D1', target: 'D1:D3', mode: 'alternate'});
  assert.equal(v(t, 'D3'), 'Mon');
  await run(t, 'cell.set', {cell: 'E1', input: 'Item 9'});
  await run(t, 'edit.autoFill', {source: 'E1', target: 'E1:E2', mode: 'alternate'});
  assert.equal(v(t, 'E2'), 'Item 9');
  await run(t, 'cell.set', {cell: 'F1', input: 'abc'});
  await run(t, 'edit.autoFill', {source: 'F1', target: 'F1:F2', mode: 'alternate'});
  assert.equal(v(t, 'F2'), 'abc');
  await run(t, 'edit.autoFill', {source: 'G1', target: 'G1:G3', mode: 'alternate'});
  assert.equal(v(t, 'G3'), null);
});

test('fill_series_from_the_right_drag_menu_counts_a_lone_number', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: '7'});
  await run(t, 'edit.autoFill', {source: 'A1', target: 'A1:A3', mode: 'extend'});
  assert.deepEqual([v(t, 'A2'), v(t, 'A3')], [8, 9]);
  await run(t, 'range.setValues', {range: 'B1', values: [[1], [3]]});
  await run(t, 'edit.autoFill', {source: 'B1:B2', target: 'B1:B4', mode: 'extend'});
  assert.deepEqual([v(t, 'B3'), v(t, 'B4')], [5, 7]);
  await run(t, 'cell.set', {cell: 'C1', input: 'Item 9'});
  await run(t, 'edit.autoFill', {source: 'C1', target: 'C1:C2', mode: 'extend'});
  assert.equal(v(t, 'C2'), 'Item 10');
  await run(t, 'range.setValues', {range: 'D1', values: [['Product 1'], ['On backorder']]});
  await run(t, 'edit.autoFill', {source: 'D1:D2', target: 'D1:D4', mode: 'extend'});
  assert.deepEqual([v(t, 'D3'), v(t, 'D4')], ['Product 2', 'On backorder']);
});

test('fill_without_formatting_extends_the_series_and_keeps_the_target_formats', async () => {
  // Bold A1:A2 and italic A4 are styles 1 and 2 (home.bold / home.italic belong to U:grid/format).
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A1: {v: 1, s: 1}, A2: {v: 2, s: 1}, A4: {v: 9, s: 2}}}}],
    {styles: [{}, {font: {bold: true}}, {font: {italic: true}}]}));
  await run(t, 'edit.autoFill', {source: 'A1:A2', target: 'A1:A4', mode: 'values'});
  assert.deepEqual([v(t, 'A3'), v(t, 'A4')], [3, 4]);
  assert.ok(style(t, 'A4').font.italic && !style(t, 'A4').font.bold, 'A4 keeps its own formats');
  assert.ok(!style(t, 'A3').font.bold);
  await run(t, 'range.setValues', {range: 'B1', values: [['Product 1'], ['On backorder']]});
  await run(t, 'edit.autoFill', {source: 'B1:B2', target: 'B1:B4', mode: 'values'});
  assert.deepEqual([v(t, 'B3'), v(t, 'B4')], ['Product 2', 'On backorder']);
});

test('fill_days_weekdays_months_and_years_step_a_date_by_that_unit', async () => {
  const t = await session();
  const serials = cells => cells.map(c => v(t, c));
  await run(t, 'cell.set', {cell: 'A1', input: '1/30/2026'});
  assert.equal(v(t, 'A1'), 46052, 'setup: a date');
  await run(t, 'edit.autoFill', {source: 'A1', target: 'A1:A4', mode: 'days'});
  assert.deepEqual(serials(['A2', 'A3', 'A4']), [46053, 46054, 46055]);
  await run(t, 'edit.autoFill', {source: 'A1', target: 'A1:A4', mode: 'weekdays'});
  assert.deepEqual(serials(['A2', 'A3', 'A4']), [46055, 46056, 46057]);
  await run(t, 'cell.set', {cell: 'B1', input: '1/31/2026'});
  await run(t, 'edit.autoFill', {source: 'B1', target: 'B1:B3', mode: 'weekdays'});
  assert.deepEqual(serials(['B2', 'B3']), [46055, 46056]);
  await run(t, 'edit.autoFill', {source: 'B1', target: 'B1:B4', mode: 'months'});
  assert.deepEqual(serials(['B2', 'B3', 'B4']), [46081, 46112, 46142]);
  await run(t, 'edit.autoFill', {source: 'B1', target: 'B1:B3', mode: 'years'});
  assert.deepEqual(serials(['B2', 'B3']), [46418, 46783]);
  await run(t, 'cell.set', {cell: 'C1', input: '1/15/2026'});
  await run(t, 'cell.set', {cell: 'C2', input: '3/15/2026'});
  await run(t, 'edit.autoFill', {source: 'C1:C2', target: 'C1:C4', mode: 'months'});
  assert.deepEqual(serials(['C3', 'C4']), [46157, 46218]);
  await run(t, 'cell.set', {cell: 'D1', input: '2/2/2026'});
  await run(t, 'cell.set', {cell: 'D2', input: '2/4/2026'});
  await run(t, 'edit.autoFill', {source: 'D1:D2', target: 'D1:D4', mode: 'weekdays'});
  assert.deepEqual(serials(['D3', 'D4']), [46059, 46063]);
  await run(t, 'cell.set', {cell: 'E5', input: '2/2/2026'});
  await run(t, 'edit.autoFill', {source: 'E5', target: 'E3:E5', mode: 'weekdays'});
  assert.deepEqual(serials(['E4', 'E3']), [46052, 46051]);
  await run(t, 'cell.set', {cell: 'F1', input: '7'});
  await run(t, 'edit.autoFill', {source: 'F1', target: 'F1:F2', mode: 'days'});
  assert.equal(v(t, 'F2'), 7);
  await run(t, 'cell.set', {cell: 'H1', input: '1/31/2026 12:00'});
  assert.equal(v(t, 'H1'), 46053.5, 'setup: a date and time');
  await run(t, 'edit.autoFill', {source: 'H1', target: 'H1:H2', mode: 'months'});
  assert.equal(v(t, 'H2'), 46081.5);
  await run(t, 'edit.autoFill', {source: 'H1', target: 'H1:H2', mode: 'weekdays'});
  assert.equal(v(t, 'H2'), 46055.5);
  await run(t, 'cell.set', {cell: 'I1', input: '1/15/2026 6:00'});
  await run(t, 'cell.set', {cell: 'I2', input: '2/15/2026 6:00'});
  await run(t, 'edit.autoFill', {source: 'I1:I2', target: 'I1:I3'});
  assert.equal(v(t, 'I3'), 46096.25);
  await run(t, 'cell.set', {cell: 'J1', input: '1/31/2026 12:00'});
  await run(t, 'edit.fillSeries', {range: 'J1:J2', type: 'date', dateUnit: 'month'});
  assert.equal(v(t, 'J2'), 46081.5);
});

test('only_a_number_in_a_date_format_offers_the_date_fills', async () => {
  const t = await session(workbook([{id: 's1', name: 'Sheet1', blocks: {0: {A2: {v: 7, s: 1}, A3: {v: 46053, s: 2}}}}],
    {styles: [{}, {numFmt: '0 "days"'}, {numFmt: 'YYYY-MM-DD'}]}));
  await run(t, 'cell.set', {cell: 'A1', input: '1/31/2026'});
  await run(t, 'cell.set', {cell: 'A4', input: '=A1'});
  await run(t, 'cell.set', {cell: 'A5', input: '13:30'});
  const dates = a => startsWithDate(t.content, 0, parseRange(a));
  assert.ok(dates('A1') && dates('A3'), 'm/d/yyyy and YYYY-MM-DD are dates');
  assert.ok(!dates('A2'), 'quoted text in a number format is not a date field');
  assert.ok(!dates('A4'), 'a formula is not offered');
  assert.ok(!dates('A5'), 'a time is not a date');
  assert.ok(!dates('A6'), 'an empty cell is not a date');
});

const seriesDate = async (seed, range, unit) => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: seed});
  await run(t, 'edit.fillSeries', {range, direction: 'columns', type: 'date', dateUnit: unit});
  return t;
};

test('fill_series_month_clamps_to_month_end', async () => {
  let t = await seriesDate('2026-01-31', 'A1:A4', 'month');
  assert.deepEqual(['A1', 'A2', 'A3', 'A4'].map(a => v(t, a)), [ymd(2026, 1, 31), ymd(2026, 2, 28), ymd(2026, 3, 31), ymd(2026, 4, 30)]);
  t = await seriesDate('2026-01-15', 'A1:A4', 'month');
  assert.equal(v(t, 'A4'), ymd(2026, 4, 15));
});

test('fill_series_weekday_out_of_range_step_errors', async () => {
  const t = await session();
  await run(t, 'cell.set', {cell: 'A1', input: '45000'});
  await fails(t, 'edit.fillSeries', {range: 'A1:A2', direction: 'columns', type: 'date', dateUnit: 'weekday', step: 1e12});
  assert.equal(v(t, 'A2'), null);
});

test('fill_series_month_leap_year', async () => {
  let t = await seriesDate('2028-01-31', 'A1:A3', 'month');
  assert.equal(v(t, 'A2'), ymd(2028, 2, 29));
  assert.equal(v(t, 'A3'), ymd(2028, 3, 31));
  t = await seriesDate('1996-01-31', 'A1:A3', 'month');
  assert.equal(v(t, 'A2'), ymd(1996, 2, 29));
});

test('fill_series_year_clamps_leap_day', async () => {
  const t = await seriesDate('2028-02-29', 'A1:A5', 'year');
  assert.equal(v(t, 'A2'), ymd(2029, 2, 28));
  assert.equal(v(t, 'A5'), ymd(2032, 2, 29));
});

test('autofill_month_pattern_uses_workbook_date_system', async () => {
  for (const sys of [1900, 1904]) {
    for (const [source, target, seeds, expected] of [
      ['A1:A2', 'A1:A6', ['2026-01-31', '2026-03-31'], ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-09-30', '2026-11-30']],
      ['A5:A6', 'A1:A6', ['2026-09-30', '2026-11-30'], ['2026-01-30', '2026-03-30', '2026-05-30', '2026-07-30', '2026-09-30', '2026-11-30']],
    ]) {
      const t = await session(workbook(undefined, {dateSystem: sys}));
      await run(t, 'range.setValues', {range: parseRangeStart(source), values: [[seeds[0]], [seeds[1]]]});
      await run(t, 'edit.autoFill', {source, target});
      expected.forEach((d, row) => {
        const [y, m, dd] = d.split('-').map(Number);
        assert.equal(v(t, `A${row + 1}`), ymd(y, m, dd, sys), `${sys} ${source} -> ${target}, A${row + 1}: ${d}`);
      });
    }
  }
});
const parseRangeStart = a => a.split(':')[0];

test('autofill_month_pattern_clamps_to_month_end', async () => {
  const t = await session();
  await run(t, 'range.setValues', {range: 'A1', values: [['2026-01-31'], ['2026-03-31']]});
  await run(t, 'edit.autoFill', {source: 'A1:A2', target: 'A1:A6'});
  assert.deepEqual(['A3', 'A4', 'A5', 'A6'].map(a => v(t, a)), [ymd(2026, 5, 31), ymd(2026, 7, 31), ymd(2026, 9, 30), ymd(2026, 11, 30)]);
});
