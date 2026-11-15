// Ported from wordcraft crates/engine/src/cmd/page/tests.rs at
// aadb077e072b7de05f724e359d8db82e151f125c (MIT, see assets/third-party-licenses/artcraft-reference.txt).
// Each test names the Rust test it ports. Not ported: text_direction_turns_the_section_or_the_cell,
// hyphenation_options_and_manual_hyphenation and page_number_format_keeps_or_clears_the_start
// (layout.textDirection, layout.hyphenation, layout.manualHyphenation and layout.pageNumberFormat
// are not registered: see core/quill/commands/page.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill, blocks} from '../format-fixture.mjs';
import {MARGIN_PRESETS, marginsPresetOf, columnsPresetOf} from '../../../core/quill/commands/page.mjs';
import {defaultSection, textWidth, MAX_GRID_PITCH, MAX_CHAR_SPACE, MAX_NOTE_START} from '../../../core/quill/model/section.mjs';
import {Document} from '../../../core/quill/model/document.mjs';
import {layout} from '../../../core/quill/layout/index.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';
import {read as readDocx} from '../../../core/quill/formats/docx-read.mjs';

const doc = () => quill('one\ntwo\nthree');
const sect = q => q.t.content && q.exec('layout.section').then(r => r.result);
const withSection = f => { const v = structuredClone(defaultSection('s0')); delete v.id; f(v); return {section: v}; };
const fails = async (q, id, p) => assert.rejects(() => q.exec(id, p), undefined, `${id} ${JSON.stringify(p).slice(0, 80)}`);

/** Each section's paragraph texts (a section break's own paragraph shows as "") and column count (sections_of). */
function sectionsOf(q) {
  const d = new Document(q.t.content);
  const out = [];
  let from = 0;
  for (const [end, x] of d.sections()) {
    const paras = [];
    for (let i = from; i <= end; i++) paras.push(d.story('body').get(i)?.text ?? '');
    out.push([paras, x.columns?.count ?? 1]);
    from = end + 1;
  }
  return out;
}
/** Select from (block, off) to (block, off) (select). */
const select = (q, a, b) => q.sel([a[0], a[1]], [b[0], b[1]]);
/** The selection as [[block, off], [block, off]] (anchor, focus). */
function selection(q) {
  const sel = q.t.session.get(q.t.docId).selection;
  const r = sel.ranges[sel.primary ?? 0];
  const ids = blocks(q.t).map(b => b.id);
  const at = a => { const m = /\/body\/b:([^/]+)\/t:(\d+)/.exec(a); return [ids.indexOf(m[1]), Number(m[2])]; };
  return [at(r.anchor), at(r.focus)];
}
/** The selected text (one paragraph or across paragraphs, \n between). */
function selectedText(q) {
  const [a, b] = selection(q).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const bs = blocks(q.t);
  if (a[0] === b[0]) return bs[a[0]].text.slice(a[1], b[1]);
  const parts = [bs[a[0]].text.slice(a[1])];
  for (let i = a[0] + 1; i < b[0]; i++) parts.push(bs[i].text);
  parts.push(bs[b[0]].text.slice(0, b[1]));
  return parts.join('\n');
}

