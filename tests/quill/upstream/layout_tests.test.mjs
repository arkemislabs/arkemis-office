// Ported from wordcraft crates/layout/src/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// Upstream measures with installed fonts; these ports use the deterministic metrics shaper, so
// assertions on font-specific widths are restated in its units (noted per test). Tests that only
// check a font's own metrics (label_spacing_tests, ligatures, kerning, symbol fonts) are not
// ported: the shaper interface hands those to the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFromText} from '../../../core/quill/model/content.mjs';
import {defaultSection} from '../../../core/quill/model/section.mjs';
import {addList} from '../../../core/quill/model/numbering.mjs';
import {layout, LayoutCache, createMetricsShaper} from '../../../core/quill/layout/index.mjs';

const shaper = createMetricsShaper();
const lay = (c, o = {}) => layout(c, {shaper, ...o});
const body = c => c.body.chunks[0];
const pos = (block, off) => ({story: 'body', path: [block], off});
const linesOf = l => l.pages.reduce((n, p) => n + p.items.filter(it => it.kind === 'lines').reduce((m, it) => m + it.l1 - it.l0, 0), 0);
const fmt = (c, i, f) => { const p = body(c)[i]; p.props = {...(p.props || {})}; f(p.props); };

test('empty_doc_has_one_page', () => {
  const c = contentFromText('');
  const l = lay(c);
  assert.equal(l.pages.length, 1);
  assert.equal(linesOf(l), 1);
  const k = l.caret(pos(0, 0));
  assert.equal(k.page, 0);
  assert.ok(Math.abs(k.x - 72) < 0.5);
  assert.ok(k.top >= 72 && k.height > 8);
});

test('page_break_char_starts_new_page', () => {
  assert.equal(lay(contentFromText('one\u000C')).pages.length, 2);
});

test('a_page_break_then_a_new_page_makes_one_page', () => {
  for (const sectionOnBreak of [false, true]) {
    const c = contentFromText('Before\n\u000C\nAfter');
    if (sectionOnBreak) body(c)[1].section = defaultSection(); else fmt(c, 2, p => { p.pageBreakBefore = true; });
    assert.equal(lay(c).pages.length, 2, `section break on the page break: ${sectionOnBreak}`);
  }
});

test('page_numbers_can_restart_at_zero', () => {
  const c = contentFromText('Cover\u000CContents');
  c.lastSection = {...c.lastSection, pageNumStart: 0};
  assert.deepEqual(lay(c).pages.map(p => p.number), [0, 1]);
});

test('tabs_land_on_default_stops', () => {
  const xb = lay(contentFromText('a\tb')).caret(pos(0, 2)).x;
  assert.ok(Math.abs(xb - (72 + 36)) < 0.5, String(xb));
});

test('tabs_left_of_the_margin_stay_on_a_default_stop', () => {
  const xOf = (text, indent, off) => {
    const c = contentFromText(text);
    fmt(c, 0, p => { p.indentLeft = indent; });
    return lay(c).caret(pos(0, off)).x - 72;
  };
  assert.ok(Math.abs(xOf('a\t\tX', -60, 3) - -36) < 0.5);
  assert.ok(Math.abs(xOf('\tX', -72, 1) - -72) < 0.5);
  assert.ok(Math.abs(xOf('\tX', -60, 1) - -36) < 0.5);
  assert.ok(Math.abs(xOf('\t \tX', -60, 3) - 0) < 0.5);
  assert.ok(Math.abs(xOf('a\t\tX', 0, 3) - 72) < 0.5);
});

test('right_tab_aligns_text_end', () => {
  const c = contentFromText('left\tright');
  fmt(c, 0, p => { p.tabs = [{pos: 400, align: 'right', leader: 'none'}]; });
  const end = lay(c).caret(pos(0, 10)).x;
  assert.ok(Math.abs(end - 472) < 1, String(end));
});

test('center_and_right_alignment', () => {
  const c = contentFromText('abc\nabc\nabc');
  fmt(c, 1, p => { p.align = 'center'; });
  fmt(c, 2, p => { p.align = 'right'; });
  const l = lay(c);
  assert.ok(Math.abs(l.caret(pos(0, 0)).x - 72) < 0.5);
  const x1 = l.caret(pos(1, 0)).x;
  assert.ok(x1 > 250 && x1 < 320, String(x1));
  assert.ok(Math.abs(l.caret(pos(2, 3)).x - 540) < 1);
});

