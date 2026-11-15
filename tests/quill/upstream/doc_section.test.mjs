// Ported from wordcraft crates/doc/src/section.rs and crates/doc/src/resolve.rs (mod tests) at
// aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Sec from '../../../core/quill/model/section.mjs';
import {formatNumber as fmt, NUM_FORMATS, numFormatFromOoxml} from '../../../core/quill/model/numfmt.mjs';
import * as S from '../../../core/quill/model/styles.mjs';

const U32_MAX = 4294967295;

// --- section.rs ---
test('number_formats', () => {
  assert.equal(fmt('upperRoman', 1994), 'MCMXCIV');
  assert.equal(fmt('lowerLetter', 27), 'aa');
  assert.equal(fmt('lowerLetter', 0), '');
  assert.equal(fmt('ordinal', 12), '12th');
  assert.equal(fmt('ordinal', 22), '22nd');
  assert.equal(fmt('cardinalText', 21), 'Twenty-One');
  assert.equal(fmt('ordinalText', 21), 'Twenty-First');
  assert.equal(fmt('ordinalText', 20), 'Twentieth');
  assert.equal(fmt('ordinalText', 112), 'One Hundred Twelfth');
  assert.equal(fmt('decimalZero', 3), '03');
  assert.ok(fmt('upperRoman', U32_MAX).length > 0);
  assert.equal(fmt('lowerLetter', U32_MAX).length, 30);
  assert.deepEqual([fmt('chicago', 1), fmt('chicago', 6)], ['*', '††']);
  assert.equal(fmt('chineseCounting', 11), '十一');
  assert.equal(fmt('chineseCountingThousand', 101), '一百零一');
  assert.equal(fmt('decimalEnclosedCircle', 3), '③');
  assert.equal(fmt('hebrew1', 3), '3', 'formats not drawn yet show decimal');
  assert.equal(fmt('russianLower', 0), '');
  assert.equal([...fmt('russianUpper', U32_MAX)].length, 30);
  for (const f of NUM_FORMATS) {
    assert.equal(numFormatFromOoxml(f), f, `${f} round-trips`);
    assert.ok(f === 'bullet' || f === 'none' || fmt(f, U32_MAX).length > 0, f);
  }
  assert.equal(numFormatFromOoxml('klingon'), 'decimal', 'unknown formats are decimal');
});

test('russian_letters_follow_word', () => {
  const labels = Array.from({length: 31}, (_, i) => fmt('russianLower', i + 1));
  assert.equal(labels.join(' '), 'а б в г д е ж з и к л м н о п р с т у ф х ц ч ш щ ы э ю я аа бб');
  assert.equal(fmt('russianLower', 59), 'ааа');
  assert.equal(fmt('russianLower', 100), 'нннн');
  assert.equal(fmt('russianUpper', 26), 'Ы');
  assert.equal(fmt('russianUpper', 36), 'ЖЖ');
});

test('arabic_letters_count_in_both_orders', () => {
  assert.equal([1, 2, 3, 4, 5].map(n => fmt('arabicAlpha', n)).join(' '), 'أ ب ت ث ج');
  assert.equal([1, 2, 3, 4, 5].map(n => fmt('arabicAbjad', n)).join(' '), 'أ ب ج د ه');
  assert.equal(fmt('arabicAlpha', 28), 'ي');
  assert.equal(fmt('arabicAbjad', 28), 'غ');
  assert.equal(fmt('arabicAlpha', 29), 'أأ');
  assert.equal(fmt('arabicAbjad', 30), 'بب');
});

test('landscape_swaps', () => {
  let s = {...Sec.defaultSection(), marginLeft: 50};
  s = Sec.setLandscape(s, true);
  assert.deepEqual([s.pageW, s.pageH], [792, 612]);
  assert.equal(s.marginTop, 50);
  s = Sec.setLandscape(s, false);
  assert.equal(s.marginLeft, 50);
  assert.deepEqual([s.pageW, s.pageH], [612, 792]);
});

test('grid_pitches_are_clamped', () => {
  let s = Sec.defaultSection();
  assert.equal(Sec.gridLinePitch(s), null);
  s = {...s, docGrid: {type: 'lines', linePitch: 0, charSpace: -2147483648}};
  assert.equal(Sec.gridLinePitch(s), Sec.MIN_GRID_PITCH);
  assert.equal(Sec.gridCharPitch(s, 10.5), null);
  s = {...s, docGrid: {type: 'linesAndChars', linePitch: NaN, charSpace: -2147483648}};
  assert.equal(Sec.gridLinePitch(s), 18);
  assert.equal(Sec.gridCharPitch(s, 10.5), Sec.MIN_GRID_PITCH);
  s = {...s, docGrid: {type: 'linesAndChars', linePitch: 18, charSpace: Sec.charSpaceFor(13, 10.5)}};
  assert.equal(Sec.gridLinesPerPage(s), 36);
  assert.equal(Sec.gridCharsPerLine(s, 10.5), 36);
});

