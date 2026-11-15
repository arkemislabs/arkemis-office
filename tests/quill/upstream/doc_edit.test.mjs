// Ported from wordcraft crates/doc/src/edit/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// Each test names the Rust test it translates. Offsets are UTF-16 units (U+FFFC is one unit where
// upstream counts three bytes; é is one unit where upstream counts two).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Document, BODY, cmpPath, pathCell, fragmentPlainText, appendFragment} from '../../../core/quill/model/document.mjs';
import {paragraphWithText, newParagraph, insertObject, defaultFloat, OBJ} from '../../../core/quill/model/para.mjs';
import {newTable, MAX_TABLE_DEPTH} from '../../../core/quill/model/table.mjs';
import {fragmentFromText, PasteBudget, MAX_PASTED_BOX_BYTES, objectCost, tableHeight} from '../../../core/quill/model/edit.mjs';
import {defaultSection} from '../../../core/quill/model/section.mjs';

const doc = lines => Document.fromText(lines.join('\n'));
const pos = (block, off) => ({story: BODY, path: [block], off});
const at = (story, path, off) => ({story, path: [...path], off});
const boxShape = story => ({type: 'shape', kind: 'textBox', w: 144, h: 72, fill: null, stroke: null, strokeWidth: 0.75, float: defaultFloat(),
  story, freeform: null, effects: {}, extra: {}});
function textBox(d, p, text) {
  const id = d.addPart('textBox', [paragraphWithText(text)]);
  d.insertObject(p, boxShape(id));
  return id;
}
const boxesIn = (d, path) => (d.para(BODY, path).objects ?? []).filter(o => o.type === 'shape').map(o => o.story ?? null);
const throwsAndKeeps = (d, f) => { const before = d.plainText(BODY); assert.throws(f); assert.equal(d.plainText(BODY), before); };

test('paths_between_matches_every_path_filtered', () => {
  const d = doc(['a', 'b', 'c', 'd', 'e']);
  const inner = newTable(2, 2, 100);
  inner.rows[1].cells[0].blocks.push(newParagraph());
  const t = newTable(3, 2, 200);
  t.rows[1].cells[1].blocks.unshift(inner);
  d.insertBlock(BODY, [2], t);
  d.insertBlock(BODY, [4], newTable(1, 3, 200));
  const all = d.paraPaths(BODY);
  for (const a of all) for (const b of all) {
    const [lo, hi] = cmpPath(a, b) <= 0 ? [a, b] : [b, a];
    const want = all.filter(p => cmpPath(p, lo) >= 0 && cmpPath(p, hi) <= 0);
    assert.deepEqual(d.pathsBetween({story: BODY, path: a, off: 0}, {story: BODY, path: b, off: 0}), want);
  }
});

test('split_and_join', () => {
  const d = doc(['Hello world']);
  assert.deepEqual(d.splitParagraph(pos(0, 5)), pos(1, 0));
  assert.equal(d.plainText(BODY), 'Hello\n world');
  assert.deepEqual(d.deleteRange(pos(0, 5), pos(1, 0)), pos(0, 5));
  assert.equal(d.plainText(BODY), 'Hello world');
});

test('delete_range_with_bad_end_leaves_document_unchanged', () => {
  let d = doc(['one', 'two', 'three']);
  throwsAndKeeps(d, () => d.deleteRange(pos(0, 1), pos(9, 0)));
  throwsAndKeeps(d, () => d.deleteRange(pos(0, 1), pos(1, 99)));
  // An offset inside a character (a surrogate pair here; upstream: inside é's two bytes).
  d = doc(['abc', '\u{1F600}x']);
  throwsAndKeeps(d, () => d.deleteRange(pos(0, 1), pos(1, 1)));
  d = doc(['before', 'after']);
  d.insertBlock(BODY, [1], newTable(2, 1, 200));
  d.insertText(at(BODY, [1, 0, 0, 0], 0), 'x');
  throwsAndKeeps(d, () => d.deleteRange(pos(0, 99), at(BODY, [1, 1, 0, 0], 0)));
});

