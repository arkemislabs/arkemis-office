// Ported from wordcraft crates/doc/src/styles.rs (mod tests) at aadb077e072b7de05f724e359d8db82e151f125c.
// Each test names the Rust test. Style sheets are immutable here: helpers return new sheets.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../../core/quill/model/styles.mjs';
import {singleBorder, defaultTableLook} from '../../../core/quill/model/props.mjs';

test('builtins_present', () => {
  const s = S.builtinStyleSheet();
  for (const id of ['Normal', 'Heading1', 'Heading9', 'Title', 'Strong', 'TableGrid', 'TOC3', 'Hyperlink', 'ListParagraph']) assert.ok(S.getStyle(s, id), id);
  assert.equal(S.findStyle(s, 'heading 2').id, 'Heading2');
  const g = S.gallery(s);
  assert.equal(g[0].id, 'Normal');
  assert.ok(g.some(x => x.id === 'Heading1'));
});

test('default_gallery_marks_and_adds_quick_builtins', () => {
  const b = S.builtinStyleSheet();
  const plain = (id, name, extra = {}) => S.style({id, name, builtin: true, ...extra});
  let s = S.emptyStyleSheet();
  s = {...s, styles: [plain('Normal', 'Normal'), plain('Heading1', 'heading 1'), plain('Heading2', 'Heading 2', {priority: 7}),
    plain('Heading3', 'Heading 3', {builtin: false}), plain('Custom1', 'Subtitle', {para: {spaceAfter: 99}})]};
  s = S.addDefaultGallery(s);
  const ids = S.gallery(s).map(x => x.id);
  for (const id of ['Normal', 'NoSpacing', 'Heading1', 'Heading2', 'Title']) assert.ok(ids.includes(id), `${id} in ${ids}`);
  const bare = S.addDefaultGallery(S.emptyStyleSheet());
  assert.ok(S.getStyle(bare, 'Heading1')?.quick && S.getStyle(bare, 'Title'), 'missing quick builtins added');
  assert.equal(S.getStyle(s, 'Heading2').priority, 7, 'file priority kept');
  assert.equal(S.getStyle(s, 'Heading1').priority, S.getStyle(b, 'Heading1').priority);
  assert.ok(!S.getStyle(s, 'Heading3').quick, 'custom style untouched');
  assert.equal(S.getStyle(s, 'Subtitle'), null, 'a style with that name exists: not duplicated');
  assert.ok(S.getStyle(s, 'Custom1').quick, 'found by name only, built in: quick');
  assert.equal(S.getStyle(s, 'Custom1').para.spaceAfter, 99);
});

test('older_serialized_styles_keep_explicit_defaults', () => {
  // Upstream's serde default for a missing defaultParaPresent is true; the JS sheet reads it with
  // the same default where it is consumed (an absent key counts as present).
  const value = {...S.emptyStyleSheet()};
  delete value.defaultParaPresent;
  assert.notEqual(value.defaultParaPresent, false);
  const omitted = {...S.emptyStyleSheet(), defaultParaPresent: false};
  assert.deepEqual(JSON.parse(JSON.stringify(omitted)), omitted);
});

test('chain_is_cycle_safe', () => {
  let s = S.builtinStyleSheet();
  s = S.upsertStyle(s, {...S.getStyle(s, 'Normal'), basedOn: 'Heading1'});
  assert.ok(S.chain(s, 'Heading1').length <= 2);
});

test('band_size_zero_turns_bands_off', () => {
  // TableLook { banded_columns: true, ..Default::default() }: Word's default look plus column bands.
  const look = {...defaultTableLook(), bandedColumns: true};
  const on = (sizes, ri, g, p) => S.partsOfCell(look, sizes, [ri, 5], [g, 1, 4]).includes(p);
  assert.ok(on([1, 1], 1, 1, 'band1Horz') && on([1, 1], 1, 1, 'band1Vert'));
  assert.ok(on([1, 1], 2, 2, 'band2Horz') && on([1, 1], 2, 2, 'band2Vert'));
  for (const [ri, g] of [[1, 1], [2, 2]]) for (const band of ['band1Horz', 'band2Horz', 'band1Vert', 'band2Vert']) assert.ok(!on([0, 0], ri, g, band), `${band} at ${ri},${g}`);
  const t = S.tableStyle(S.builtinStyleSheet(), 'GridTable4AccentBlue');
  assert.deepEqual([t.parts.bandSize, t.parts.colBandSize], [1, 1]);

});

test('table_style_merges_based_on_chain', () => {
  let s = S.builtinStyleSheet();
  const red = [0xc0, 0, 0];
  const thick = singleBorder(2);
  s = S.upsertStyle(s, S.style({id: 'RedGrid', name: 'RedGrid', kind: 'table', basedOn: 'TableGrid', chr: {bold: true, color: {Rgb: red}},
    table: {borders: {top: thick}, headerFill: red}}));
  const t = S.tableStyle(s, 'RedGrid');
  assert.deepEqual([t.para.spaceAfter, t.para.lineSpacing], [0, {rule: 'multiple', value: 1}], 'from Table Grid');
  assert.deepEqual([t.chr.bold, t.chr.color], [true, {Rgb: red}]);
  assert.deepEqual(t.parts.borders.top, thick);
  assert.deepEqual(t.parts.borders.left, singleBorder(0.5), "Table Grid's other edges");
  assert.deepEqual(t.parts.headerFill, red);
  assert.equal(S.tableStyle(s, 'Normal'), null);
  assert.equal(S.tableStyle(s, 'Nope'), null);
  s = S.upsertStyle(s, {...S.getStyle(s, 'TableGrid'), basedOn: 'RedGrid'});
  assert.ok(S.tableStyle(s, 'RedGrid'));
});

test('new_ids_unique', () => {
  const s = S.builtinStyleSheet();
  assert.equal(S.newStyleId(s, 'My Style'), 'MyStyle');
  assert.equal(S.newStyleId(s, 'Normal'), 'Normal1');
  assert.equal(S.newStyleId(s, '!!!'), 'Style');
});