test('columns_split', () => {
  const s = {...Sec.defaultSection(), columns: {...Sec.defaultColumns(), count: 2, space: 36}};
  assert.deepEqual(Sec.columnBoxes(s), [[0, 216], [252, 216]]);
});

test('rtl_columns_run_right_to_left', () => {
  let s = {...Sec.defaultSection(), rtl: true, columns: {...Sec.defaultColumns(), count: 2, space: 36}};
  assert.deepEqual(Sec.columnBoxes(s), [[252, 216], [0, 216]]);
  s = {...Sec.defaultSection(), rtl: true, columns: {...Sec.defaultColumns(), count: 2, widths: [[100, 20], [200, 0]]}};
  assert.deepEqual(Sec.columnBoxes(s), [[368, 100], [148, 200]]);
});

// --- resolve.rs ---
test('a_style_never_gives_text_a_symbol_font', () => {
  let s = S.builtinStyleSheet();
  const n = S.getStyle(s, 'Normal');
  s = S.upsertStyle(s, {...n, chr: {...n.chr, symFont: 'Wingdings'}});
  assert.notEqual(S.resolveChar(s, null, {}).font, 'Wingdings');
  assert.equal(S.resolveChar(s, null, {symFont: 'Wingdings'}).font, 'Wingdings');
});

test('heading_resolves', () => {
  const s = S.builtinStyleSheet();
  const p = S.resolvePara(s, {style: 'Heading1'});
  assert.ok(p.keepNext);
  assert.equal(p.outlineLevel, 0);
  assert.equal(p.spaceAfter, 4);
  const c = S.resolveChar(s, 'Heading1', {});
  assert.equal(c.size, 20);
  assert.equal(c.font, S.HEADING_FONT);
  assert.equal(S.resolveChar(s, 'Heading1', {size: 30}).size, 30);
});

test('char_style_then_direct', () => {
  const s = S.builtinStyleSheet();
  const c = S.resolveChar(s, null, {style: 'Strong', italic: true});
  assert.ok(c.bold && c.italic);
  assert.equal(c.size, 12);
  assert.equal(S.resolveChar(s, 'NoSuchStyle', {}).size, 12);
});

test('hostile_values_clamped', () => {
  const s = S.builtinStyleSheet();
  const p = S.resolvePara(s, {indentLeft: Infinity, lineSpacing: {rule: 'multiple', value: NaN}});
  assert.equal(p.indentLeft, 1584);
  assert.deepEqual(p.lineSpacing, {rule: 'multiple', value: 1});
  assert.equal(S.resolveChar(s, null, {size: -4}).size, 1);
});

test('table_style_sits_between_defaults_and_paragraph_style', () => {
  let s = S.builtinStyleSheet();
  s = S.upsertStyle(s, S.style({id: 'Spaced', name: 'Spaced', basedOn: 'Normal', para: {spaceAfter: 12}, chr: {color: {Rgb: [0, 0, 0xff]}}}));
  const tableP = {spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1}};
  const red = {Rgb: [0xc0, 0, 0]};
  const tableC = {bold: true, color: red, size: 9};
  const out = S.resolvePara(s, {});
  assert.deepEqual([out.spaceAfter, out.lineSpacing], [8, {rule: 'multiple', value: 1.15}]);
  let p = S.resolvePara(s, {}, tableP);
  assert.deepEqual([p.spaceAfter, p.lineSpacing], [0, {rule: 'multiple', value: 1}]);
  let c = S.resolveChar(s, null, {}, tableC);
  assert.ok(c.bold);
  assert.deepEqual([c.color, c.size], [red, 9]);
  const spaced = {style: 'Spaced'};
  p = S.resolvePara(s, spaced, tableP);
  assert.deepEqual([p.spaceAfter, p.lineSpacing], [12, {rule: 'multiple', value: 1}]);
  c = S.resolveChar(s, 'Spaced', {}, tableC);
  assert.ok(c.bold);
  assert.deepEqual([c.color, c.size], [{Rgb: [0, 0, 0xff]}, 9]);
  c = S.resolveChar(s, 'Spaced', {style: 'Emphasis', bold: false}, tableC);
  assert.ok(!c.bold && c.italic);
  assert.equal(S.resolvePara(s, {...spaced, spaceAfter: 3}, tableP).spaceAfter, 3);
  const n = S.getStyle(s, 'Normal');
  s = S.upsertStyle(s, {...n, para: {...n.para, spaceAfter: 10}, chr: {...n.chr, size: 11}});
  assert.equal(S.resolvePara(s, {}, tableP).spaceAfter, 10);
  assert.equal(S.resolveChar(s, null, {}, tableC).size, 11);
});

test('header_tabs_inherit', () => {
  const s = S.builtinStyleSheet();
  const p = S.resolvePara(s, {style: 'Header', tabs: [{pos: 100, align: 'left', leader: 'none'}]});
  assert.equal(p.tabs.length, 3);
  assert.equal(p.tabs[0].pos, 100);
});
