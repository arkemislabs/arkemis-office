// Ports of the upstream Rust tests for table formulas (Table Layout › Data › Formula): wordcraft
// crates/engine/src/cmd/table_formula.rs `mod tests` at aadb077e072b7de05f724e359d8db82e151f125c.
// Each test names the Rust test it ports.
//
// Behaviour fidelity:
// 1. ArtCraft (table_formula.rs `evaluate`, `evaluate_field`, `format_picture`, `parse_number`):
//    Word's table formula language (cell references from A1, ranges, ABOVE/LEFT/RIGHT/BELOW runs,
//    SUM AVERAGE COUNT MAX MIN PRODUCT ROUND MOD ABS INT SIGN IF AND OR NOT DEFINED TRUE FALSE,
//    comparisons, \# pictures and \* format switches). Word's Formula dialog writes the same field.
// 2. Ours is a line-by-line translation over schema-2 tables (core/quill/lib/table-formula.mjs).
// 3. These tests; tests/quill/table.test.mjs runs table.formula through the kernel (one undo step)
//    and the Formula dialog's model; tests/e2e/quill/table-layout.e2e.mjs drives the dialog.

import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, evaluateField, formatPicture, parseNumber, cellRef, splitSwitch, MAX_FORMULA} from '../../../core/quill/lib/table-formula.mjs';
import {newTable} from '../../../core/quill/model/table.mjs';
import {paragraphWithText} from '../../../core/quill/model/para.mjs';

let n = 0;
const id = () => `x${++n}`;
function table(rows) {
  const cols = Math.max(1, ...rows.map(r => r.length));
  const t = newTable(rows.length, cols, 468, id);
  return {...t, rows: t.rows.map((row, r) => ({...row, cells: row.cells.map((cl, c) => (rows[r][c] === undefined ? cl : {...cl, blocks: [paragraphWithText(rows[r][c], {}, id())]}))}))};
}
const ev = (t, r, c, f) => evaluate(t, r, c, f);
const err = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected an error'); };

test('table_formula.rs sign_of_zero_is_zero', () => {
  const t = table([['0', '5', '-5']]);
  assert.equal(ev(t, 0, 0, '=SIGN(0)'), 0);
  assert.ok(Object.is(ev(t, 0, 0, '=SIGN(-0)') + 0, 0));
  assert.equal(ev(t, 0, 1, '=SIGN(A1)'), 0, 'a cell holding 0');
  assert.equal(ev(t, 0, 0, '=SIGN(5)'), 1);
  assert.equal(ev(t, 0, 0, '=SIGN(-5)'), -1);
});

test('table_formula.rs cell_references_count_from_one_and_from_a', () => {
  assert.deepEqual(cellRef('A1'), [0, 0]);
  assert.deepEqual(cellRef('B4'), [3, 1]);
  assert.deepEqual(cellRef('AA2'), [1, 26]);
  assert.equal(cellRef('A0'), null);
  assert.equal(cellRef('1A'), null);
});

test('table_formula.rs a_run_of_numbers_above_is_summed_after_skipping_cells_without_numbers', () => {
  let t = table([['5'], ['x'], ['2'], ['']]);
  assert.equal(ev(t, 3, 0, '=SUM(ABOVE)'), 2, 'text stops the run');
  assert.equal(ev(t, 2, 0, '=SUM(ABOVE)'), 5, 'text directly above is skipped');
  t = table([['5'], [''], [''], ['']]);
  assert.equal(ev(t, 3, 0, '=SUM(ABOVE)'), 5);
  t = table([['5'], ['3'], [''], ['9'], ['']]);
  assert.equal(ev(t, 4, 0, '=SUM(ABOVE)'), 9);
  t = table([['x'], ['5'], ['']]);
  assert.equal(ev(t, 2, 0, '=SUM(ABOVE)'), 5);
});