test('page_setup_section_is_validated', async () => {
  const q = await doc();
  const before = await sect(q);
  for (const [what, p] of [
    ['inf width', withSection(v => { v.pageW = 1e300; })],
    ['inf margin', withSection(v => { v.marginTop = 1e300; })],
    ['inf header', withSection(v => { v.header = 1e300; })],
    ['inf column space', withSection(v => { v.columns.space = 1e300; })],
    ['inf column width', withSection(v => { v.columns.widths = [[1e300, 0], [100, 0]]; })],
    ['inf line number distance', withSection(v => { v.lineNumbers = {distance: 1e300}; })],
    ['inf grid pitch', withSection(v => { v.docGrid = {type: 'lines', linePitch: 1e300, charSpace: 0}; })],
    ['inf border space', withSection(v => { v.pageBorders = {top: {style: 'single', width: 1, space: 1e300}}; })],
    ['inf border width', withSection(v => { v.pageBorders = {top: {style: 'single', width: 1e300, space: 1}}; })],
    ['margins > page', withSection(v => { v.marginLeft = 5000; })],
    ['margins eat the height', withSection(v => { v.marginTop = 700; })],
    ['gutter eats the width', withSection(v => { v.gutter = 600; })],
    ['negative page', withSection(v => { v.pageW = -5; })],
    ['zero page height', withSection(v => { v.pageH = 0; })],
  ]) {
    await assert.rejects(() => q.exec('layout.pageSetup', p), undefined, what);
    assert.deepEqual(await sect(q), before, what);
  }
  // Clamped.
  await q.exec('layout.pageSetup', withSection(v => {
    Object.assign(v, {pageW: 100, pageH: 100, marginTop: -10, marginBottom: 0, marginLeft: 0, marginRight: 0, header: -3, footer: 1e6});
    v.columns.count = 1000; v.columns.space = -4;
    v.lineNumbers = {countBy: 0, start: 0, distance: 1e6, restart: 'page'};
    v.docGrid = {type: 'lines', linePitch: 1e9, charSpace: 2_000_000_000};
    v.pageNumStart = 4_000_000_000;
    v.footnotePr = {numStart: 4_000_000_000};
    v.endnotePr = {numStart: 0};
    v.pageBorders = {top: {style: 'single', width: 1e6, space: -5}, left: {style: 'single', width: 0, space: 1e6}};
  }));
  const x = await sect(q);
  assert.deepEqual([x.pageW, x.pageH], [100, 100]);
  assert.equal(x.marginTop, 0);
  assert.equal(x.header, 0);
  assert.equal(x.footer, x.pageH, 'a footer distance stays on the page');
  assert.equal(x.columns.count, 12);
  assert.equal(x.columns.space, 0);
  assert.deepEqual([x.lineNumbers.countBy, x.lineNumbers.start, x.lineNumbers.distance], [1, 1, 1584]);
  assert.deepEqual([x.docGrid.linePitch, x.docGrid.charSpace], [MAX_GRID_PITCH, MAX_CHAR_SPACE]);
  assert.equal(x.pageNumStart, 100_000);
  assert.equal(x.footnotePr.numStart, MAX_NOTE_START);
  assert.equal(x.endnotePr.numStart, 1);
  assert.deepEqual([x.pageBorders.top.width, x.pageBorders.top.space], [6, 0]);
  assert.deepEqual([x.pageBorders.left.width, x.pageBorders.left.space], [0.25, 31]);
  // Huge pages clamp; columns and widths agree; orientation follows the sides.
  const r = await doc();
  await r.exec('layout.pageSetup', withSection(v => {
    Object.assign(v, {pageW: 1e5, pageH: 792, landscape: false});
    v.columns.count = 3;
    v.columns.widths = Array.from({length: 40}, () => [1, 1e5]);
  }));
  const y = await sect(r);
  assert.equal(y.pageW, 1584);
  assert.ok(y.landscape, 'wider than tall is landscape');
  assert.equal(y.columns.widths.length, 12);
  assert.equal(y.columns.count, 12, 'the count follows the widths');
  assert.ok(y.columns.widths.every(([w, sp]) => w >= 18 && sp >= 0 && sp <= 300));
  // One width is no custom layout: equal columns.
  await r.exec('layout.pageSetup', withSection(v => { v.columns.widths = [[200, 0]]; }));
  assert.deepEqual((await sect(r)).columns.widths, []);
});

test('page_setup_section_applies_a_valid_one', async () => {
  const q = await doc();
  await q.exec('layout.pageSetup', withSection(v => { Object.assign(v, {pageW: 595, pageH: 842, marginLeft: 50}); v.columns.count = 2; }));
  const x = await sect(q);
  assert.deepEqual([x.pageW, x.pageH, x.marginLeft, x.columns.count], [595, 842, 50, 2]);
});

test('page_setup_section_allows_a_tiny_page_without_margins', async () => {
  const tiny = (m, g) => withSection(v => {
    Object.assign(v, {pageW: 7.2, pageH: 20, marginTop: m, marginBottom: m, marginLeft: m, marginRight: m, gutter: g});
  });
  const q = await doc();
  const before = await sect(q);
  await fails(q, 'layout.pageSetup', tiny(1, 0));
  await fails(q, 'layout.pageSetup', tiny(0, 1));
  assert.deepEqual(await sect(q), before);
  await q.exec('layout.pageSetup', tiny(0, 0));
  const x = await sect(q);
  assert.deepEqual([x.pageW, x.pageH], [7.2, 20]);
});