test('break_only_list_has_no_label', () => {
  for (const kind of ['numbered', 'bullet']) {
    const c = contentFromText('First\n\u000C\nLast\n\nAfter');
    const {numbering, num} = addList(c.numbering, kind);
    c.numbering = numbering;
    for (let i = 0; i < 5; i++) fmt(c, i, p => { p.numbering = {num, level: 0}; });
    const labels = lay(c).pages.flatMap(p => p.items).filter(it => it.kind === 'lines').map(it => [it.path[0], it.para.label ? it.para.label.text : null]);
    const label = n => (kind === 'numbered' ? `${n}.` : '•');
    assert.deepEqual(labels, [[0, label(1)], [1, null], [2, label(3)], [3, label(4)], [4, label(5)]], kind);
  }
});

test('space_between_paragraphs_is_the_larger_of_after_and_before', () => {
  const gap = (after, before, contextual) => {
    const c = contentFromText('One\nTwo');
    [[after, 0], [0, before]].forEach(([a, b], i) => fmt(c, i, p => { p.spaceAfter = a; p.spaceBefore = b; p.contextualSpacing = contextual; }));
    const ys = lay(c).pages[0].items.filter(it => it.kind === 'lines').map(it => [it.y, it.para.height]);
    return ys[1][0] - (ys[0][0] + ys[0][1]);
  };
  assert.ok(Math.abs(gap(6, 6, false) - 6) < 0.01);
  assert.ok(Math.abs(gap(6, 12, false) - 12) < 0.01);
  assert.ok(Math.abs(gap(12, 6, false) - 12) < 0.01);
  assert.ok(Math.abs(gap(0, 6, false) - 6) < 0.01);
  assert.ok(Math.abs(gap(6, 12, true)) < 0.01);
});

test('sections_land_on_the_side_their_break_and_numbering_ask_for', () => {
  const pages = (start, restart, evenOdd) => {
    const c = contentFromText('One\nTwo');
    body(c)[0].section = defaultSection();
    c.lastSection = {...c.lastSection, start, pageNumStart: restart};
    c.settings = {...c.settings, evenOddHeaders: evenOdd};
    return lay(c).pages.map(p => [p.section, p.number]);
  };
  assert.deepEqual(pages('oddPage', null, false), [[0, 1], [0, 2], [1, 3]]);
  assert.deepEqual(pages('evenPage', null, false), [[0, 1], [1, 2]]);
  assert.deepEqual(pages('oddPage', 1, false), [[0, 1], [1, 1]]);
  assert.deepEqual(pages('oddPage', 2, false), [[0, 1], [1, 3]]);
  assert.deepEqual(pages('oddPage', 1, true), [[0, 1], [0, 2], [1, 1]]);
  assert.deepEqual(pages('nextPage', 1, true), [[0, 1], [0, 2], [1, 1]]);
  assert.deepEqual(pages('nextPage', 2, true), [[0, 1], [1, 2]]);
  assert.deepEqual(pages('nextPage', 1, false), [[0, 1], [1, 1]]);
  assert.deepEqual(pages('nextPage', null, true), [[0, 1], [1, 2]]);
});

test('a_hyphen_before_digits_is_a_break_opportunity_like_word', () => {
  const text = 'Deed 2016-2022';
  for (let m = 100; m <= 540; m++) {
    const c = contentFromText(text);
    c.lastSection = {...c.lastSection, marginRight: m};
    const l = lay(c);
    const ls = l.pages[0].items.filter(it => it.kind === 'lines').flatMap(it => it.para.lines.slice(it.l0, it.l1).map(x => text.slice(x.start, x.stop)));
    if (ls.length < 2) continue;
    assert.equal(ls[0], 'Deed 2016-');
    assert.equal(ls[1], '2022');
    return;
  }
  assert.fail('no width in the sweep wrapped the paragraph');
});

test('no_line_break_right_after_a_slash', () => {
  const text = 'word and/or https://example.org/keepers/log/winter '.repeat(40);
  const l = lay(contentFromText(text));
  let n = 0;
  for (const p of l.pages) for (const it of p.items) if (it.kind === 'lines') for (const ln of it.para.lines.slice(it.l0, it.l1)) {
    n++;
    assert.ok(!text.slice(0, ln.start).endsWith('/'), `line starts after a slash: ${text.slice(ln.start, ln.stop)}`);
  }
  assert.ok(n > 10, `${n} lines`);
});

test('a_non_breaking_hyphen_and_a_minus_sign_stay_unbreakable', () => {
  for (const token of ['2016‑2022', '2016−2022']) {
    const text = 'Deed ' + token;
    let wrapped = false;
    for (let m = 100; m <= 540 && !wrapped; m++) {
      const c = contentFromText(text);
      c.lastSection = {...c.lastSection, marginRight: m};
      const ls = lay(c).pages[0].items.filter(it => it.kind === 'lines').flatMap(it => it.para.lines.slice(it.l0, it.l1).map(x => text.slice(x.start, x.stop)));
      if (ls.length < 2) continue;
      // The first wrap breaks at the space; narrower widths fall into the break-anywhere fallback.
      assert.deepEqual(ls.slice(0, 2), ['Deed ', token]);
      wrapped = true;
    }
    assert.ok(wrapped);
  }
});

