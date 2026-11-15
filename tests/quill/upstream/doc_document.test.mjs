// Ported from wordcraft crates/doc/src/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// Each test names the Rust test it translates. Offsets are UTF-16 units (U+FFFC is one unit
// where upstream counts three UTF-8 bytes); part ids and list ids are numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Document, BODY} from '../../../core/quill/model/document.mjs';
import {createContent, contentFromText, revision, comment, buildingBlock} from '../../../core/quill/model/content.mjs';
import {paragraphWithText, newParagraph, insertObject, insertText, defaultFloat, OBJ} from '../../../core/quill/model/para.mjs';
import {addList, numOf, abstractOf, levelsFor, restartList, freeId} from '../../../core/quill/model/numbering.mjs';
import {countWords} from '../../../core/quill/model/text.mjs';
import {newTable} from '../../../core/quill/model/table.mjs';
import {bodyFromBlocks} from '../../../core/quill/model/body.mjs';

const U32_MAX = 4294967295;
const pos = (block, off) => ({story: BODY, path: [block], off});
const at = id => ({story: id, path: [0], off: 0});
const shape = (story, id = 0, w = 50, h = 20) => ({type: 'shape', kind: 'textBox', w, h, fill: null, stroke: null, strokeWidth: 0,
  float: defaultFloat(), story, freeform: null, effects: {}, extra: id ? {id} : {}});
const paraOf = t => [paragraphWithText(t)];
/** Replace the body with `blocks` (tests build documents directly, as upstream assigns d.body). */
const setBody = (d, blocks) => { const bl = d.storyMut(BODY); bl.splice(0, bl.len(), blocks); };
const pushBody = (d, blocks) => { const bl = d.storyMut(BODY); bl.splice(bl.len(), 0, blocks); };
/** `blocks` in the only cell of `levels` tables, each nested in the next. */
function nestedTables(levels, blocks) {
  let inner = blocks;
  for (let i = 0; i < levels; i++) { const t = newTable(1, 1, 100); t.rows[0].cells[0].blocks = inner; inner = [t]; }
  return inner;
}
/** A paragraph showing text box story `story` (drawing id `id`). */
function boxPara(story, id) {
  const p = paragraphWithText('cell');
  insertObject(p, 0, shape(story, id));
  return [p];
}
const fs = instr => ({type: 'fieldStart', instr, locked: false, dirty: false});
const withNum = (p, num) => { p.props = {...(p.props || {}), numbering: {num, level: 0}}; return p; };
/** A paragraph that is nothing but `objs`. */
function paraOfObjects(objs) {
  const p = newParagraph();
  p.text = OBJ.repeat(objs.length);
  p.runs = objs.length ? [{len: objs.length}] : [];
  if (objs.length) p.objects = objs;
  return p;
}

test('new_document_is_valid', () => {
  const d = Document.create();
  assert.equal(d.story(BODY).len(), 1);
  assert.equal(d.paraPaths(BODY).length, 1);
  assert.equal(d.plainText(BODY), '');
  assert.equal(d.sections().length, 1);
});

test('word_count', () => {
  const d = Document.fromText('Hello, world!\nThis is — a test 42.\n\n');
  assert.equal(d.wordCount(), 7);
  assert.equal(countWords(' -- '), 0);
});

test('word_count_includes_numbered_list_labels_but_not_bullets', () => {
  const d = Document.create();
  let r = addList(d.numbering, 'numbered'); const num = r.num;
  r = addList(r.numbering, 'bullet'); const bul = r.num;
  d.setField('numbering', r.numbering);
  setBody(d, [withNum(paragraphWithText('Apple'), num), withNum(paragraphWithText('Banana'), num), withNum(paragraphWithText('Cherry'), bul),
    withNum(paragraphWithText('Date'), bul)]);
  assert.equal(d.wordCount(), 6);
  assert.equal(d.plainText(BODY), 'Apple\nBanana\nCherry\nDate');
});

test('word_count_includes_numbered_labels_with_nothing_suffix', () => {
  const d = Document.create();
  const r = addList(d.numbering, 'numbered');
  const aid = numOf(r.numbering, r.num).abstractId;
  const numbering = {...r.numbering, abstracts: r.numbering.abstracts.map(a => (a.id === aid ? {...a, levels: a.levels.map((l, i) => (i === 0 ? {...l, suffix: 'nothing'} : l))} : a))};
  d.setField('numbering', numbering);
  setBody(d, [withNum(paragraphWithText('Apple'), r.num), withNum(paragraphWithText('Banana Cherry'), r.num)]);
  assert.equal(d.wordCount(), 5);
});