test('delete_multi', () => {
  const d = doc(['one', 'two', 'three']);
  d.deleteRange(pos(2, 2), pos(0, 1));
  assert.equal(d.plainText(BODY), 'oree');
  assert.equal(d.story(BODY).len(), 1);
});

test('delete_over_two_section_breaks_keeps_the_linked_headers', () => {
  const d = doc(['A', 'B', 'C']);
  const set = def => ({default: def, first: null, even: null});
  const base = defaultSection();
  const s1 = {...defaultSection(), headers: set(1), footers: set(5)};
  const s2 = {...defaultSection(), headers: set(2)};
  const s3 = {...defaultSection(), marginLeft: 99};
  [s1, s2, s3].forEach((s, i) => { d.paraMut(BODY, [i]).section = s; });
  assert.equal(d.sections().length, 4);
  d.deleteRange(pos(0, 1), pos(2, 0));
  assert.equal(d.plainText(BODY), 'AC');
  const sections = d.sections();
  assert.equal(sections.length, 2);
  const got = sections[0][1];
  assert.deepEqual({...got, id: undefined}, {...s3, headers: set(2), footers: set(5), id: undefined});
  void base;
});

test('format_across', () => {
  const d = doc(['abc', 'def']);
  d.formatRange(pos(0, 1), pos(1, 2), c => ({...c, bold: true}));
  const c0 = (p, i) => (p.runs.reduce((acc, r) => { if (acc.left !== null && acc.left < r.len) { acc.hit = r.props ?? {}; acc.left = null; } else if (acc.left !== null) acc.left -= r.len; return acc; }, {left: i, hit: null}).hit ?? {});
  const p0 = d.para(BODY, [0]), p1 = d.para(BODY, [1]);
  assert.equal(c0(p0, 0).bold, undefined);
  assert.equal(c0(p0, 1).bold, true);
  assert.equal(c0(p1, 1).bold, true);
  assert.equal(c0(p1, 2).bold, undefined);
});

test('copy_paste_round_trip', () => {
  const d = doc(['alpha', 'beta', 'gamma']);
  const f = d.copyRange(pos(0, 2), pos(2, 3));
  assert.equal(fragmentPlainText(f), 'pha\nbeta\ngam');
  const end = d.insertFragment(pos(2, 5), f);
  assert.equal(d.plainText(BODY), 'alpha\nbeta\ngammapha\nbeta\ngam');
  assert.deepEqual(end, pos(4, 3));
  const e = d.insertFragment(pos(0, 0), fragmentFromText('XY'));
  assert.deepEqual(e, pos(0, 2));
  assert.ok(d.plainText(BODY).startsWith('XYalpha'));
});

/** The first paragraph of the deepest cell, following the first table at each level. */
function deepest(d) {
  const path = [];
  let blocks = d.story(BODY).toArray();
  for (;;) {
    const i = blocks.findIndex(b => b.kind === 'table');
    if (i < 0) break;
    path.push(i, 0, 0);
    blocks = blocks[i].rows[0].cells[0].blocks;
  }
  path.push(0);
  return path;
}
const bodyHeight = d => Math.max(0, ...d.story(BODY).toArray().filter(b => b.kind === 'table').map(tableHeight));
const count = (blocks, c) => blocks.reduce((n, b) => n + (b.kind === 'para' ? b.text.split(c).length - 1 : b.rows.flatMap(r => r.cells).reduce((m, cell) => m + count(cell.blocks, c), 0)), 0);
const depthOf = path => Math.floor((path.length - 1) / 3);

