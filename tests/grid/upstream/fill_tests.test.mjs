// Port of the #[test] functions in gridcraft crates/engine/src/fill.rs
// (146161b4b450a56e5e59a083ba0478582d1e602b). Each test names the Rust test it translates.
// Typing goes through model.enterInput (cell.rs `input_to_cell`) and AutoFill through model.fill,
// the foundation functions U:grid/edit's `cell.set`, `range.setValues` and `edit.autoFill` call.
// Not ported here: flash_fill_reads_shown_text and flash_programs (Flash Fill belongs to the edit
// unit's data.flashFill), falling_growth_series_stops_at_its_stop_value (edit.fillSeries, the
// Series dialog), and the command-level refusals of autofill_refuses_targets_that_do_not_extend_the_source
// (edit.autoFill); its holds_source_in_corner assertions are ported below.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTransaction} from '../../../core/kernel/change.mjs';
import {createContent} from '../../../core/grid/schema.mjs';
import {applyGridOp} from '../../../core/grid/model/structure.mjs';
import * as model from '../../../core/grid/model/index.mjs';
import {parseRange} from '../../../core/grid/lib/addr.mjs';

function book() {
  let content = createContent('t', {id: 's1'});
  const edit = fn => { const tx = createTransaction({content}, {appApply: applyGridOp}); fn(tx.api, tx.content); content = tx.content; };
  return {
    get content() { return content; },
    setValues(at, rows) {
      const a = parseRange(at).start;
      rows.forEach((row, i) => row.forEach((v, j) => edit((api, c) => model.enterInput(api, c, 0, a.row + i, a.col + j, v === null ? '' : String(v)))));
    },
    set(at, input) { const a = parseRange(at).start; edit((api, c) => model.enterInput(api, c, 0, a.row, a.col, input)); },
    autoFill(source, target, mode = 'series') { edit((api, c) => model.fill(api, c, 0, parseRange(source), parseRange(target), mode)); },
    text(at) { const a = parseRange(at).start; return model.displayAt(content, 0, a.row, a.col).text; },
    texts(range) {
      const r = parseRange(range), out = [];
      for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) out.push(model.displayAt(content, 0, row, col).text);
      return out;
    },
  };
}

test('split_numbers', () => {
  assert.deepEqual(model.splitNum('Item 7'), ['Item ', 7n, '', 1]);
  assert.deepEqual(model.splitNum('Q003x'), ['Q', 3n, 'x', 3]);
  assert.equal(model.splitNum('abc'), null);
});

test('times_quarters_ordinals_and_mixed_sources', () => {
  const s = book();
  const fill = (values, source, target) => { s.setValues(source.slice(0, 2), values); s.autoFill(source, target); return s.texts(target); };
  assert.deepEqual(fill([['9:00']], 'A1', 'A1:A3'), ['9:00', '10:00', '11:00']);
  assert.deepEqual(fill([['Qtr3']], 'B1', 'B1:B3'), ['Qtr3', 'Qtr4', 'Qtr1']);
  assert.deepEqual(fill([['Quarter 4']], 'C1', 'C1:C2'), ['Quarter 4', 'Quarter 1']);
  assert.deepEqual(fill([['1st Period']], 'D1', 'D1:D4'), ['1st Period', '2nd Period', '3rd Period', '4th Period']);
  assert.deepEqual(fill([['Product 1'], ['On backorder']], 'E1:E2', 'E1:E6'),
    ['Product 1', 'On backorder', 'Product 2', 'On backorder', 'Product 3', 'On backorder']);
});

test('text_series_near_i64_max_neither_wraps_nor_panics', () => {
  const s = book();
  s.set('A1', 'X 0');
  s.set('A2', 'X 9223372036854775807');
  // The detected step is i64::MAX, so the next value overflows i64: the cell keeps its source value.
  s.autoFill('A1:A2', 'A1:A3');
  assert.equal(s.text('A3'), 'X 0');
});

test('autofill_refuses_targets_that_do_not_extend_the_source (holds_source_in_corner, and fills that do)', () => {
  const s = book();
  s.setValues('A2', [[1, 'Item 1'], [2, 'Item 2']]);
  s.autoFill('2:3', '2:6');
  s.autoFill('A2:A3', 'A1:A3');
  assert.deepEqual([s.text('A1'), s.text('A6'), s.text('B6')], ['0', '5', 'Item 5']);
  const h = (a, b) => model.holdsSourceInCorner(parseRange(a), parseRange(b));
  assert.ok(h('B5', 'B3:B5'));
  assert.ok(h('A:A', 'A:C'));
  assert.ok(h('B5:C9', 'B5:D13'));
  assert.ok(h('B1:B2', 'A1:B4'));
  assert.ok(!h('A:A', '1:1'));
  for (const [source, target] of [['2:3', 'A:A'], ['8:10', 'C:E'], ['24:24', 'B:D'], ['H4:H9', 'D:F'], ['H4:H9', 'H:H'], ['A2:A3', 'A1:A5'], ['A2:A6', 'A2:A4'], ['B2:B3', 'A2:A3']]) {
    assert.ok(!h(source, target), `${source} -> ${target} is not an AutoFill shape`);
  }
});