test('sections_and_section_mut', () => {
  const d = Document.fromText('a\nb\nc');
  const p = d.paraMut(BODY, [0]);
  p.section = {...d.lastSection, id: d.newId(), landscape: true};
  const s = d.sections();
  assert.equal(s.length, 2);
  assert.equal(s[0][0], 0);
  assert.equal(d.sectionIndexOf(0), 0);
  assert.equal(d.sectionIndexOf(2), 1);
  d.updateSection(0, x => { x.marginLeft = 10; });
  d.updateSection(2, x => { x.marginLeft = 20; });
  assert.equal(d.sections()[0][1].marginLeft, 10);
  assert.equal(d.lastSection.marginLeft, 20);
});

test('parts_and_media', () => {
  const d = Document.create();
  const id = d.addPart('header', []);
  assert.equal(d.story(id).len(), 1);
  const k1 = d.addMedia('AQID', 'png');
  const k2 = d.addMedia('AQID', 'png');
  const k3 = d.addMedia('BA==', 'png');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

test('many_distinct_media_add_in_linear_time', () => {
  const d = Document.create();
  const t = performance.now();
  const n = 40_000;
  const b64 = i => 'Bwc'.repeat(85) + i.toString(36).padStart(6, '0');
  for (let i = 0; i < n; i++) d.addMedia(b64(i), 'png');
  assert.equal(Object.keys(d.content.media).length, n);
  assert.equal(d.addMedia(b64(0), 'png'), 'image1.png');
  d.updateField('media', m => { m['direct.png'] = 'CQk='; });
  assert.equal(d.addMedia('CQk=', 'png'), 'direct.png');
  assert.ok(performance.now() - t < 10_000);
});

test('media_keys_skip_taken_names_once', () => {
  const d = Document.create();
  d.updateField('media', m => { for (let i = 2; i < 2002; i++) m[`image${i}.png`] = `m${i}`; });
  assert.equal(d.addMedia('AA==', 'png'), 'image2002.png');
  assert.equal(d.addMedia('AQ==', 'png'), 'image2003.png');
  assert.equal(d.addMedia('Ag==', 'png'), 'image2004.png');
});

test('free_ids_skip_taken_ones_instead_of_overflowing', () => {
  assert.equal(freeId(null, [], 1), 1);
  assert.equal(freeId(7, [3, 7], 1), 8);
  assert.equal(freeId(0, [0], 1), 1);
  assert.equal(freeId(U32_MAX, [1, 2, 4, U32_MAX], 1), 3);
  assert.equal(freeId(U32_MAX, [U32_MAX, 1, 0, 1], 0), 2);
  assert.equal(freeId(U32_MAX, [U32_MAX, U32_MAX - 1, U32_MAX - 2], U32_MAX - 2), null);
});

test('parts_and_lists_after_the_largest_ids_take_free_ones', () => {
  const d = Document.create();
  d.updateField('parts', parts => { for (const id of [0, 1, U32_MAX]) parts[id] = {kind: 'header', blocks: paraOf(String(id))}; });
  const before = {...d.parts};
  assert.equal(d.tryAddPart('comment', []), 2);
  assert.equal(d.addPart('footer', []), 3);
  for (const [k, p] of Object.entries(before)) assert.equal(d.parts[k], p);

  let n = addList(d.numbering, 'bullet').numbering;
  n = addList(n, 'bullet').numbering;
  n = {...n, abstracts: n.abstracts.map((a, i) => (i === 1 ? {...a, id: U32_MAX} : a)),
    nums: n.nums.map((x, i) => (i === 1 ? {...x, id: U32_MAX, abstractId: U32_MAX} : x))};
  const lists = n;
  const r = addList(n, 'numbered');
  assert.deepEqual([r.num, numOf(r.numbering, r.num).abstractId], [2, 1]);
  assert.deepEqual(abstractOf(r.numbering, r.num).levels, levelsFor('numbered'));
  const rs = restartList(r.numbering, r.num);
  assert.equal(rs.num, 3);
  assert.equal(numOf(rs.numbering, 3).abstractId, 1);
  assert.deepEqual([rs.numbering.abstracts.slice(0, 2), rs.numbering.nums.slice(0, 2)], [lists.abstracts, lists.nums]);
});

test('clone_is_shallow', () => {
  const d = Document.fromText('a\nb');
  const e = new Document(d.content);
  e.insertText(pos(1, 0), 'x');
  assert.equal(d.story(BODY).get(0), e.story(BODY).get(0));
  assert.notEqual(d.story(BODY).get(1), e.story(BODY).get(1));
  assert.equal(d.plainText(BODY), 'a\nb');
});

test('same_content_sees_every_change', () => {
  const d = Document.fromText('Hello\nWorld');
  const fresh = () => new Document(d.content);
  assert.ok(d.sameContent(fresh()), 'a copy is the same document');
  let e = fresh(); e.insertText(pos(0, 0), 'x'); assert.ok(!d.sameContent(e), 'the text changed');
  e = fresh(); e.formatRange(pos(0, 0), pos(0, 5), c => ({...c, bold: true})); assert.ok(!d.sameContent(e), 'the formatting changed');
  e = fresh(); e.updateField('styles', st => { st.styles = st.styles.map(x => (x.id === 'Normal' ? {...x, chr: {...x.chr, bold: true}} : x)); });
  assert.ok(!d.sameContent(e), 'a style changed');
  e = fresh(); e.setField('numbering', addList(e.numbering, 'numbered').numbering); assert.ok(!d.sameContent(e), 'a list was added');
  e = fresh(); e.updateField('settings', st => { st.trackChanges = true; }); assert.ok(!d.sameContent(e), 'a setting changed');
  e = fresh(); e.updateField('core', c => { c.title = 'Draft'; }); assert.ok(!d.sameContent(e), 'the title changed');
  e = fresh(); e.addPart('header', [newParagraph()]); assert.ok(!d.sameContent(e), 'a part was added');
  e = fresh(); e.updateField('media', m => { m['i.png'] = 'AQID'; }); assert.ok(!d.sameContent(e), 'a picture was added');
  e = fresh(); e.updateField('revisions', r => { r.push(revision('insert', 'Mira', '2026-10-23T00:00:00Z')); }); assert.ok(!d.sameContent(e), 'a revision was recorded');
  e = fresh(); e.updateField('comments', c => { c[1] = comment({author: 'Mira'}); }); assert.ok(!d.sameContent(e), 'a comment was added');
  e = fresh(); e.paraMut(BODY, [0]); assert.ok(d.sameContent(e), 'the paragraph was only copied');
  const d2 = Document.fromText('Hello');
  d2.insertBlock(BODY, [0], newTable(2, 2, 200));
  const e2 = new Document(d2.content);
  e2.updateTable(BODY, [0], t => ({...t}));
  assert.notEqual(d2.story(BODY).get(0), e2.story(BODY).get(0));
  assert.ok(d2.sameContent(e2), 'the table was only copied');
  e2.updateTable(BODY, [0], t => ({...t, rows: t.rows.map((r, ri) => (ri === 1 ? {...r, cells: r.cells.map((c, ci) => (ci === 1 ? {...c, blocks: [paragraphWithText('x', {}, c.blocks[0].id)]} : c))} : r))}));
  assert.ok(!d2.sameContent(e2), "a cell's text changed");
  const e3 = new Document(d2.content);
  e3.updateField('glossary', g => { g.push(buildingBlock({name: 'Sign-off'})); });
  assert.ok(!d2.sameContent(e3), 'a building block was added');
});

test('json_round_trip', () => {
  const d = Document.fromText('Hello\nWorld');
  d.formatRange(pos(0, 0), pos(0, 5), c => ({...c, bold: true}));
  const back = new Document(JSON.parse(JSON.stringify(d.content)));
  assert.equal(back.plainText(BODY), 'Hello\nWorld');
  assert.equal(back.para(BODY, [0]).runs[0].props.bold, true);
});

test('ensure_nonempty_repairs', () => {
  const d = Document.create();
  setBody(d, [newTable(1, 1, 100)]);
  d.ensureNonempty();
  assert.equal(d.story(BODY).last().kind, 'para');
});

test('text_box_anchor_finds_the_owning_shape', () => {
  const d = Document.fromText('Before after');
  const id = d.addPart('textBox', paraOf('Inside'));
  d.insertObject(pos(0, 0), shape(null, 0, 144, 72));
  const end = d.insertObject(pos(0, 8), shape(id, 0, 144, 72));
  assert.deepEqual(d.textBoxAnchor(id), end);
  assert.equal(d.textBoxAnchor(id + 1), null);
});

test('word_count_including_notes_counts_used_boxes_and_notes_only', () => {
  const d = Document.fromText('one two');
  const boxed = d.addPart('textBox', paraOf('three four'));
  const nested = d.addPart('textBox', paraOf('five'));
  const note = d.addPart('footnote', paraOf('six seven'));
  d.addPart('textBox', paraOf('orphan words here'));
  const hdr = d.addPart('header', paraOf('header words'));
  d.addPart('comment', paraOf('comment words'));
  d.insertObject(pos(0, 3), shape(boxed, 0, 144, 72));
  d.insertObject(at(boxed), shape(nested, 0, 144, 72));
  d.insertObject(pos(0, 0), {type: 'noteRef', kind: 'footnote', id: note, custom: ''});
  d.insertObject(pos(0, 0), shape(hdr, 0, 144, 72));
  assert.equal(d.wordCount(), 2);
  assert.equal(d.wordCountIncludingNotes(), 7);
  assert.deepEqual(d.countedStories(), [BODY, note, boxed, nested]);
});

test('counted_stories_survive_self_nested_boxes', () => {
  const d = Document.fromText('a');
  const id = d.addPart('textBox', paraOf('b'));
  d.insertObject(pos(0, 0), shape(id, 0, 10, 10));
  d.insertObject(at(id), shape(id, 0, 10, 10));
  assert.equal(d.wordCountIncludingNotes(), 2);
});

test('prune_text_boxes_drops_only_unshown_ones', () => {
  const d = Document.fromText('body');
  assert.equal(d.pruneTextBoxes(), 0);
  const shown = d.addPart('textBox', paraOf('shown'));
  const nested = d.addPart('textBox', paraOf('inside shown'));
  const orphan = d.addPart('textBox', paraOf('deleted box'));
  const orphanChild = d.addPart('textBox', paraOf('inside the deleted box'));
  const hdr = d.addPart('header', paraOf('header'));
  const inHeader = d.addPart('textBox', paraOf('box in the header'));
  d.insertObject(pos(0, 0), shape(shown));
  d.insertObject(at(shown), shape(nested));
  d.insertObject(at(orphan), shape(orphanChild));
  d.insertObject(at(hdr), shape(inHeader));
  assert.equal(d.pruneTextBoxes(), 2);
  assert.deepEqual(Object.keys(d.parts).map(Number), [shown, nested, hdr, inHeader]);
  assert.equal(d.pruneTextBoxes(), 0);
});

test('text_boxes_shown_from_deeply_nested_tables_are_kept', () => {
  const d = Document.fromText('body');
  const at17 = d.addPart('textBox', paraOf('17 tables down'));
  const at40 = d.addPart('textBox', paraOf('40 tables down'));
  const inner = d.addPart('textBox', paraOf('deep in a box'));
  const outer = d.addPart('textBox', nestedTables(18, boxPara(inner, 0)));
  const inHeader = d.addPart('textBox', paraOf('deep in a header'));
  const hdr = d.addPart('header', nestedTables(20, boxPara(inHeader, 0)));
  const unshown = d.addPart('textBox', paraOf('shown nowhere'));
  pushBody(d, nestedTables(17, boxPara(at17, 0)));
  pushBody(d, nestedTables(40, boxPara(at40, 7)));
  pushBody(d, boxPara(outer, 0));
  assert.equal(d.pruneTextBoxes(), 1);
  assert.ok(!Object.hasOwn(d.parts, unshown));
  assert.deepEqual(Object.keys(d.parts).map(Number), [at17, at40, inner, outer, inHeader, hdr]);
  assert.equal(d.pruneTextBoxes(), 0);
  assert.deepEqual(d.countedStories(), [BODY, at17, at40, outer, inner]);
  assert.equal(d.nextShapeId(), 8);
});

test('a_deeply_nested_table_is_copied_with_its_text_boxes', () => {
  const d = Document.fromText('body');
  const deep = d.addPart('textBox', paraOf('deep box'));
  pushBody(d, nestedTables(17, boxPara(deep, 0)));
  const frag = d.bodyFragment();
  assert.deepEqual(Object.keys(frag.parts).map(Number), [deep]);
  const e = Document.create();
  const own = e.addPart('textBox', paraOf('its own box'));
  assert.equal(own, deep, 'the same id in both documents');
  setBody(e, boxPara(own, 0));
  e.insertFragment(e.endOf(BODY), frag);
  const shown = [];
  e.objectsInReadingOrder(o => { if (o.type === 'shape' && o.story !== null && o.story !== undefined) shown.push(o.story); });
  assert.deepEqual(shown.map(id => e.plainText(id)), ['its own box', 'deep box']);
});

test('notes_in_text_box_follow_nested_boxes_once', () => {
  const d = Document.create();
  const outer = d.addPart('textBox', [newParagraph()]);
  const inner = d.addPart('textBox', [newParagraph()]);
  const n1 = d.addPart('footnote', []), n2 = d.addPart('footnote', []);
  const note = id => ({type: 'noteRef', kind: 'footnote', id, custom: ''});
  d.insertObject(at(outer), shape(outer));
  d.insertObject(at(outer), shape(inner));
  d.insertObject(at(outer), note(n1));
  d.insertObject(at(inner), note(n2));
  assert.deepEqual(d.notesInTextBox(outer), [n1, n2]);
  assert.deepEqual(d.notesInTextBox(inner), [n2]);
  assert.deepEqual(d.notesInTextBox(n1), [], 'not a text box');
});

test('field_ranges_pair_across_paragraphs_and_nest', () => {
  const d = Document.fromText('See .\nBib one\nBib two');
  const p0 = d.paraMut(BODY, [0]);
  insertObject(p0, 4, fs('ADDIN ZOTERO_ITEM CSL_CITATION {}'));
  const n = insertText(p0, 5, '(Smith 2020)');
  insertObject(p0, 5 + n, {type: 'fieldEnd'});
  insertObject(p0, 5, fs('ADDIN inner'));
  insertObject(p0, 6, {type: 'fieldEnd'});
  insertObject(d.paraMut(BODY, [1]), 0, fs('ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY'));
  const p2 = d.paraMut(BODY, [2]);
  insertObject(p2, p2.text.length, {type: 'fieldEnd'});
  const r = d.fieldRanges(BODY);
  assert.equal(r.length, 3);
  assert.ok(r[0].instr.startsWith('ADDIN ZOTERO_ITEM'));
  assert.deepEqual([r[0].start.off, r[0].depth], [4, 0]);
  assert.deepEqual([r[1].instr, r[1].depth], ['ADDIN inner', 1]);
  assert.deepEqual(r[2].start.path, [1]);
  assert.deepEqual(r[2].end.path, [2]);
  assert.ok(!d.hasUnbalancedFieldRanges());
  assert.equal(d.balanceFieldRanges(), 0);
  assert.equal(d.plainText(BODY), 'See (Smith 2020).\nBib one\nBib two');
});

test('orphan_field_markers_are_removed', () => {
  const d = Document.fromText('ab\ncd');
  const p0 = d.paraMut(BODY, [0]);
  insertObject(p0, 0, {type: 'fieldEnd'});
  // "␣a[x]b]": start after "␣a", end after "b" (one unit per marker here).
  insertObject(p0, 2, fs('ADDIN x'));
  insertObject(p0, 4, {type: 'fieldEnd'});
  insertObject(d.paraMut(BODY, [1]), 1, fs('ADDIN open'));
  assert.ok(d.hasUnbalancedFieldRanges());
  assert.equal(d.balanceFieldRanges(), 2);
  assert.ok(!d.hasUnbalancedFieldRanges());
  const r = d.fieldRanges(BODY);
  assert.equal(r.length, 1);
  assert.equal(r[0].instr, 'ADDIN x');
  assert.equal(d.plainText(BODY), 'ab\ncd');
});

test('custom_props_set_get_remove', () => {
  const d = Document.create();
  assert.equal(d.customProp('ZOTERO_PREF_1'), null);
  d.setCustomProp('ZOTERO_PREF_1', '<data/>');
  d.setCustomProp('Other', 'x');
  d.setCustomProp('zotero_pref_1', '<data2/>');
  assert.equal(d.content.customProps.length, 2);
  assert.equal(d.content.customProps[0].name, 'ZOTERO_PREF_1');
  assert.equal(d.customProp('Zotero_Pref_1'), '<data2/>');
  assert.ok(d.removeCustomProp('other'));
  assert.ok(!d.removeCustomProp('other'));
  assert.equal(d.content.customProps.length, 1);
});

test('object_walks_are_linear_in_the_paragraph', () => {
  const n = 40_000;
  const objs = [];
  for (let i = 0; i < n; i++) objs.push({type: 'bookmarkStart', name: `b${i}`}, fs('ADDIN x'), {type: 'permStart', id: i, group: 'everyone', editor: ''});
  for (let i = 0; i < n; i++) objs.push({type: 'fieldEnd'}, {type: 'permEnd', id: i});
  const d = new Document(createContent([paraOfObjects(objs)]));
  let t = performance.now();
  assert.equal(d.bookmarks().length, n);
  assert.equal(d.fieldRanges(BODY).length, n);
  const perms = d.permRanges();
  assert.equal(perms.length, n);
  assert.ok(perms.every(r => r.end.off > r.start.off), 'every range closed by its own end');
  assert.equal(d.textBoxAnchor(7), null);
  const firstEnd = 3 * n;
  assert.equal(d.pastFieldEnds(pos(0, firstEnd)).off, firstEnd + 1);
  assert.ok(performance.now() - t < 10_000);

  const e = new Document(createContent([paraOfObjects(Array.from({length: n}, () => ({type: 'fieldEnd'})))]));
  t = performance.now();
  assert.equal(e.pastFieldEnds(pos(0, 0)).off, n);
  const block = {tag: '', title: '', lock: 'unlocked', placeholder: '', showingPlaceholder: false, block: true, kind: {type: 'richText'}};
  const f = new Document(createContent([paraOfObjects(Array.from({length: n}, () => ({type: 'controlStart', control: block})))]));
  const end = pos(0, n);
  assert.deepEqual(f.typingPos(end), end);
  assert.ok(performance.now() - t < 10_000);
});

test('deleting_across_many_lone_control_markers_is_not_quadratic', () => {
  const n = 3000;
  const starts = Array.from({length: n}, () => ({type: 'controlStart', control: {kind: {type: 'richText'}}}));
  const c = contentFromText('before\n\nafter');
  const blocks = new Document(c).story(BODY).toArray();
  blocks[1] = paraOfObjects(starts);
  const d = new Document({...c, body: bodyFromBlocks(blocks)});
  const t = performance.now();
  const r = d.deleteRange(pos(0, 3), pos(2, 2));
  assert.deepEqual(r, pos(0, 3));
  assert.equal(d.plainText(BODY), 'befter');
  assert.ok(performance.now() - t < 10_000);
});

test('control_markers_kept_are_sorted', () => {
  const start = () => ({type: 'controlStart', control: {kind: {type: 'richText'}}});
  const blocks = [paragraphWithText('before')];
  for (let i = 0; i < 12; i++) blocks.push(paraOfObjects(i % 2 === 0 ? [start(), start()] : [{type: 'controlEnd'}, {type: 'controlEnd'}]));
  blocks.push(paragraphWithText('after'));
  const d = new Document(createContent(blocks));
  for (const [a, b] of [[pos(2, 1), pos(11, 1)], [pos(1, 1), pos(12, 1)], [pos(3, 1), pos(8, 0)]]) {
    const kept = d._keptControlMarkers(a, b);
    assert.ok(kept.length > 0, JSON.stringify([a, b]));
    const key = k => (Array.isArray(k) ? JSON.stringify(k) : String(k));
    for (let i = 1; i < kept.length; i++) assert.ok(cmpKept(kept[i - 1], kept[i]) < 0, `sorted, no repeats: ${kept.map(key).join(' ')}`);
  }
});

/** Order of kept markers ([path, off] pairs or {path, off}). */
function cmpKept(x, y) {
  const px = x.path ?? x[0], py = y.path ?? y[0];
  for (let i = 0; i < Math.min(px.length, py.length); i++) if (px[i] !== py[i]) return px[i] - py[i];
  if (px.length !== py.length) return px.length - py.length;
  return (x.off ?? x[1]) - (y.off ?? y[1]);
}
