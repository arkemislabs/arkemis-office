// Ported from wordcraft crates/doc/src/props.rs and crates/doc/src/table.rs (mod tests) at
// aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test. Upstream's serde
// round trips are checked through JSON.stringify/parse and the read* functions that implement
// upstream's lenient deserializers.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Pr from '../../../core/quill/model/props.mjs';
import * as T from '../../../core/quill/model/table.mjs';

// --- props.rs ---
test('rgb_hex', () => {
  assert.equal(Pr.rgbHex([255, 0, 16]), 'FF0010');
  assert.deepEqual(Pr.parseRgb('#FF0010'), [255, 0, 16]);
  assert.equal(Pr.parseRgb('zzzzzz'), null);
  assert.equal(Pr.parseRgb('é1234'), null);
});

test('rgb_parse_rejects_non_hex', () => {
  for (const bad of ['+1+2+3', '-1-2-3', '##ff0000', 'ff00 0']) assert.equal(Pr.parseRgb(bad), null, bad);
  assert.deepEqual(Pr.parseRgb('#ff0000'), [255, 0, 0]);
  assert.deepEqual(Pr.parseRgb('ff0000'), [255, 0, 0]);
});

test('overlay_keeps_unset', () => {
  const r = Pr.charOverlaid({bold: true, size: 12}, {size: 14, italic: true});
  assert.equal(r.bold, true);
  assert.equal(r.size, 14);
  assert.equal(r.italic, true);
});

test('borders_overlay_per_side', () => {
  const thin = Pr.singleBorder(0.5), thick = Pr.singleBorder(2);
  const nil = Pr.border('none', 0, null, 0);
  let b = Pr.bordersAll(thin);
  b = Pr.bordersOverlaid(b, {top: thick});
  assert.deepEqual(b.top, thick);
  assert.deepEqual(b.bottom, thin);
  b = Pr.bordersOverlaid(b, Pr.bordersBox(nil));
  assert.deepEqual(b.left, nil, 'explicit nil overrides that side');
  assert.deepEqual(b.between, thin, 'untouched sides survive');
  b = Pr.bordersOverlaid(b, {});
  assert.deepEqual(b.left, nil, 'empty patch changes nothing');
});

test('ooxml_names_round_trip', () => {
  for (const u of Pr.UNDERLINES) assert.equal(Pr.underlineFromOoxml(Pr.underlineOoxml(u)), u);
  for (const h of Pr.HIGHLIGHTS) assert.equal(Pr.highlightFromOoxml(Pr.highlightOoxml(h)), h);
});

test('ligature_names', () => {
  const l = (standard, contextual, historical, discretional) => ({standard, contextual, historical, discretional});
  for (const [name, flags] of [
    ['none', l(false, false, false, false)], ['standard', l(true, false, false, false)], ['contextual', l(false, true, false, false)],
    ['historical', l(false, false, true, false)], ['discretional', l(false, false, false, true)], ['standardContextual', l(true, true, false, false)],
    ['standardHistorical', l(true, false, true, false)], ['contextualHistorical', l(false, true, true, false)], ['standardDiscretional', l(true, false, false, true)],
    ['contextualDiscretional', l(false, true, false, true)], ['historicalDiscretional', l(false, false, true, true)],
    ['standardContextualHistorical', l(true, true, true, false)], ['standardContextualDiscretional', l(true, true, false, true)],
    ['standardHistoricalDiscretional', l(true, false, true, true)], ['contextualHistoricalDiscretional', l(false, true, true, true)], ['all', l(true, true, true, true)],
  ]) {
    assert.deepEqual(Pr.ligaturesFromOoxml(name), flags, name);
    assert.equal(Pr.ligaturesOoxml(flags), name);
  }
  assert.equal(Pr.allLigatures().length, 16);
  for (const bad of ['', 'Standard', 'contextualStandard', 'standardstandard', 'allx']) assert.equal(Pr.ligaturesFromOoxml(bad), null, bad);
});

test('text_direction_names', () => {
  let d = 'horizontal';
  for (let i = 0; i < 3; i++) { assert.equal(Pr.textDirectionFromOoxml(Pr.textDirectionOoxml(d)), d); d = Pr.textDirectionNext(d); }
  assert.equal(d, 'horizontal', 'the button cycles through three directions');
  assert.equal(Pr.textDirectionFromOoxml('rl'), 'down');
  assert.equal(Pr.textDirectionFromOoxml('lr'), 'up');
  assert.equal(Pr.textDirectionFromOoxml('tbRlV'), 'down');
  assert.equal(Pr.textDirectionFromOoxml('tb'), 'horizontal');
  assert.equal(Pr.textDirectionFromOoxml('lrTbV'), 'horizontal');
  assert.equal(Pr.textDirectionFromOoxml('é?'), 'horizontal');
});

test('text_color_reads_hex_and_keeps_its_serialized_forms', () => {
  const read = j => Pr.readTextColor(JSON.parse(j));
  const ink = {Rgb: [0x1b, 0x16, 0x11]};
  assert.deepEqual(read('"1B1611"'), ink);
  assert.deepEqual(read('"#1b1611"'), ink);
  assert.equal(read('"auto"'), 'Auto');
  assert.equal(read('"Automatic"'), 'Auto');
  for (const [c, j] of [['Auto', '"Auto"'], [ink, '{"Rgb":[27,22,17]}']]) {
    assert.equal(JSON.stringify(c), j, 'written as before');
    assert.deepEqual(read(j), c);
  }
  for (const bad of ['"1B161"', '"zzzzzz"', '""', '{"Rgb":"1B16"}', '{"Rgb":[1,2]}', '{"Hex":[1,2,3]}', '7', '[27,22,17]']) assert.equal(read(bad), null, bad);
  assert.deepEqual(read('{"Rgb":"1B1611"}'), ink);
});