test('tables_nest_at_most_max_table_depth', () => {
  const d = doc(['x', '']);
  for (let i = 0; i < MAX_TABLE_DEPTH; i++) d.insertBlock(BODY, deepest(d), newTable(1, 1, 100));
  assert.equal(bodyHeight(d), MAX_TABLE_DEPTH);
  const where = deepest(d);
  assert.equal(depthOf(where), MAX_TABLE_DEPTH);
  const before = d.content;
  assert.throws(() => d.insertBlock(BODY, where, newTable(1, 1, 100)));
  assert.ok(d.sameContent(before));
  d.insertBlock(BODY, where, newParagraph());
  const up = where.slice(0, -3);
  const two = newTable(1, 1, 100);
  two.rows[0].cells[0].blocks.unshift(newTable(1, 1, 100));
  assert.throws(() => d.insertBlock(BODY, up, two));
  d.insertBlock(BODY, up, newTable(1, 1, 100));
  assert.equal(bodyHeight(d), MAX_TABLE_DEPTH);
});

test('pasting_a_table_into_its_own_cell_stops_at_max_table_depth', () => {
  const d = doc(['x', '']);
  d.insertBlock(BODY, [1], newTable(1, 1, 100));
  d.insertText(at(BODY, [1, 0, 0, 0], 0), 'a');
  for (let i = 0; i < 8; i++) {
    const all = d.copyRange(pos(0, 0), pos(d.story(BODY).len() - 1, 0));
    const where = deepest(d);
    const off = d.para(BODY, where)?.text.length ?? 0;
    d.insertFragment(at(BODY, where, off), all);
  }
  assert.equal(bodyHeight(d), MAX_TABLE_DEPTH);
  const blocks = d.story(BODY).toArray();
  assert.deepEqual([count(blocks, 'x'), count(blocks, 'a')], [256, 256]);
});

test('pasted_text_box_gets_its_own_story', () => {
  const d = doc(['ab', 'cd']);
  const id = textBox(d, pos(0, 1), 'Inside');
  const f = d.copyRange(pos(0, 0), pos(0, 3));
  assert.deepEqual(Object.keys(f.parts).map(Number), [id]);
  d.insertText(at(id, [0], 6), ' later');
  d.insertFragment(pos(1, 2), f);
  const [fresh, ...rest] = boxesIn(d, [1]);
  assert.equal(rest.length, 0);
  assert.ok(fresh !== null && fresh !== id);
  assert.equal(d.parts[fresh].kind, 'textBox');
  assert.equal(d.plainText(fresh), 'Inside');
  assert.equal(d.plainText(id), 'Inside later');
  d.insertText(at(fresh, [0], 0), 'Copy: ');
  assert.equal(d.plainText(id), 'Inside later');
  d.insertFragment(pos(1, 0), f);
  const again = boxesIn(d, [1]);
  assert.equal(again.length, 2);
  assert.ok(again.every(s => s !== null && s !== id) && again[0] !== again[1]);
  const f2 = d.copyRange(pos(0, 0), pos(1, 1));
  const before = Object.keys(d.parts).length;
  d.insertFragment(pos(1, 0), f2);
  assert.equal(Object.keys(d.parts).length, before + 1);
});

test('text_box_pasted_into_another_document_brings_its_text', () => {
  const src = doc(['x']);
  const id = textBox(src, pos(0, 1), 'From the source');
  const f = src.copyRange(pos(0, 0), pos(0, 2));
  const dst = doc(['target']);
  const hdr = dst.addPart('header', [paragraphWithText('Header text')]);
  assert.equal(hdr, id);
  dst.insertFragment(pos(0, 6), f);
  const [fresh] = boxesIn(dst, [0]);
  assert.notEqual(fresh, hdr);
  assert.equal(dst.plainText(fresh), 'From the source');
  assert.equal(dst.plainText(hdr), 'Header text');
  const dst2 = doc(['t']);
  dst2.insertFragment(pos(0, 1), src.bodyFragment());
  const [n2] = boxesIn(dst2, [0]);
  assert.equal(dst2.plainText(n2), 'From the source');
});

