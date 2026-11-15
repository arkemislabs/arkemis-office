// Ported upstream tests: deckcraft crates/model/src/tests.rs, the tests modules of
// crates/model/src/edit.rs, table.rs, bidi.rs and words.rs (a selection of its traces), and
// crates/color/src/lib.rs, at f893f6af7d36a5409fd804e81a34fd895cfefedf. Titles name the Rust test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {newPresentation, blankPresentation, STANDARD, newSlide, layoutOfKind} from '../../../core/prism/model/defaults.mjs';
import {ctxForSlide, ctxForLayout, ctxForMaster, ctxColor, xfrm, levelStyle, fontFamily, body as bodyProps, fill, line, run} from '../../../core/prism/model/resolve.mjs';
import {masterFor, validatePresentation, allocId, fixNextId, walk, findShape, parentOf, shape, slide, phType, inkPressureIsLegacy, inkSampleWidth} from '../../../core/prism/model/presentation.mjs';
import {accentStyle, colorScheme, colorRgb, fillSolid} from '../../../core/prism/model/style.mjs';
import {bodyFromText, bodyText, bodyLen, normalizeParagraph, paraText, safeUrl, listSet} from '../../../core/prism/model/text.mjs';
import {builtinThemes, defaultTheme} from '../../../core/prism/model/theme.mjs';
import * as C from '../../../core/prism/model/color.mjs';
import * as E from '../../../core/prism/model/edit.mjs';
import * as T from '../../../core/prism/model/table.mjs';
import {firstStrongIsRtl} from '../../../core/prism/model/bidi.mjs';
import {stops, backStops} from '../../../core/prism/model/words.mjs';

const sg = (scheme, slot) => C.schemeGet(scheme, slot);

// ---- model/src/tests.rs ----

test('model::new_presentation_is_valid', () => {
  const p = newPresentation();
  assert.equal(p.slides.length, 1);
  assert.equal(p.masters.length, 1);
  assert.equal(p.masters[0].layouts.length, 11);
  assert.deepEqual(validatePresentation(p), []);
  const s = p.slides[0];
  const [m, l] = masterFor(p, s);
  assert.equal(l.kind, 'title');
  assert.equal(m.theme.name, 'Arkemis');
  assert.deepEqual(s.shapes.map(phType), ['ctrTitle', 'subTitle']);
  assert.equal(s.id, '257');
});

test('model::placeholder_inherits_position_and_styles', () => {
  const p = newPresentation();
  const s = p.slides[0];
  const ctx = ctxForSlide(p, s);
  const title = s.shapes[0];
  const x = xfrm(ctx, title);
  assert.ok(Math.abs(x.x - 120) < 1e-9 && Math.abs(x.w - 720) < 1e-9);
  const lvl = levelStyle(ctx, title, 0);
  assert.equal(lvl.run.size, 60);
  assert.equal(lvl.para.align, 'center');
  assert.equal(fontFamily(ctx, lvl.run), 'Inter');
  assert.equal(bodyProps(ctx, title).anchor, 'bottom');
});

test('model::body_levels_from_master', () => {
  const p = newPresentation();
  const lay = layoutOfKind(p, 'titleAndContent');
  const {slide: s, pres} = newSlide(p, lay);
  const ctx = ctxForSlide(pres, s);
  const b = s.shapes[1];
  assert.equal(phType(b), 'obj');
  assert.equal(levelStyle(ctx, b, 0).run.size, 28);
  assert.equal(levelStyle(ctx, b, 1).run.size, 24);
  assert.equal(levelStyle(ctx, b, 0).para.bullet.kind, 'char');
});

test('model::shape_style_fill_resolves_through_theme', () => {
  const p = newPresentation();
  const ctx = ctxForSlide(p, p.slides[0]);
  const sh = shape({style: accentStyle('accent1'), xfrm: {x: 0, y: 0, w: 10, h: 10}});
  const [f, ph] = fill(ctx, sh);
  assert.equal(f.kind, 'solid');
  assert.deepEqual(ctxColor(ctx, f.color, ph), sg(p.masters[0].theme.colors, 'accent1'));
  const [l, lph] = line(ctx, sh);
  assert.ok(l.width !== undefined && l.width !== null);
  assert.ok(lph);
});