test('long_paragraph_wraps_and_paginates', () => {
  const l = lay(contentFromText('word '.repeat(5000)));
  assert.ok(l.pages.length > 3);
  for (const p of l.pages) for (const it of p.items) if (it.kind === 'lines') assert.ok(it.y >= 72 - 0.01 && it.y < 720);
});

test('hit_and_caret_agree', () => {
  const l = lay(contentFromText('Hello world, this is some text.\nSecond paragraph.'));
  for (let off = 0; off <= 31; off++) {
    const k = l.caret(pos(0, off));
    assert.ok(k, `caret at ${off}`);
    const h = l.hit(k.page, k.x + 0.2, k.top + k.height / 2, 'body');
    assert.deepEqual(h, pos(0, off), `offset ${off}`);
  }
});

test('selection_rects_cover_range', () => {
  const l = lay(contentFromText('Hello world\nSecond line'));
  const r = l.selectionRects(pos(0, 2), pos(1, 3));
  assert.equal(r.length, 2);
  assert.ok(r[0][1].w > 0 && r[1][1].w > 0);
});

test('web_view_is_one_page', () => {
  const l = lay(contentFromText('word '.repeat(3000)), {view: 'web', webWidth: 400});
  assert.equal(l.pages.length, 1);
  assert.equal(l.pages[0].w, 400);
});

test('cache_reuses_unchanged_paragraphs', () => {
  const c = contentFromText('a\nb\nc');
  const cache = new LayoutCache();
  lay(c, {cache});
  const misses = cache.misses;
  lay(c, {cache});
  assert.equal(cache.misses, misses);
  assert.ok(cache.hits >= 3);
});

test('headers_and_page_fields', () => {
  const c = contentFromText('one\u000Ctwo\u000Cthree');
  const field = {type: 'field', instr: 'PAGE', result: '', locked: false, dirty: false, code: false, form: ''};
  c.parts = {7: {kind: 'header', blocks: [{kind: 'para', id: 'h', text: 'Page ￼', runs: [{len: 6}], objects: [field]}]}};
  c.lastSection = {...c.lastSection, headers: {default: 7, first: null, even: null}};
  const l = lay(c);
  assert.equal(l.pages.length, 3);
  for (const [i, p] of l.pages.entries()) {
    const h = p.header.find(it => it.kind === 'lines');
    assert.ok(h, 'header on every page');
    assert.equal(h.para.clusters.at(-1).shown, String(i + 1));
    assert.ok(h.y < 72);
  }
});

test('tall_first_page_header_pushes_body_down', () => {
  const c = contentFromText('Body');
  c.parts = {3: {kind: 'header', blocks: Array.from({length: 6}, (_, i) => ({kind: 'para', id: 'h' + i, text: 'Header line', runs: [{len: 11}]}))}};
  c.lastSection = {...c.lastSection, headers: {default: 3, first: null, even: null}};
  const l = lay(c);
  const y = l.pages[0].items.find(it => it.kind === 'lines').y;
  assert.ok(y > 72, `body starts below the header: ${y}`);
});

test('footnotes_sit_at_page_bottom', () => {
  const c = contentFromText('Text');
  const p = body(c)[0];
  p.text = 'Text￼';
  p.runs = [{len: 5}];
  p.objects = [{type: 'noteRef', kind: 'footnote', id: 9, custom: ''}];
  c.parts = {9: {kind: 'footnote', blocks: [{kind: 'para', id: 'n', text: 'Note', runs: [{len: 4}]}]}};
  const l = lay(c);
  const note = l.pages[0].items.find(it => it.kind === 'lines' && it.story === 9);
  assert.ok(note && note.y > 600);
});

test('tables_lay_out_cells', () => {
  const c = contentFromText('');
  const cell = t => ({id: 'c' + t, props: {span: 1}, blocks: [{kind: 'para', id: 'p' + t, text: t, runs: [{len: t.length}]}]});
  c.body = {chunks: [[{kind: 'table', id: 't', props: {}, grid: [100, 100], rows: [{id: 'r0', props: {}, cells: [cell('a'), cell('b')]}, {id: 'r1', props: {}, cells: [cell('c'), cell('d')]}]},
    {kind: 'para', id: 'e', text: '', runs: []}]]};
  const l = lay(c);
  const cells = l.pages[0].items.filter(it => it.kind === 'cell');
  assert.equal(cells.length, 4);
  assert.ok(cells[1].rect.x > cells[0].rect.x);
  assert.ok(cells[2].rect.y > cells[0].rect.y);
});