test('text_box_in_a_copied_table_gets_its_own_story', () => {
  const d = doc(['before', 'after']);
  d.insertBlock(BODY, [1], newTable(1, 1, 200));
  const id = textBox(d, at(BODY, [1, 0, 0, 0], 0), 'In a cell');
  const f = d.copyRange(pos(0, 0), pos(2, 5));
  assert.ok(Object.hasOwn(f.parts, id));
  d.insertFragment(pos(2, 5), f);
  const ids = d.paraPaths(BODY).flatMap(p => (d.para(BODY, p).objects ?? []).filter(o => o.type === 'shape' && o.story != null).map(o => o.story));
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every(i => d.plainText(i) === 'In a cell'));
});

test('fragment_without_parts_never_shows_an_unrelated_story', () => {
  const d = doc(['x']);
  const hdr = d.addPart('header', []);
  const own = d.addPart('textBox', [paragraphWithText('Mine')]);
  const p = newParagraph();
  insertObject(p, 0, boxShape(hdr));
  insertObject(p, 0, boxShape(own));
  insertObject(p, 0, boxShape(999));
  d.insertFragment(pos(0, 1), {blocks: [p], parts: {}});
  const got = boxesIn(d, [0]);
  assert.equal(got.length, 3);
  assert.equal(got[0], null, 'missing story');
  assert.ok(got[1] !== null && got[1] !== own);
  assert.equal(d.plainText(got[1]), 'Mine');
  assert.equal(got[2], null, "a header isn't a text box");
});

test('self_nested_text_box_paste_is_bounded', () => {
  const d = doc(['x']);
  const id = textBox(d, pos(0, 1), 'loop');
  d.insertObject(at(id, [0], 0), boxShape(id));
  const f = d.copyRange(pos(0, 0), pos(0, 2));
  const before = Object.keys(d.parts).length;
  d.insertFragment(pos(0, 0), f);
  assert.equal(Object.keys(d.parts).length - before, 1);
});

function fanOut(story, refs) {
  const p = newParagraph();
  for (let i = 0; i < refs; i++) insertObject(p, 0, boxShape(1));
  return {blocks: [p], parts: {1: {kind: 'textBox', blocks: story}}};
}

test('pasted_boxes_share_the_blocks_they_need_not_copy', () => {
  const big = paragraphWithText('x'.repeat(100_000));
  const d = doc(['x']);
  d.insertFragment(pos(0, 1), fanOut([big], 3));
  const ids = boxesIn(d, [0]).filter(x => x !== null);
  assert.equal(ids.length, 3, 'each box has a story');
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.equal(d.parts[id].blocks[0].text, big.text);
  // Shared, not copied: the run array is the same object.
  for (const id of ids) assert.equal(d.parts[id].blocks[0].runs, big.runs);
});

test('a_box_over_the_budget_leaves_later_smaller_boxes_their_stories', () => {
  const bp = paragraphWithText('x'.repeat(100_000));
  insertObject(bp, 0, boxShape(999));
  const small = paragraphWithText('small');
  const p = newParagraph();
  for (const story of [2, 1, 2, 1]) insertObject(p, 0, boxShape(story));
  const parts = {1: {kind: 'textBox', blocks: [bp]}, 2: {kind: 'textBox', blocks: [small]}};
  const blocks = [p];
  const d = doc(['x']);
  const budget = new PasteBudget();
  budget.bytes = 50_000;
  d._adoptTextBoxes(blocks, parts, 0, budget);
  const got = blocks[0].objects.map(o => o.story ?? null);
  assert.deepEqual(got.map(x => x !== null), [false, true, false, true]);
  assert.equal(budget.skipped, 2);
  assert.equal(budget.costs.size, 2, 'each story costed once');
});

test('many_boxes_sharing_one_story_paste_with_their_text', () => {
  const big = paragraphWithText('x'.repeat(1 << 20));
  const d = doc(['x']);
  d.insertFragment(pos(0, 1), fanOut([big], 64));
  assert.ok(!(d.warnings ?? []).some(w => w.includes('text boxes are left empty')));
  const ids = boxesIn(d, [0]).filter(x => x !== null);
  assert.equal(ids.length, 64, 'every box keeps a story');
  for (const id of ids) { assert.equal(d.parts[id].blocks.length, 1); assert.equal(d.parts[id].blocks[0].runs, big.runs); }
});