test('page_setup_presets_are_recognised', async () => {
  const q = await doc();
  const preset = async () => { const x = await sect(q); return marginsPresetOf(x, !!q.t.content.settings.mirrorMargins); };
  for (const [id] of MARGIN_PRESETS) {
    await q.exec('layout.margins', {preset: id});
    assert.equal(await preset(), id);
  }
  await q.exec('layout.margins', {left: 80});
  assert.equal(await preset(), null);
  for (const [p, id] of [[{count: 2}, 'two'], [{preset: 'left'}, 'left'], [{count: 3}, 'three'], [{preset: 'right'}, 'right'], [{count: 1}, 'one']]) {
    await q.exec('layout.columns', p);
    assert.equal(columnsPresetOf(await sect(q)), id, JSON.stringify(p));
  }
  await q.exec('layout.columns', {count: 4});
  assert.equal(columnsPresetOf(await sect(q)), null);
});

test('section_break_keeps_the_selected_text', async () => {
  const q = await quill('one\ntwo');
  q.sel(0, 0, 3);
  await q.exec('layout.break', {kind: 'continuous'});
  assert.equal(selectedText(q), 'one');
  assert.equal(new Document(q.t.content).sections().length, 2);
  assert.deepEqual(q.texts(), ['', 'one', 'two']);
  // A backward selection in the middle of a paragraph keeps its text and direction too.
  const r = await quill('alpha beta\ngamma');
  r.sel(0, 10, 6);
  await r.exec('layout.break', {kind: 'continuous'});
  assert.equal(selectedText(r), 'beta');
  const [an, fo] = selection(r);
  assert.ok(an[0] > fo[0] || (an[0] === fo[0] && an[1] > fo[1]), 'still backward');
  assert.deepEqual(r.texts(), ['alpha ', 'beta', 'gamma']);
  // The issue's document: "one", a continuous break, "two" — both on page 1 after a round trip.
  const w = await quill('one\ntwo');
  w.sel(0, 3);
  await w.exec('layout.break', {kind: 'continuous'});
  const back = await readDocx(await writeDocx(w.t.content));
  const bd = new Document(back);
  assert.equal(bd.sections().length, 2);
  assert.equal(back.lastSection.start, 'continuous');
  const l = layout(back, {view: 'print'});
  assert.equal(l.pages.length, 1);
  const lines = l.pages[0].items.filter(i => i.kind === 'lines' && i.story === 'body')
    .map(i => [bd.story('body').get(i.path[0])?.text ?? '', i.y]).filter(([t]) => t).sort((a, b) => a[1] - b[1]).map(([t]) => t);
  assert.deepEqual(lines, ['one', 'two']);
});

test('unequal_columns_with_a_line_between', async () => {
  const q = await doc();
  const tw = textWidth(await sect(q));
  await q.exec('layout.columns', {widths: [[150, 24], [tw - 174, 0]], separator: true});
  const c = (await sect(q)).columns;
  assert.deepEqual([c.count, c.separator, c.widths.length], [2, true, 2]);
  assert.deepEqual(c.widths[0], [150, 24]);
  await q.t.undo();
  assert.deepEqual((await sect(q)).columns, {count: 1, space: 36, separator: false, widths: []});
  for (const bad of [[[tw, 36], [100, 0]], [[5, 0], [100, 0]], Array.from({length: 13}, () => [40, 0]), 'x']) {
    await fails(q, 'layout.columns', {widths: bad});
  }
});

test('columns_apply_to_the_document_or_from_the_caret_on', async () => {
  const q = await doc();
  await q.exec('layout.break', {kind: 'nextPage'});
  await q.exec('layout.columns', {count: 3, apply: 'document'});
  assert.ok(new Document(q.t.content).sections().every(([, x]) => x.columns.count === 3));
  const r = await doc();
  await r.exec('caret.docEnd');
  await r.exec('layout.columns', {count: 2, apply: 'forward'});
  assert.deepEqual(new Document(r.t.content).sections().map(([, x]) => x.columns.count), [1, 2]);
  assert.equal(r.t.content.lastSection.start, 'continuous');
  await fails(r, 'layout.columns', {count: 2, apply: 'elsewhere'});
});