test('table_formula.rs a_function_needs_its_arguments', () => {
  const t = table([['1'], ['']]);
  err(() => ev(t, 1, 0, '=SUM()'));
  err(() => ev(t, 1, 0, '=SUM'));
});

test('table_formula.rs unknown_functions_are_errors_not_sums', () => {
  const t = table([['1'], ['4'], ['7'], ['']]);
  assert.match(err(() => ev(t, 3, 0, '=MEDIAN(ABOVE)')).message, /MEDIAN/);
});

test('table_formula.rs round_large_values_return_input', () => {
  const t = table([['1', '2'], ['3', '4'], ['', '']]);
  const big = `1${'0'.repeat(300)}`;
  assert.equal(ev(t, 2, 0, `=ROUND(${big},15)`), 1e300);
  assert.equal(ev(t, 2, 0, `=ROUND(${big},2)`), 1e300);
});

test('table_formula.rs ranges_and_references_and_operators', () => {
  const t = table([['1', '2'], ['3', '4'], ['', '']]);
  assert.equal(ev(t, 2, 0, '=SUM(A1:B2)'), 10);
  assert.equal(ev(t, 2, 1, '=A1*B2+1'), 5);
  assert.equal(ev(t, 2, 0, '=(A1+A2)/2'), 2);
  assert.equal(ev(t, 2, 0, '=2^3-(-1)'), 9);
  assert.equal(ev(t, 2, 0, '=AVERAGE(A1:B2)'), 2.5);
  assert.equal(ev(t, 2, 0, '=MAX(A1:B2)'), 4);
  assert.equal(ev(t, 2, 0, '=ROUND(2.5, 0)'), 3);
  assert.equal(ev(t, 2, 0, '=MOD(7, 3)'), 1);
});

test('table_formula.rs range_over_spanning_cells_counts_each_cell_once', () => {
  let t = table([['50', '10'], ['', '']]);
  t = {...t, grid: [156, 156, 156], rows: t.rows.map((row, r) => (r === 0 ? {...row, cells: row.cells.map((c, i) => (i === 0 ? {...c, props: {...c.props, span: 2}} : c))} : row))};
  assert.equal(ev(t, 1, 0, '=SUM(A1:B1)'), 50);
  assert.equal(ev(t, 1, 0, '=COUNT(A1:B1)'), 1);
  assert.equal(ev(t, 1, 0, '=SUM(A1:C1)'), 60);
});

test('table_formula.rs division_by_zero_and_bad_syntax_are_errors', () => {
  const t = table([['1'], ['0']]);
  for (const f of ['=A1/A2', '=SUM(A1', '=A1 A1', '=A1:', `=${'('.repeat(64)}`]) err(() => ev(t, 1, 0, f));
});

test('table_formula.rs numbers_read_currency_and_separators_but_not_letters', () => {
  assert.equal(parseNumber('$1,200', null), 1200);
  assert.equal(parseNumber(' 12% ', null), 12);
  assert.equal(parseNumber('(5)', null), -5);
  for (const bad of ['x9', '1a', 'inf', '']) assert.equal(parseNumber(bad, null), null, bad);
  assert.equal(parseNumber('3,50', 'pl-PL'), 3.5);
});

test('table_formula.rs comparisons_give_one_or_zero_and_do_not_chain', () => {
  const t = table([['5'], ['3']]);
  assert.equal(ev(t, 1, 0, '=A1>A2'), 1);
  assert.equal(ev(t, 1, 0, '=A1<=A2'), 0);
  assert.equal(ev(t, 1, 0, '=A1<>A2'), 1);
  assert.equal(ev(t, 1, 0, '=A2>=3'), 1);
  assert.equal(ev(t, 1, 0, '=A1=5'), 1);
  assert.equal(err(() => ev(t, 1, 0, '=A1<A2<1')).message, 'syntax error: unexpected text after the formula');
});