test('pasted_box_copies_are_capped_in_bytes', () => {
  const p = paragraphWithText('x'.repeat(1 << 20));
  insertObject(p, 0, boxShape(999));
  const d = doc(['x']);
  const before = Object.keys(d.parts).length;
  d.insertFragment(pos(0, 1), fanOut([p], 64));
  const added = Object.keys(d.parts).length - before;
  const empty = (d.warnings ?? []).filter(w => w.includes('text boxes are left empty'));
  assert.equal(empty.length, 1);
  assert.ok(empty[0].startsWith(`paste: ${64 - added} text boxes`), empty[0]);
  const copied = Object.values(d.parts).flatMap(x => x.blocks).reduce((n, b) => n + (b.kind === 'para' ? b.text.length : 0), 0);
  assert.ok(added >= 1 && added < 64, String(added));
  assert.ok(copied <= MAX_PASTED_BOX_BYTES, String(copied));
  assert.equal(boxesIn(d, [0]).filter(x => x !== null).length, added);
});

test('pasted_box_copies_count_the_objects_they_copy', () => {
  const p = paragraphWithText('x');
  insertObject(p, 0, boxShape(999));
  insertObject(p, 0, {type: 'opaque', format: 'docx', xml: 'x'.repeat(1 << 20), text: ''});
  const d = doc(['x']);
  const before = Object.keys(d.parts).length;
  d.insertFragment(pos(0, 1), fanOut([p], 64));
  const added = Object.keys(d.parts).length - before;
  const copied = Object.values(d.parts).flatMap(x => x.blocks).reduce((n, b) => n + (b.kind === 'para' ? (b.objects ?? []).reduce((m, o) => m + (o.type === 'opaque' ? o.xml.length : 0), 0) : 0), 0);
  assert.ok(added >= 1 && added < 64, String(added));
  assert.ok(copied <= MAX_PASTED_BOX_BYTES, String(copied));
  const member = obj => ({x: 0, y: 0, obj});
  const deep = {type: 'opaque', format: '', xml: 'y'.repeat(5000), text: ''};
  const inner = {type: 'group', w: 1, h: 1, float: defaultFloat(), ch_w: 1, ch_h: 1, children: [member(deep)], canvas: null};
  const outer = {type: 'group', w: 1, h: 1, float: defaultFloat(), ch_w: 1, ch_h: 1, children: [member(inner)], canvas: null};
  assert.ok(objectCost(outer) >= 5000);
  // Upstream also costs an equation of 5000 nodes; equations keep their linear text here.
  assert.ok(objectCost({type: 'equation', linear: 'z'.repeat(5000), display: false}) >= 5000);
});

test('tables_in_paths', () => {
  const d = doc(['before', 'after']);
  d.insertBlock(BODY, [1], newTable(2, 2, 200));
  const paths = d.paraPaths(BODY);
  assert.equal(paths.length, 6);
  assert.deepEqual(paths[1], [1, 0, 0, 0]);
  const cell = at(BODY, [1, 0, 1, 0], 0);
  assert.equal(d.insertText(cell, 'x').off, 1);
  assert.deepEqual(d.nextPara(BODY, [1, 0, 1, 0]), [1, 1, 0, 0]);
  assert.ok(d.plainText(BODY).includes('\tx'));
  d.deleteRange(pos(0, 2), cell);
  assert.equal(d.para(BODY, [0]).text, 'be');
  assert.ok(d.container(BODY, [1, 0, 0, 0]));
  assert.deepEqual(pathCell([1, 0, 1, 0]), [[1], 0, 1]);
});

const para = t => paragraphWithText(t);