test('columns_apply_to_the_selected_text', async () => {
  const five = () => quill('p1\np2\nalpha beta gamma\np4\np5');
  // A whole paragraph (a triple-click takes its mark): each break gets a paragraph of its own.
  let q = await five();
  select(q, [2, 0], [3, 0]);
  const whole = selectedText(q);
  await q.exec('layout.columns', {count: 2});
  assert.deepEqual(sectionsOf(q), [[['p1', 'p2', ''], 1], [['alpha beta gamma', ''], 2], [['p4', 'p5'], 1]]);
  assert.ok(new Document(q.t.content).sections().slice(1).every(([, x]) => x.start === 'continuous'));
  assert.equal(selectedText(q), whole, 'the paragraph stays selected');
  // The same paragraph again: its section changes, no new breaks.
  select(q, [3, 0], [4, 0]);
  await q.exec('layout.columns', {count: 3});
  assert.deepEqual(sectionsOf(q).map(([, n]) => n), [1, 3, 1]);
  // Taking the section break along changes nothing more.
  select(q, [3, 0], [5, 0]);
  await q.exec('layout.columns', {count: 2});
  assert.deepEqual(sectionsOf(q).map(([, n]) => n), [1, 2, 1]);
  // One undo step takes the breaks and the columns away.
  q = await five();
  select(q, [2, 0], [3, 0]);
  await q.exec('layout.columns', {count: 2});
  await q.t.undo();
  assert.deepEqual(sectionsOf(q), [[['p1', 'p2', 'alpha beta gamma', 'p4', 'p5'], 1]]);
  // Words inside a paragraph: the breaks split it there.
  q = await five();
  select(q, [2, 10], [2, 6]);
  await q.exec('layout.columns', {count: 2});
  assert.deepEqual(sectionsOf(q), [[['p1', 'p2', 'alpha '], 1], [['beta'], 2], [[' gamma', 'p4', 'p5'], 1]]);
  assert.equal(selectedText(q), 'beta');
  const [an, fo] = selection(q);
  assert.ok(an[0] > fo[0] || (an[0] === fo[0] && an[1] > fo[1]), 'a backward selection stays backward');
  // At the document's start no break goes before it, at its end none after.
  q = await five();
  select(q, [0, 0], [1, 0]);
  await q.exec('layout.columns', {count: 2});
  assert.deepEqual(sectionsOf(q), [[['p1', ''], 2], [['p2', 'alpha beta gamma', 'p4', 'p5'], 1]]);
  q = await five();
  select(q, [4, 0], [4, 2]);
  await q.exec('layout.columns', {count: 2});
  assert.deepEqual(sectionsOf(q), [[['p1', 'p2', 'alpha beta gamma', 'p4', ''], 1], [['p5'], 2]]);
  // Select All: the whole document, no breaks.
  q = await five();
  select(q, [0, 0], [4, 2]);
  await q.exec('layout.columns', {count: 2});
  assert.deepEqual(sectionsOf(q), [[['p1', 'p2', 'alpha beta gamma', 'p4', 'p5'], 2]]);
  // Without a selection the caret's section changes; "selection" then needs one.
  q = await five();
  await q.exec('layout.columns', {count: 2});
  assert.equal(sectionsOf(q).length, 1);
  await fails(q, 'layout.columns', {count: 2, apply: 'selection'});
});

test('line_numbering_options', async () => {
  const q = await quill('One\nTwo');
  await q.exec('layout.lineNumbers', {value: 'restartSection', start: 5, countBy: 2, distance: 18});
  let l = q.t.content.lastSection.lineNumbers;
  assert.deepEqual([l.start, l.countBy, l.distance, l.restart], [5, 2, 18, 'section']);
  await q.exec('layout.lineNumbers', {countBy: 1e9, start: -3});
  l = q.t.content.lastSection.lineNumbers;
  assert.deepEqual([l.start, l.countBy, l.restart], [5, 100, 'section'], 'clamped, mode kept');
  await q.exec('layout.lineNumbers', {value: 'none'});
  assert.equal(q.t.content.lastSection.lineNumbers, null);
  await fails(q, 'layout.lineNumbers', {value: 'sometimes'});
});