test('table_formula.rs if_and_or_not_and_the_truth_values', () => {
  const t = table([['5', 'x'], ['3', '']]);
  assert.equal(ev(t, 1, 0, '=IF(A1>A2, 10, 20)'), 10);
  assert.equal(ev(t, 1, 0, '=IF(A1<A2, 10, 20)'), 20);
  assert.equal(ev(t, 1, 0, '=IF(A1>A2, 1, B1+1)'), 1, 'the branch not taken is not worked out');
  err(() => ev(t, 1, 0, '=IF(A1<A2, 1, B1+1)'));
  assert.equal(ev(t, 1, 0, '=AND(A1>1, A2>1)'), 1);
  assert.equal(ev(t, 1, 0, '=AND(A1>1, A2>4)'), 0);
  assert.equal(ev(t, 1, 0, '=OR(A1<1, A2>1)'), 1);
  assert.equal(ev(t, 1, 0, '=OR(A1<1, A2<1)'), 0);
  assert.equal(ev(t, 1, 0, '=NOT(A1<1)'), 1);
  assert.equal(ev(t, 1, 0, '=TRUE'), 1);
  assert.equal(ev(t, 1, 0, '=FALSE()'), 0);
  for (const f of ['=TRUE(1)', '=IF(A1>A2, 1)', '=AND()']) err(() => ev(t, 1, 0, f));
});

test('table_formula.rs defined_says_whether_a_cell_holds_a_value', () => {
  const t = table([['5', 'x', '']]);
  assert.equal(ev(t, 0, 0, '=DEFINED(A1)'), 1);
  assert.equal(ev(t, 0, 0, '=DEFINED(B1)'), 0);
  assert.equal(ev(t, 0, 0, '=DEFINED(C1)'), 0);
  assert.equal(ev(t, 0, 0, '=IF(DEFINED(C1), C1, 7)'), 7);
});

test('table_formula.rs a_numeric_picture_formats_the_result', () => {
  assert.equal(formatPicture(1234.5, '#,##0.00'), '1,234.50');
  assert.equal(formatPicture(0.256, '0%'), '26%');
  assert.equal(formatPicture(2.0, '#.##'), '2');
  assert.equal(formatPicture(0.05, '0.0'), '0.1');
  assert.equal(formatPicture(-5.0, '$#,##0'), '-$5');
  assert.equal(formatPicture(-5.0, '$#,##0.00;($#,##0.00)'), '($5.00)');
  assert.equal(formatPicture(0.0, '0.00;-;zero'), 'zero');
  assert.equal(formatPicture(7.0, '000'), '007');
  assert.equal(formatPicture(-0.001, '0.00'), '0.00');
});

test('table_formula.rs a_field_switch_picks_the_picture_and_the_formula_stays_apart_from_it', () => {
  const t = table([['1234.5'], ['']]);
  assert.deepEqual(splitSwitch('=A1 \\# "0.00"'), ['=A1', '\\# "0.00"']);
  assert.deepEqual(splitSwitch('=A1'), ['=A1', null]);
  const shown = f => evaluateField(t, 1, 0, f);
  assert.equal(shown('=A1 \\# "#,##0.00"'), '1,234.50');
  assert.equal(shown('=A1'), '1234.50');
  assert.equal(shown('=A1 \\# 0'), '1235');
  assert.equal(shown('=A1 \\# ""'), '1234.50');
});