test('appended_pieces_are_each_followed_by_one_paragraph_mark', () => {
  let spike = {blocks: [], parts: {}};
  spike = appendFragment(spike, {blocks: [para('a')], parts: {}});
  spike = appendFragment(spike, {blocks: [para('b')], parts: {}});
  assert.equal(fragmentPlainText(spike), 'a\nb\n');
  spike = appendFragment({blocks: [], parts: {}}, {blocks: [para('a'), para('')], parts: {}});
  assert.equal(fragmentPlainText(spike), 'a\n');
  spike = appendFragment(spike, {blocks: [para('b'), para('c')], parts: {}});
  assert.equal(fragmentPlainText(spike), 'a\nb\nc\n');
});

test('appended_pieces_keep_their_own_text_boxes', () => {
  const one = doc(['x']);
  const id1 = textBox(one, pos(0, 1), 'One');
  const two = doc(['y']);
  const id2 = textBox(two, pos(0, 1), 'Two');
  assert.equal(id1, id2);
  let spike = {blocks: [], parts: {}};
  spike = appendFragment(spike, one.copyRange(pos(0, 0), pos(0, 2)));
  spike = appendFragment(spike, two.copyRange(pos(0, 0), pos(0, 2)));
  const dst = doc(['']);
  dst.insertFragment(pos(0, 0), spike);
  const texts = [0, 1].flatMap(i => boxesIn(dst, [i])).map(b => dst.plainText(b));
  assert.deepEqual(texts, ['One', 'Two']);
});

test('bad_positions_error', () => {
  const d = doc(['\u{1F600}']);
  assert.throws(() => d.insertText(pos(0, 1), 'x'));
  assert.throws(() => d.insertText(pos(5, 0), 'x'));
  assert.throws(() => d.splitParagraph(pos(0, 99)));
  assert.deepEqual(d.clamp(pos(9, 9)), pos(0, 2));
  assert.throws(() => d.deleteRange({story: 3, path: [0], off: 0}, pos(0, 0)));
});

// delete_range over whole tables (#1844), in the body, a header and a footnote.
const STORIES = [null, 'header', 'footnote'];
function storyDoc(kind, lines) {
  if (!kind) return [doc(lines), BODY];
  const d = doc(['body']);
  return [d, d.addPart(kind, lines.map(l => paragraphWithText(l)))];
}
function putTable(d, story, path, rows, cols, texts) {
  d.insertBlock(story, path, newTable(rows, cols, 200));
  texts.forEach((t, k) => d.insertText(at(story, [...path, Math.floor(k / cols), k % cols, 0], 0), t));
}
const shapeOf = (d, story) => d.story(story).toArray().map(b => (b.kind === 'para' ? b.text : '[table]'));
const cellText = (d, story, table, r, c) => d.para(story, [...table, r, c, 0])?.text ?? '<none>';

test('a_range_ending_at_the_end_of_a_cell_that_isnt_the_last_keeps_the_table', () => {
  for (const kind of STORIES) for (const [r, c] of [[0, 1], [1, 0]]) {
    const [d, st] = storyDoc(kind, ['before', 'after']);
    putTable(d, st, [1], 2, 2, ['a', 'b', 'c', 'd']);
    d.deleteRange(at(st, [0], 0), at(st, [1, r, c, 0], 1));
    assert.deepEqual(shapeOf(d, st), ['', '[table]', 'after'], `${kind} (${r},${c})`);
    assert.equal(cellText(d, st, [1], 1, 1), 'd');
  }
});

test('a_range_from_the_start_of_one_table_into_the_middle_of_the_next_removes_only_the_first', () => {
  for (const kind of STORIES) {
    const [d, st] = storyDoc(kind, ['x', 'mid', 'y']);
    putTable(d, st, [2], 2, 2, ['e', 'f', 'g', 'h']);
    putTable(d, st, [1], 2, 2, ['a', 'b', 'c', 'd']);
    assert.deepEqual(shapeOf(d, st), ['x', '[table]', 'mid', '[table]', 'y']);
    const to = d.deleteRange(at(st, [1, 0, 0, 0], 0), at(st, [3, 0, 1, 0], 1));
    assert.deepEqual(shapeOf(d, st), ['x', '', '[table]', 'y'], String(kind));
    assert.deepEqual([cellText(d, st, [2], 0, 0), cellText(d, st, [2], 0, 1), cellText(d, st, [2], 1, 0)], ['', '', 'g']);
    assert.ok(d.para(st, to.path));
  }
});