test('model::a_gradient_without_stops_takes_them_from_its_style', () => {
  const p = newPresentation();
  const ctx = ctxForSlide(p, p.slides[0]);
  const own = {kind: 'gradient', tile: [0, 0, 0, 0], stops: [], shape: {kind: 'linear', angle: 45, scaled: true}, rotateWithShape: true};
  const st = accentStyle('accent2');
  st.fillRef = [3, st.fillRef[1]];
  let [f, ph] = fill(ctx, shape({style: st, fill: own}));
  assert.equal(f.kind, 'gradient');
  assert.deepEqual(f.stops, p.masters[0].theme.format.fills[2].stops);
  assert.deepEqual(f.shape, own.shape);
  assert.deepEqual(ph, sg(p.masters[0].theme.colors, 'accent2'));
  st.fillRef = [1, st.fillRef[1]];
  [f] = fill(ctx, shape({style: st, fill: own}));
  assert.deepEqual(f, own);
});

test('model::serde_roundtrip', () => {
  const p = newPresentation();
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test('model::exhausted_id_space_allocates_nothing', () => {
  const p = {...newPresentation(), nextId: 0xffffffff};
  assert.equal(allocId(p), null);
  assert.equal(newSlide(p, layoutOfKind(p, 'titleAndContent')), null);
});

test('model::ids_are_unique_and_fix_next_id', () => {
  let p = newPresentation();
  const [a, n1] = allocId(p);
  p = {...p, nextId: n1};
  const [b, n2] = allocId(p);
  p = {...p, nextId: n2};
  assert.ok(Number(b) > Number(a));
  p = {...p, nextId: 0};
  p = {...p, nextId: fixNextId(p)};
  const [c] = allocId(p);
  const all = [];
  for (const s of p.slides) { all.push(s.id); walk(s.shapes, sh => all.push(sh.id)); }
  assert.ok(!all.includes(c));
});

test('model::group_find_and_walk', () => {
  const child = shape({id: '900'});
  const g = shape({id: '901', kind: {type: 'group', children: [child], child: {x: 0, y: 0, w: 1, h: 1}}});
  const s = slide({shapes: [g]});
  assert.ok(findShape(s.shapes, '900'));
  let n = 0;
  walk(s.shapes, () => n++);
  assert.equal(n, 2);
});

test('model::text_body_helpers', () => {
  const t = bodyFromText('Hello\nWorld');
  assert.equal(bodyText(t), 'Hello\nWorld');
  assert.equal(bodyLen(t), 11);
  t.paragraphs[0].runs.push({text: ' there'});
  t.paragraphs[0] = normalizeParagraph(t.paragraphs[0]);
  assert.equal(t.paragraphs[0].runs.length, 1);
  assert.equal(paraText(t.paragraphs[0]), 'Hello there');
});

test('model::builtin_themes_have_distinct_names', () => {
  const t = builtinThemes();
  assert.equal(new Set(t.map(x => x.name)).size, t.length);
  assert.ok(t.length >= 8);
});

test('model::four_by_three_master_scales', () => {
  const p = blankPresentation(STANDARD, defaultTheme(), true);
  const title = p.masters[0].shapes.find(s => phType(s) === 'title');
  assert.ok(title.xfrm.x + title.xfrm.w <= 720 + 1e-6);
});

test('model::hyperlinked_runs_take_the_theme_hyperlink_look', () => {
  const p = newPresentation();
  const s = p.slides[0];
  const ctx = ctxForSlide(p, s);
  const title = s.shapes[0];
  const para = {level: 0, runs: []};
  const link = {action: {kind: 'url', url: 'https://example.org'}, tooltip: '', highlightClick: false};
  const hlink = fillSolid(colorScheme('hlink'));
  assert.deepEqual(run(ctx, title, para, {}).fill, fillSolid(colorScheme('tx1')));
  let r = run(ctx, title, para, {link});
  assert.deepEqual([r.fill, r.underline], [hlink, 'sng']);
  assert.deepEqual(ctxColor(ctx, colorScheme('hlink'), null), sg(p.masters[0].theme.colors, 'hlink'));
  assert.deepEqual(run(ctx, title, para, {link: {...link, action: {kind: 'slide', slide: s.id}}}).fill, hlink);
  const red = fillSolid(colorRgb(C.rgb(255, 0, 0)));
  r = run(ctx, title, para, {link, fill: red, underline: 'none'});
  assert.deepEqual([r.fill, r.underline], [red, 'none']);
  r = run(ctx, title, para, {link, underline: 'dbl'});
  assert.deepEqual([r.fill, r.underline], [hlink, 'dbl']);
});

test('model::a_layout_colour_map_override_applies_to_its_slides', () => {
  const p = newPresentation();
  const dark = [['bg1', 'dk1'], ['tx1', 'lt1'], ['bg2', 'dk2'], ['tx2', 'lt2']];
  const colors = p.masters[0].theme.colors;
  const lay = p.masters[0].layouts.find(l => l.id === p.slides[0].layout);
  lay.colorMap = dark;
  const s = p.slides[0];
  let ctx = ctxForSlide(p, s);
  assert.deepEqual(ctxColor(ctx, colorScheme('bg1'), null), sg(colors, 'dk1'));
  assert.deepEqual(ctxColor(ctx, colorScheme('tx2'), null), sg(colors, 'lt2'));
  assert.deepEqual(sg(ctx.scheme, 'lt1'), sg(colors, 'dk1'));
  ctx = ctxForSlide(p, {...s, colorMap: [['bg1', 'lt1'], ['tx1', 'dk1']]});
  assert.deepEqual(ctxColor(ctx, colorScheme('bg1'), null), sg(colors, 'lt1'));
  assert.deepEqual(ctxColor(ctxForLayout(p, p.masters[0], lay), colorScheme('bg1'), null), sg(colors, 'dk1'));
  assert.deepEqual(ctxColor(ctxForMaster(p, p.masters[0]), colorScheme('bg1'), null), sg(colors, 'lt1'));
});

test('model::sibling_lists_and_parents_reach_into_groups', () => {
  const leaf = id => shape({id});
  const group = (id, children) => shape({id, kind: {type: 'group', children, child: {x: 0, y: 0, w: 0, h: 0}}});
  const tree = [leaf('1'), group('2', [leaf('3'), group('4', [leaf('5')])]), leaf('6')];
  assert.equal(parentOf(tree, '1'), null);
  assert.equal(parentOf(tree, '3'), '2');
  assert.equal(parentOf(tree, '5'), '4');
  assert.equal(parentOf(tree, '9'), undefined);
});

test('model::ink_width_follows_pressure_and_keeps_the_old_placeholder', () => {
  assert.ok(inkPressureIsLegacy([[0, 0, 0.5], [1, 1, 0.5]]));
  assert.ok(!inkPressureIsLegacy([[0, 0, 0.5], [1, 1, 1]]));
  assert.ok(!inkPressureIsLegacy([]));
  assert.ok(Math.abs(inkSampleWidth(8, 0.5, true) - 8) < 1e-9);
  assert.ok(Math.abs(inkSampleWidth(8, 1, false) - 8) < 1e-9);
  assert.ok(Math.abs(inkSampleWidth(8, 0.25, false) - 2) < 1e-9);
  assert.ok(Math.abs(inkSampleWidth(8, 0, false) - 0.64) < 1e-4);
  assert.ok(Math.abs(inkSampleWidth(8, NaN, false) - 8) < 1e-9);
});

test('model::table_text_takes_the_masters_other_style_and_shapes_the_default_text_style', () => {
  const p = newPresentation();
  const size = pt => ({para: {}, run: {size: pt}});
  p.defaultTextStyle = listSet(p.defaultTextStyle, 0, size(26));
  p.masters[0].otherStyle = listSet(p.masters[0].otherStyle, 0, size(14));
  p.masters[0].bodyStyle = listSet(p.masters[0].bodyStyle, 0, size(36));
  const ctx = ctxForSlide(p, p.slides[0]);
  const para = {level: 0, runs: []};
  const pt = sh => run(ctx, sh, para, {}).size;
  const b = bodyFromText('Cell');
  const table = shape({kind: {type: 'table', ...T.defaultTable()}});
  assert.equal(pt({...table, text: b}), 14, 'a table cell');
  assert.equal(pt(table), 14);
  assert.equal(pt({...table, ph: {kind: 'obj', idx: 1}}), 14);
  assert.equal(pt(shape({text: b})), 26, 'a shape');
  assert.equal(pt(shape({text: b, textBox: true})), 26, 'a text box');
});

test('model::only_web_and_mail_links_are_safe_to_open', () => {
  for (const url of ['https://example.com', ' HTTP://example.com/x', 'mailto:someone@example.com']) assert.ok(safeUrl(url), url);
  for (const url of ['https://', 'mailto:', 'file:///C:/notes.pdf', 'notes.pdf', 'javascript:alert(1)', 'ms-msdt:/id PCWDiagnostic', 'ldap://attacker.example/x',
    '//attacker.example/share', '\\\\attacker.example\\share', 'smb://attacker.example/share', 'search-ms:query=x']) assert.ok(!safeUrl(url), url);
});

// ---- model/src/edit.rs tests ----

const body = t => bodyFromText(t);

test('edit::insert_and_split', () => {
  let r = E.insert(body('Hello'), [0, 5], ' world\nNext');
  assert.equal(bodyText(r.body), 'Hello world\nNext');
  assert.deepEqual(r.pos, [1, 4]);
  r = E.insert(r.body, [0, 0], '>');
  assert.deepEqual(r.pos, [0, 1]);
  assert.equal(r.body.paragraphs[0].runs.length, 1);
});

test('edit::delete_within_and_across', () => {
  let r = E.remove(body('abc\ndef\nghi'), [0, 1], [2, 1]);
  assert.deepEqual(r.pos, [0, 1]);
  assert.equal(bodyText(r.body), 'ahi');
  r = E.remove(body('abcdef'), [0, 4], [0, 2]);
  assert.equal(bodyText(r.body), 'abef');
  r = E.remove(r.body, [99, 99], [0, 0]);
  assert.equal(bodyText(r.body), '');
});

test('edit::format_splits_runs', () => {
  const b = E.format(body('abcdef'), [0, 2], [0, 4], p => ({...p, bold: true}));
  const p = b.paragraphs[0];
  assert.equal(p.runs.length, 3);
  assert.equal(p.runs[1].text, 'cd');
  assert.equal(p.runs[1].props.bold, true);
  assert.equal(E.propsAt(b, [0, 3]).bold, true);
  assert.equal(E.textRange(b, [0, 1], [0, 5]), 'bcde');
  const s = E.slice(b, [0, 1], [0, 5]);
  assert.equal(bodyText(s), 'bcde');
  const r = E.insertBody(body('XY'), [0, 1], s);
  assert.equal(bodyText(r.body), 'XbcdeY');
  assert.deepEqual(r.pos, [0, 5]);
});

test('edit::words_and_moves', () => {
  const b = body('Hello brave world');
  assert.deepEqual(E.wordAt(b, [0, 7]), [[0, 6], [0, 11]]);
  assert.deepEqual(E.wordMove(b, [0, 0], true), [0, 6]);
  assert.deepEqual(E.wordMove(b, [0, 8], false), [0, 6]);
  assert.deepEqual(E.charMove(b, [0, 17], true), [0, 17]);
  assert.equal(E.changeCase('hello world. again', 'sentence'), 'Hello world. Again');
  assert.equal(E.changeCase('hello world', 'title'), 'Hello World');
});

test('edit::line_break_insert', () => {
  const r = E.insert(body('ab'), [0, 1], '\u000b');
  assert.deepEqual(r.pos, [0, 2]);
  assert.equal(r.body.paragraphs.length, 1);
  assert.equal(paraText(r.body.paragraphs[0]).length, 3);
});

const delWord = (text, at, forward) => { const r = E.deleteWord(body(text), at, forward); return [bodyText(r.body), r.pos]; };

test('edit::ctrl_backspace_like_powerpoint', () => {
  const t = 'ab   cd...ef gh';
  const want = [['ab   cd...ef gh', 0], ['b   cd...ef gh', 0], ['   cd...ef gh', 0], ['  cd...ef gh', 0], [' cd...ef gh', 0], ['cd...ef gh', 0],
    ['ab   d...ef gh', 5], ['ab   ...ef gh', 5], ['ab   cd..ef gh', 7], ['ab   cd.ef gh', 7], ['ab   cdef gh', 7], ['ab   cd...f gh', 10],
    ['ab   cd... gh', 10], ['ab   cd...gh', 10], ['ab   cd...ef h', 13], ['ab   cd...ef ', 13]];
  want.forEach(([txt, caret], c) => assert.deepEqual(delWord(t, [0, c], false), [txt, [0, caret]], `caret ${c}`));
  const w = 'Hello world  foo, bar\nnext para';
  assert.deepEqual(delWord(w, [0, 12], false), ['Hello  foo, bar\nnext para', [0, 6]]);
  assert.deepEqual(delWord(w, [0, 17], false), ['Hello world  foo bar\nnext para', [0, 16]]);
  assert.deepEqual(delWord(w, [1, 0], false), ['Hello world  foo, barnext para', [0, 21]]);
  assert.deepEqual(delWord('ab\n  cd', [1, 2], false), ['ab\ncd', [1, 0]]);
  assert.deepEqual(delWord('x', [0, 0], false), ['x', [0, 0]]);
  assert.deepEqual(delWord('日本語', [0, 3], false), ['日本', [0, 2]]);
});

test('edit::ctrl_delete_like_powerpoint', () => {
  const t = 'ab   cd...ef gh';
  const want = [['cd...ef gh', 0], ['a   cd...ef gh', 1], ['ab...ef gh', 2], ['ab cd...ef gh', 3], ['ab  cd...ef gh', 4], ['ab...ef gh', 2],
    ['ab   c...ef gh', 6], ['ab   cdef gh', 7], ['ab   cd. ef gh', 9], ['ab   cd.. ef gh', 10], ['ab   cd... gh', 11], ['ab   cd...e gh', 11],
    ['ab   cd...ef', 12], ['ab   cd...ef', 12], ['ab   cd...ef g', 14], ['ab   cd...ef gh', 15]];
  want.forEach(([txt, caret], c) => assert.deepEqual(delWord(t, [0, c], true), [txt, [0, caret]], `caret ${c}`));
  assert.deepEqual(delWord('ab cd, ef', [0, 3], true), ['ab, ef', [0, 2]]);
  assert.deepEqual(delWord('3.x 14', [0, 2], true), ['3.14', [0, 2]]);
  assert.equal(delWord('ab', [9, 9], true)[0], 'ab');
});

test('edit::paragraph_moves', () => {
  const b = body('one two\nthree\n\nfour');
  assert.deepEqual(E.paraDown(b, [0, 2]), [1, 0]);
  assert.deepEqual(E.paraDown(b, [3, 1]), [3, 4]);
  assert.deepEqual(E.paraUp(b, [3, 2]), [3, 0]);
  assert.deepEqual(E.paraUp(b, [3, 0]), [2, 0]);
  assert.deepEqual(E.wordMove(b, [0, 7], true), [1, 0]);
  assert.deepEqual(E.wordMove(b, [1, 0], false), [0, 7]);
});

test('edit::case_cycle', () => {
  assert.equal(E.nextCase('hello world'), 'title');
  assert.equal(E.nextCase('Hello World'), 'upper');
  assert.equal(E.nextCase('HELLO WORLD'), 'lower');
  assert.equal(E.nextCase('123'), 'upper');
});

test('edit::replace_text_keeps_formatting', () => {
  let b = E.format(body('Overview\nFirst point\nSecond point'), [0, 0], [0, 8], p => ({...p, bold: true}));
  for (const p of b.paragraphs.slice(1)) { p.level = 1; p.props = {marginLeft: 36, indent: -18, bullet: {kind: 'char', char: '•'}}; }
  const before = structuredClone(b);
  b = E.replaceText(b, 'Overview\nFirst point\nSecond point');
  assert.deepEqual(b, before);
  b = E.replaceText(b, 'Overview\nFirst main point\nSecond point');
  assert.equal(b.paragraphs[0].runs[0].props.bold, true);
  assert.deepEqual(b.paragraphs[1].props, before.paragraphs[1].props);
  b = E.replaceText(b, 'Overview (5 min)\nFirst main point\nSecond point');
  assert.equal(b.paragraphs[0].runs.length, 1);
  b = E.replaceText(b, 'Plain');
  assert.equal(bodyText(b), 'Plain');
});

// ---- model/src/table.rs tests ----

function assertTopology(t) {
  const nr = T.nRows(t), nc = T.nCols(t);
  const owner = Array.from({length: nr}, () => Array(nc).fill(0));
  t.rows.forEach((row, r) => {
    assert.equal(row.cells.length, nc);
    row.cells.forEach((cell, c) => {
      if (T.isCovered(cell)) { assert.deepEqual([cell.gridSpan, cell.rowSpan], [1, 1]); return; }
      assert.ok(r + cell.rowSpan <= nr && c + cell.gridSpan <= nc);
      for (let i = r; i < r + cell.rowSpan; i++) for (let j = c; j < c + cell.gridSpan; j++) owner[i][j]++;
    });
  });
  owner.forEach(o => o.forEach(n => assert.equal(n, 1)));
}
const merged = () => {
  const t = T.newTable(4, 4, 400, 30);
  t.rows[1].cells[1].text = bodyFromText('M');
  const m = T.merge(t, 1, 1, 2, 2);
  assertTopology(m);
  return m;
};

test('table::merging_over_an_existing_merge_takes_it_in', () => {
  let t = T.newTable(3, 3, 300, 30);
  t.rows[1].cells[2].text = bodyFromText('X');
  t = T.merge(t, 1, 1, 1, 2);
  t = T.merge(t, 0, 0, 1, 1);
  assertTopology(t);
  assert.deepEqual([t.rows[0].cells[0].rowSpan, t.rows[0].cells[0].gridSpan], [2, 3]);
  assert.equal(T.cellText(t, 0, 0), 'X');
});

test('table::row_and_column_edits_keep_merges_consistent', () => {
  for (let at = 0; at <= 4; at++) { assertTopology(T.insertRow(merged(), at)); assertTopology(T.insertCol(merged(), at)); }
  for (let at = 0; at < 4; at++) { assertTopology(T.deleteRow(merged(), at)); assertTopology(T.deleteCol(merged(), at)); }
});

// ---- model/src/bidi.rs tests ----

test('bidi::detects_rtl_ltr_neutrals_and_marks', () => {
  assert.ok(firstStrongIsRtl('مرحبا') && firstStrongIsRtl('من ناوم هێڤاره') && firstStrongIsRtl('שלום'));
  assert.ok(!firstStrongIsRtl('Hello') && !firstStrongIsRtl('DeckCraft'));
  assert.ok(firstStrongIsRtl('  123 مرحبا') && firstStrongIsRtl('... (2024) سنة'));
  assert.ok(!firstStrongIsRtl('  123 Hello') && !firstStrongIsRtl('') && !firstStrongIsRtl('   12345 '));
  assert.ok(firstStrongIsRtl('\u200fHello') && !firstStrongIsRtl('\u200eمرحبا'));
});

// ---- model/src/words.rs tests (stop traces observed in PowerPoint) ----

const marked = (text, st) => {
  let out = '';
  [...text].forEach((c, i) => { if (st.includes(i)) out += '|'; out += c === '\u000b' ? '↵' : c === '\t' ? '→' : c; });
  if (st.includes(text.length)) out += '|';
  return out;
};

test('words::punctuation_and_spaces', () => {
  const t = "Hello, world!  Foo...bar baz-qux it's 3.14 e.g. a_b x@y.com (end) \"q\" end.";
  const want = "|Hello|, |world|!  |Foo|...|bar |baz-qux |it's |3.14 |e|.|g|. |a|_|b |x|@|y|.|com |(|end|) |\"|q|\" |end|.|";
  assert.equal(marked(t, stops(t)), want);
  assert.equal(marked(t, backStops(t)), want);
});

test('words::hyphens_apostrophes_numbers', () => {
  const t = "a-b -b a--b a - b a- b dogs' x 'q' 1,000.5 3:45 v1.2.3 $5 50% a/b x&y #tag a+b c++ end";
  assert.equal(marked(t, stops(t)), "|a-b |-|b |a-|-|b |a |- |b |a- |b |dogs|' |x |'q|' |1,000.5 |3:45 |v1.2.3 |$|5 |50|% |a|/|b |x|&|y |#|tag |a|+|b |c|++ |end|");
});

// ---- color/src/lib.rs tests ----

test('color::from_hex_rejects_multiple_hashes_and_signs', () => {
  assert.equal(C.fromHex('##FF0000'), null);
  assert.deepEqual(C.fromHex('#FF0000'), C.rgb(255, 0, 0));
  assert.deepEqual(C.fromHex('#FF000080'), C.rgba(255, 0, 0, 128));
  for (const s of ['+12345', '#+1+2+3', '+1+2+3+4', '+12']) assert.equal(C.fromHex(s), null);
});

test('color::hex_roundtrip', () => {
  assert.deepEqual(C.fromHex('#156082'), C.rgb(0x15, 0x60, 0x82));
  assert.equal(C.hex(C.rgb(0x15, 0x60, 0x82)), '156082');
  assert.deepEqual(C.fromHex('fff'), C.WHITE);
  for (const s of ['zz0000', 'ééé', '']) assert.equal(C.fromHex(s), null);
});

test('color::hsl_roundtrip', () => {
  for (const c of [C.rgb(10, 200, 30), C.rgb(255, 0, 0), C.rgb(128, 128, 128), C.rgb(21, 96, 130)]) {
    const [h, s, l] = C.toHsl(c);
    const d = C.fromHsl(h, s, l, 255);
    assert.ok(Math.abs(d.r - c.r) <= 1 && Math.abs(d.g - c.g) <= 1 && Math.abs(d.b - c.b) <= 1);
  }
});

test('color::transforms', () => {
  const c = C.rgb(0x40, 0x80, 0xc0);
  assert.equal(C.apply(c, [{op: 'alpha', val: 50000}]).a, 128);
  assert.ok(C.luminance(C.apply(c, [{op: 'lumMod', val: 20000}, {op: 'lumOff', val: 80000}])) > C.luminance(c));
  assert.ok(C.luminance(C.apply(c, [{op: 'lumMod', val: 50000}])) < C.luminance(c));
  assert.deepEqual(C.apply(C.WHITE, [{op: 'shade', val: 0}]), C.BLACK);
  assert.deepEqual(C.apply(C.BLACK, [{op: 'tint', val: 0}]), C.WHITE);
  assert.deepEqual(C.apply(c, [{op: 'inv'}]), C.rgb(0xbf, 0x7f, 0x3f));
  C.apply(c, [{op: 'lumMod', val: 2147483647}, {op: 'hueOff', val: -2147483648}, {op: 'alphaMod', val: -2147483648}]);
});

test('color::contrast_ratio_and_scheme_slots', () => {
  assert.ok(Math.abs(C.contrast(C.BLACK, C.WHITE) - 21) < 0.01);
  assert.ok(Math.abs(C.contrast(C.WHITE, C.WHITE) - 1) < 1e-9);
  let s = {name: 't', colors: Array(12).fill(C.BLACK)};
  s = C.schemeSet(s, 'accent3', C.WHITE);
  assert.deepEqual(C.schemeGet(s, 'accent3'), C.WHITE);
  assert.deepEqual(C.schemeGet(s, 'tx1'), C.BLACK);
  for (const slot of C.THEME_SLOTS) assert.equal(C.slotFromXml(slot), slot);
});