test('table_formula.rs a_format_switch_writes_the_result_as_text_and_sets_its_capitals', () => {
  const t = table([['790'], ['1.5'], ['']]);
  assert.deepEqual(splitSwitch('=A1 \\* Caps \\# 0'), ['=A1', '\\* Caps \\# 0']);
  const shown = f => evaluateField(t, 2, 0, f);
  const cases = [['=A1 \\* CardText', 'seven hundred ninety'], ['=A1 \\* CardText \\* Caps', 'Seven Hundred Ninety'],
    ['=A1 \\* OrdText \\* FirstCap', 'Seven hundred ninetieth'], ['=A1 \\* roman', 'dccxc'], ['=A1 \\* MERGEFORMAT', '790'],
    ['=A1 \\# "#,##0.00" \\* MERGEFORMAT', '790.00'], ['=A1 \\* MERGEFORMAT \\# 0.0', '790.0'], ['=A1 \\# "0 \\* CardText items"', '790 \\* CardText items'],
    ['=A2 \\* CardText', '1.50'], ['=A1-800 \\* CardText', '-10'], ['=A1*1266 \\* CardText', '1000140'], ['=A1*1266 \\* OrdText \\* Upper', '1000140'],
    ['=A1*64 \\* roman', '50560'], ['=A1-790 \\* roman', '0'], ['=A1 \\* alphabetic', '790']];
  for (const [f, want] of cases) assert.equal(shown(f), want, f);
});

test('table_formula.rs dollar_text_and_hex_switches_write_the_result', () => {
  const t = table([['9.20', '5.35'], ['458', '-1'], ['', '']]);
  const shown = f => evaluateField(t, 2, 0, f);
  assert.equal(shown('= 9.20 + 5.35 \\* DollarText \\* Upper'), 'FOURTEEN AND 55/100');
  assert.equal(shown('=A1+B1 \\* DollarText'), 'fourteen and 55/100');
  assert.equal(shown('=A2 \\* DollarText \\* FirstCap'), 'Four hundred fifty-eight and 00/100');
  assert.equal(shown('=0.999 \\* DollarText'), 'one and 00/100');
  assert.equal(shown('=A2 \\* Hex'), '1CA');
  assert.equal(shown('=A2 \\* Hex \\* Lower'), '1ca');
  assert.equal(shown('=A2*0 \\* Hex'), '0');
  assert.equal(shown('=B2 \\* DollarText'), shown('=B2'));
  assert.equal(shown('=B2 \\* Hex'), shown('=B2'));
  assert.equal(shown('=A2/4 \\* Hex'), shown('=A2/4'));
  assert.equal(shown('=A2*2200 \\* DollarText'), shown('=A2*2200'));
  assert.equal(shown('=A2 \\* ArabicDash'), '- 458 -');
});

test('table_formula.rs a_huge_range_over_a_small_table_reads_only_the_table', () => {
  const t = table([['1', '2', '3'], ['4', '5', '6'], ['', '', '']]);
  const f = `=SUM(${Array(40).fill('A1:BK32767').join(',')})`;
  assert.ok(f.length <= MAX_FORMULA);
  assert.equal(ev(t, 2, 0, f), 21 * 40);
});

test('table_formula.rs an_evaluation_past_the_cell_budget_is_an_error', () => {
  let t = newTable(1000, 10, 468, id);
  t = {...t, rows: t.rows.map((row, r) => (r === 0 ? {...row, cells: row.cells.map((c, i) => (i === 0 ? {...c, blocks: [paragraphWithText('1', {}, id())]} : c))} : row))};
  assert.equal(ev(t, 0, 1, `=SUM(${Array(10).fill('A1:J1000').join(',')})`), 10);
  const tooMuch = `=SUM(${Array(11).fill('A1:J1000').join(',')})`;
  assert.equal(err(() => ev(t, 0, 1, tooMuch)).message, 'Formula too complex');
  assert.equal(err(() => evaluateField(t, 0, 1, tooMuch)).message, 'Formula too complex');
});

test('table_formula.rs deep_power_and_sign_chains_are_rejected', () => {
  const t = table([['1']]);
  assert.equal(ev(t, 0, 0, '=2^3^2'), 512);
  assert.equal(ev(t, 0, 0, '=-+-+2'), 2);
  for (const f of [`=${'1^'.repeat(40)}1`, `=${'+'.repeat(40)}1`, `=${'-+'.repeat(20)}1`]) assert.match(err(() => ev(t, 0, 0, f)).message, /nested too deeply/, f);
});