test('a_range_from_a_cell_paragraph_to_the_end_of_a_table_nested_in_that_cell_removes_only_the_nested_table', () => {
  for (const kind of STORIES) {
    const [d, st] = storyDoc(kind, ['before', 'after']);
    putTable(d, st, [1], 1, 1, ['p']);
    putTable(d, st, [1, 0, 0, 1], 1, 1, ['n']);
    d.insertBlock(st, [1, 0, 0, 2], paragraphWithText('q'));
    const to = d.deleteRange(at(st, [1, 0, 0, 0], 1), at(st, [1, 0, 0, 1, 0, 0, 0], 1));
    assert.deepEqual(shapeOf(d, st), ['before', '[table]', 'after']);
    assert.deepEqual(d.container(st, [1, 0, 0, 0]).toArray().map(b => (b.kind === 'para' ? b.text : '[table]')), ['pq']);
    assert.deepEqual(to, at(st, [1, 0, 0, 0], 1));
  }
});

test('two_whole_tables_at_the_end_of_a_story_leave_one_empty_paragraph', () => {
  for (const kind of STORIES) for (const trailing of [true, false]) {
    const [d, st] = storyDoc(kind, ['']);
    putTable(d, st, [0], 1, 2, ['a', 'b']);
    putTable(d, st, [1], 2, 1, ['c', 'd']);
    if (!trailing) { const bl = d.storyMut(st); bl.remove(bl.len() - 1); }
    const to = d.deleteRange(at(st, [0, 0, 0, 0], 0), at(st, [1, 1, 0, 0], 1));
    assert.deepEqual(shapeOf(d, st), [''], `${kind} trailing ${trailing}`);
    assert.deepEqual(to, at(st, [0], 0));
  }
});

test('removing_a_whole_table_keeps_a_control_the_range_only_partly_covers', () => {
  const start = () => ({type: 'controlStart', control: {kind: {type: 'richText'}}});
  for (const kind of STORIES) {
    const [d, st] = storyDoc(kind, ['before', 'after']);
    putTable(d, st, [1], 1, 1, ['c']);
    d.insertObject(at(st, [0], 4), {type: 'controlEnd'});
    const inBefore = d.insertObject(at(st, [0], 1), start());
    d.insertObject(at(st, [1, 0, 0, 0], 1), {type: 'controlEnd'});
    d.insertObject(at(st, [1, 0, 0, 0], 0), start());
    assert.equal(d.controlRanges(st).length, 2, 'setup');
    const end = d.para(st, [1, 0, 0, 0]).text.length;
    d.deleteRange({...inBefore, off: inBefore.off + 1}, at(st, [1, 0, 0, 0], end));
    assert.deepEqual(shapeOf(d, st), [`b${OBJ}e${OBJ}after`], String(kind));
    const ranges = d.controlRanges(st);
    assert.equal(ranges.length, 1);
    assert.ok(ranges.every(r => r.start.path.length === 1 && r.start.path[0] === 0 && r.end.path[0] === 0));
    assert.equal(d.para(st, [0]).objects.length, 2, 'no orphan markers left');
  }
});

test('a_table_nested_deeper_than_the_paragraph_walk_is_never_removed_whole', () => {
  let t = newTable(1, 1, 200);
  t.rows[0].cells[0].blocks = [paragraphWithText('deep')];
  for (let i = 0; i < 20; i++) { const outer = newTable(1, 1, 200); outer.rows[0].cells[0].blocks.unshift(t); t = outer; }
  const d = doc(['before', 'after']);
  d.insertBlock(BODY, [1], t);
  const first = d.paraPaths(BODY).find(p => p[0] === 1);
  d.deleteRange({story: BODY, path: first, off: 0}, pos(2, 0));
  assert.equal(d.story(BODY).get(1)?.kind, 'table', 'a table with paragraphs the walk never saw was removed');
});