test('rgb_reads_hex_and_keeps_its_serialized_form', () => {
  const ink = [0x1b, 0x16, 0x11];
  assert.equal(JSON.stringify(ink), '[27,22,17]');
  for (const j of ['[27,22,17]', '"1B1611"', '"#1b1611"']) assert.deepEqual(Pr.readRgb(JSON.parse(j)), ink, j);
  for (const bad of ['[27,22]', '[27,22,17,0]', '[27,22,300]', '[-1,0,0]', '"auto"', '"1B161"', '""', '7', 'null', '{"r":1}']) assert.equal(Pr.readRgb(JSON.parse(bad)), null, bad);
});

test('props_serde_skip_none', () => {
  const s = JSON.stringify({bold: true});
  assert.equal(s, '{"bold":true}');
  assert.ok(Pr.charIsEmpty({}));
  assert.ok(Pr.same(JSON.parse(s), {bold: true, italic: undefined}), 'an absent key and an undefined one are the same props');
});

test('symbol_font_is_optional_in_json_and_survives_font_changes', () => {
  const old = JSON.parse('{"font":"Arial"}');
  assert.equal(old.symFont, undefined);
  const p = {font: 'Arial', symFont: 'Wingdings'};
  assert.ok(JSON.stringify(p).includes('"symFont":"Wingdings"'));
  assert.equal(Pr.charOverlaid(p, {font: 'Times New Roman'}).symFont, 'Wingdings');
  assert.equal(Pr.charCleared(p).symFont, 'Wingdings');
});

// --- table.rs ---
test('grid_before_shifts_the_row', () => {
  const t = T.newTable(2, 3, 300);
  t.rows[1].cells.splice(0, 1);
  t.rows[1].props = {...t.rows[1].props, gridBefore: 1};
  assert.equal(T.gridCol(t, 1, 0), 1);
  assert.equal(T.gridCol(t, 1, 1), 2);
  assert.equal(T.cellAtGrid(t, 1, 0), null);
  assert.equal(T.cellAtGrid(t, 1, 2), 1);
  assert.equal(T.tableCols(t), 3);
});

test('new_table_shape', () => {
  const t = T.newTable(3, 4, 468);
  assert.equal(t.rows.length, 3);
  assert.equal(T.tableCols(t), 4);
  assert.equal(T.totalWidth(t), 468);
  const huge = T.newTable(1_000_000, 1000, 100);
  assert.equal(huge.rows.length, T.MAX_ROWS);
  assert.equal(T.tableCols(huge), T.MAX_COLS);
});

test('row_col_ops', () => {
  let t = T.newTable(2, 2, 200);
  t = T.insertRow(t, 1, 0);
  assert.equal(t.rows.length, 3);
  t = T.insertCol(t, 1);
  assert.equal(T.tableCols(t), 3);
  assert.ok(t.rows.every(r => r.cells.length === 3));
  t = T.deleteCol(t, 0);
  assert.equal(T.tableCols(t), 2);
  t = T.deleteRow(t, 0);
  assert.equal(t.rows.length, 2);
  t = T.deleteRow(t, 99);
  t = T.deleteCol(t, 99);
  assert.equal(t.rows.length, 2);
});

test('a_huge_span_from_a_file_does_not_overflow', () => {
  const huge = () => { const t = T.newTable(1, 2, 200); t.rows[0].cells[0].props = {...t.rows[0].cells[0].props, span: 4294967295}; return t; };
  let t = T.insertCol(huge(), 1);
  assert.equal(t.rows[0].cells[0].props.span, T.MAX_COLS);
  t = T.mergeRight(huge(), 0, 0, 1);
  assert.equal(t.rows[0].cells.length, 1);
  assert.equal(t.rows[0].cells[0].props.span, T.MAX_COLS);
  t = huge();
  t.rows[0].cells[1].props = {...t.rows[0].cells[1].props, span: 4294967295};
  t = T.mergeRight(t, 0, 0, 1);
  assert.equal(t.rows[0].cells[0].props.span, T.MAX_COLS);
  t = T.deleteCol(huge(), 0);
  assert.equal(t.rows[0].cells[0].props.span, T.MAX_COLS - 1);
});

test('merge_and_split', () => {
  let t = T.newTable(2, 3, 300);
  t = T.mergeRight(t, 0, 0, 1);
  assert.equal(t.rows[0].cells.length, 2);
  assert.equal(T.cellSpan(t.rows[0].cells[0]), 2);
  assert.equal(T.cellAtGrid(t, 0, 1), 0);
  assert.equal(T.gridCol(t, 0, 1), 2);
  t = T.insertCol(t, 1);
  assert.equal(T.cellSpan(t.rows[0].cells[0]), 3);
  [t] = T.splitCell(t, 0, 0, 3);
  assert.equal(t.rows[0].cells.length, 4);
  let v = T.newTable(3, 2, 100);
  v = T.mergeCells(v, 0, 2, 0, 0);
  assert.equal(T.vmergeOf(v.rows[0].cells[0]), 'restart');
  assert.equal(T.vmergeOf(v.rows[2].cells[0]), 'continue');
});
