// Quill layout engine (core/quill/layout), translated from wordcraft crates/layout (ArtCraft
// aadb077e072b7de05f724e359d8db82e151f125c).
//
// Fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: pass.rs/flow.rs/page.rs paginate sections into pages and columns with Word's
//    keep-with-next, keep-lines-together and widow/orphan rules; table_flow.rs splits rows and
//    repeats header rows; notes.rs puts footnotes on the referencing page; headers.rs picks
//    first/even/default headers; fields.rs fills PAGE/NUMPAGES; hit.rs maps points to positions.
//    Word does the same (Print Layout).
// 2. Ours runs the translated algorithms over the model's content; text is measured through the
//    shaper interface (a deterministic stub here, Canvas2D in the page view).
// 3. These tests (and tests/quill/upstream/layout_*.test.mjs, the ported upstream tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import {para, lines, shortParas, content, lay, bodyLines, blocksPerPage, LayoutCache, shaper, layout} from './layout-fixtures.test.mjs';
import {paragraphWithText} from '../../core/quill/model/para.mjs';
import {defaultSection} from '../../core/quill/model/section.mjs';
import {pageDisplay} from '../../core/quill/layout/index.mjs';

test('a paragraph of 40 lines runs onto a second page at 32 lines', () => {
  const l = lay(content([lines(40)]));
  assert.equal(l.pages.length, 2);
  const [a] = bodyLines(l, 0), [b] = bodyLines(l, 1);
  assert.deepEqual([a.l0, a.l1, b.l0, b.l1], [0, 32, 32, 40]);
  assert.equal(a.y, 72);
  assert.equal(b.y, 72);
});

test('widow control takes a line along so the last line is not alone', () => {
  // 33 lines: 32 fit, 1 would be a widow: the page breaks after 31.
  const l = lay(content([lines(33)]));
  const [a] = bodyLines(l, 0), [b] = bodyLines(l, 1);
  assert.equal(a.l1, 31);
  assert.equal(b.l0, 31);
  const off = lay(content([lines(33, {widowControl: false})]));
  assert.equal(bodyLines(off, 0)[0].l1, 32);
});

test('orphan control moves a paragraph whose first line alone would fit', () => {
  const l = lay(content([lines(31), lines(5)]));
  assert.deepEqual(blocksPerPage(l), [[0], [1]]);
});

test('keep lines together moves the paragraph whole', () => {
  const l = lay(content([lines(30), lines(5, {keepLines: true})]));
  assert.deepEqual(blocksPerPage(l), [[0], [1]]);
  assert.equal(bodyLines(l, 1)[0].l0, 0);
});

test('keep with next carries a heading over with the paragraph after it', () => {
  // 31 lines, then a one-line heading kept with a paragraph of 3 lines (two must start the page).
  const l = lay(content([lines(31), para('Heading', {keepNext: true}), lines(3)]));
  assert.deepEqual(blocksPerPage(l), [[0], [1, 2]]);
  // Without keep with next the heading stays on page one.
  const l2 = lay(content([lines(31), para('Heading'), lines(3)]));
  assert.deepEqual(blocksPerPage(l2)[0], [0, 1]);
});

test('page break character and page break before start new pages', () => {
  const c = content([para('one\u000Ctwo'), para('three', {pageBreakBefore: true})]);
  const l = lay(c);
  assert.equal(l.pages.length, 3);
  assert.deepEqual(blocksPerPage(l), [[0], [0], [1]]);
});

test('a section break starts a new page with its own size; continuous sections share the page', () => {
  const p0 = para('first section');
  p0.section = {...defaultSection(), pageW: 842, pageH: 595, landscape: true};
  const p1 = para('second section');
  const c = content([p0, p1]);
  const l = lay(c);
  assert.equal(l.pages.length, 2);
  assert.deepEqual([l.pages[0].w, l.pages[0].h, l.pages[1].w], [842, 595, 612]);
  const q0 = para('a');
  q0.section = defaultSection();
  const q1 = para('b');
  const c2 = content([q0, q1], x => { x.lastSection = {...x.lastSection, start: 'continuous'}; });
  assert.equal(lay(c2).pages.length, 1);
});

test('odd page sections insert a blank page to land on an odd page', () => {
  const p0 = para('first');
  p0.section = defaultSection();
  const c = content([p0, para('second')], x => { x.lastSection = {...x.lastSection, start: 'oddPage'}; });
  const l = lay(c);
  assert.deepEqual(l.pages.map(p => p.number), [1, 2, 3]);
  assert.deepEqual(blocksPerPage(l), [[0], [], [1]]);
});

test('page numbering restarts where a section says', () => {
  const p0 = para('first');
  p0.section = defaultSection();
  const c = content([p0, para('second')], x => { x.lastSection = {...x.lastSection, pageNumStart: 7}; });
  assert.deepEqual(lay(c).pages.map(p => p.number), [1, 7]);
});

test('two columns fill left then right, and a column break moves on', () => {
  const c = content(shortParas(40), x => { x.lastSection = {...x.lastSection, columns: {count: 2, space: 36, separator: true, widths: []}}; });
  const l = lay(c);
  assert.equal(l.pages.length, 1);
  const ps = bodyLines(l, 0);
  assert.equal(ps.length, 40);
  assert.deepEqual([ps[31].x, ps[32].x, ps[32].y], [72, 72 + 216 + 36, 72], 'the 33rd paragraph tops the right column');
  assert.ok(l.pages[0].items.some(it => it.kind === 'rule' && it.x0 === it.x1), 'a line between the columns');
  const cb = content([para('left\u000Eright')], x => { x.lastSection = {...x.lastSection, columns: {count: 2, space: 36, separator: false, widths: []}}; });
  const lb = bodyLines(lay(cb), 0);
  assert.equal(lb.length, 2);
  assert.ok(lb[1].x > lb[0].x);
});

test('columns before a continuous section break are balanced', () => {
  const ps0 = shortParas(20);
  ps0[19].section = {...defaultSection(), columns: {count: 2, space: 36, separator: false, widths: []}};
  const c = content([...ps0, para('after')], x => { x.lastSection = {...x.lastSection, start: 'continuous'}; });
  const l = lay(c);
  const ps = bodyLines(l, 0);
  const left = ps.filter(p => p.path[0] < 20 && p.x === 72).length;
  assert.deepEqual([left, 20 - left], [10, 10]);
  assert.equal(ps.find(p => p.path[0] === 20).y, 72 + 10 * 20, 'the next section starts below the balanced columns');
});

test('headers and footers: first page, even pages, default; PAGE and NUMPAGES fields', () => {
  const field = instr => ({type: 'field', instr, result: '', locked: false, dirty: false, code: false, form: ''});
  const hp = (text, objs = []) => { const p = para(text); p.objects = objs; return p; };
  const c = content([lines(70)], x => {
    x.parts = {
      1: {kind: 'header', blocks: [hp('Default header')]},
      2: {kind: 'header', blocks: [hp('First header')]},
      3: {kind: 'header', blocks: [hp('Even header')]},
      4: {kind: 'footer', blocks: [hp('Page ￼ of ￼', [field('PAGE'), field('NUMPAGES')])]},
    };
    x.settings = {...x.settings, evenOddHeaders: true};
    x.lastSection = {...x.lastSection, titlePage: true, headers: {default: 1, first: 2, even: 3}, footers: {default: 4, first: 4, even: 4}};
  });
  const l = lay(c);
  assert.equal(l.pages.length, 3);
  assert.deepEqual(l.pages.map(p => p.headerStory), [2, 3, 1]);
  assert.deepEqual(l.pages.map(p => p.hfSlot), ['first', 'even', 'default']);
  const footerText = p => pageDisplay(p).filter(d => d.type === 'text' && d.y > 740).map(d => d.text).join('');
  assert.equal(footerText(l.pages[1]), 'Page 2 of 3');
});

test('a PAGE field in the body shows the page it lands on, after a split', () => {
  const words = [];
  for (let i = 0; i < 350; i++) words.push('abcdefg');
  const p = para(words.join(' ') + ' ￼');
  p.objects = [{type: 'field', instr: 'PAGE', result: '', locked: false, dirty: false, code: false, form: ''}];
  const l = lay(content([p]));
  assert.equal(l.pages.length, 2);
  const text = pageDisplay(l.pages[1]).filter(d => d.type === 'text').map(d => d.text).join('');
  assert.match(text, /abcdefg 2$/);
});

test('NUMPAGES in the body is laid out again with the real total', () => {
  const p = para('of ￼');
  p.objects = [{type: 'field', instr: 'NUMPAGES', result: '', locked: false, dirty: false, code: false, form: ''}];
  const l = lay(content([p, para('x', {pageBreakBefore: true}), para('y', {pageBreakBefore: true})]));
  assert.equal(l.pages.length, 3);
  const text = pageDisplay(l.pages[0]).filter(d => d.type === 'text').map(d => d.text).join('');
  assert.equal(text, 'of 3');
});

test('footnotes sit at the bottom of the page that references them, numbered in order', () => {
  const ref = id => ({type: 'noteRef', kind: 'footnote', id, custom: ''});
  const p1 = para('One￼');
  p1.objects = [ref(10)];
  const p2 = para('Two￼', {pageBreakBefore: true});
  p2.objects = [ref(11)];
  const c = content([p1, p2], x => {
    x.parts = {10: {kind: 'footnote', blocks: [para('First note')]}, 11: {kind: 'footnote', blocks: [para('Second note')]}};
  });
  const l = lay(c);
  assert.equal(l.pages.length, 2);
  for (const [pi, id] of [[0, 10], [1, 11]]) {
    const note = l.pages[pi].items.find(it => it.kind === 'lines' && it.story === id);
    assert.ok(note, `note ${id} on page ${pi + 1}`);
    assert.ok(note.y > 600, 'at the page bottom');
    assert.ok(l.pages[pi].items.some(it => it.kind === 'rule' && it.y0 < note.y && it.x1 - it.x0 === 144), 'the separator above it');
  }
  const marks = pageDisplay(l.pages[1]).filter(d => d.type === 'text').map(d => d.text);
  assert.deepEqual(marks.slice(0, 2), ['Two', '2'], 'the reference shows its number, raised in its own run');
});

test('table rows split across pages and header rows repeat', () => {
  const cell = (t, n = 1) => ({id: 'c' + Math.random(), props: {span: 1}, blocks: n > 1 ? [lines(n)] : [para(t)]});
  const rows = [{id: 'h', props: {header: true}, cells: [cell('Head A'), cell('Head B')]}];
  for (let i = 0; i < 40; i++) rows.push({id: 'r' + i, props: {}, cells: [cell('a' + i), cell('b' + i)]});
  const t = {kind: 'table', id: 't', props: {}, grid: [234, 234], rows};
  const l = lay(content([t, para('after')]));
  assert.equal(l.pages.length, 2);
  const cells = pi => l.pages[pi].items.filter(it => it.kind === 'cell' && it.story === 'body');
  assert.equal(cells(1)[0].row, 0, 'the header row is repeated at the top of page 2');
  assert.equal(cells(1)[0].rect.y, 72);
  // A tall row splits at the page bottom.
  const tall = {kind: 'table', id: 't2', props: {}, grid: [468], rows: [{id: 'r', props: {}, cells: [{id: 'c', props: {span: 1}, blocks: [lines(50)]}]}]};
  const l2 = lay(content([tall]));
  assert.equal(l2.pages.length, 2);
  const pieces = [0, 1].map(pi => bodyLines(l2, pi).find(x => x.path.length === 4));
  assert.deepEqual([pieces[0].l0, pieces[0].l1, pieces[1].l0], [0, pieces[0].l1, pieces[0].l1]);
  // A row that can't split moves on whole.
  const cant = {kind: 'table', id: 't3', props: {}, grid: [468], rows: [{id: 'r', props: {cantSplit: true}, cells: [{id: 'c', props: {span: 1}, blocks: [lines(10)]}]}]};
  const l3 = lay(content([lines(28), cant]));
  assert.deepEqual(blocksPerPage(l3).map(b => b.length), [1, 1]);
});

test('vertically merged cells span their rows; cell margins place the text', () => {
  const c = (t, props = {}) => ({id: 'c' + t, props: {span: 1, ...props}, blocks: [para(t)]});
  const t = {kind: 'table', id: 't', props: {}, grid: [200, 200], rows: [
    {id: 'r0', props: {}, cells: [c('merged', {vmerge: 'restart'}), c('b0')]},
    {id: 'r1', props: {}, cells: [c('', {vmerge: 'continue'}), c('b1')]},
  ]};
  const l = lay(content([t]));
  const cells = l.pages[0].items.filter(it => it.kind === 'cell');
  const merged = cells.find(x => x.row === 0 && x.cell === 0);
  assert.equal(merged.rect.h, 40);
  assert.ok(cells.find(x => x.row === 1 && x.cell === 0).covered);
  const text = bodyLines(l, 0).find(x => x.path.join('.') === '0.0.0.0');
  assert.equal(text.x, 72 + 5.4, 'the left cell margin');
});

test('square-wrapped floating picture: text flows beside it', () => {
  const p = para('￼' + Array(60).fill('abcdefg').join(' '));
  p.objects = [{type: 'image', media: 'm', w: 200, h: 100, crop: [0, 0, 0, 0], float: {wrap: 'square', hRel: 'column', vRel: 'paragraph', x: 0, y: 0, dist: 9, distTop: 0, distBottom: 0, effect: [0, 0, 0, 0], wrapText: 'bothSides'}}];
  const l = lay(content([p]));
  const pl = bodyLines(l, 0)[0].para;
  assert.ok(pl.lines[0].left >= 209 - 0.01, 'the first lines start right of the picture');
  assert.ok(pl.lines[pl.lines.length - 1].left < 1, 'lines below it are full width');
  assert.ok(l.pages[0].items.some(it => it.kind === 'image' && it.rect.w === 200));
});

test('list labels are drawn and counted', () => {
  const c = content([], x => {
    x.numbering = {abstracts: [{id: 0, name: null, levels: [{start: 1, format: 'decimal', text: '%1.', align: 'left', indent: 36, hanging: 18, suffix: 'tab', chr: {}, restart: true, legal: false, style: null}]}],
      nums: [{id: 1, abstractId: 0, startOverrides: []}]};
    const mk = t => { const p = para(t); p.props.numbering = {num: 1, level: 0}; return p; };
    x.body = {chunks: [[mk('one'), mk('two'), mk('three')]]};
  });
  const l = lay(c);
  const labels = bodyLines(l, 0).map(x => x.para.label.text);
  assert.deepEqual(labels, ['1.', '2.', '3.']);
  assert.equal(bodyLines(l, 0)[0].para.lines[0].xs[0], 36, 'text at the indent, after the label tab');
});

test('alignment: centred, right and justified lines', () => {
  const l = lay(content([para('abc', {align: 'center'}), para('abc', {align: 'right'}), para(Array(30).fill('abcdefg').join(' '), {align: 'justify'})]));
  const ps = bodyLines(l, 0);
  assert.equal(ps[0].para.lines[0].xs[0], (468 - 18) / 2);
  assert.equal(ps[1].para.lines[0].xs[0], 468 - 18);
  const j = ps[2].para.lines[0];
  assert.ok(Math.abs(j.xs[j.xs.length - 1] - 468) < 3.1, 'a justified line reaches the margin (its trailing space hangs)');
});

test('hit testing: caret, point to position, vertical moves, selection rectangles', () => {
  const l = lay(content([para('Hello world'), lines(3)]));
  const pos = {story: 'body', path: [0], off: 6};
  const c = l.caret(pos);
  assert.deepEqual([c.page, c.x], [0, 72 + 6 * 5 + 3]);
  assert.deepEqual(l.hit(0, c.x + 1, c.top + 3), pos);
  const [down] = l.vertical(pos, null, 1);
  assert.deepEqual(down.path, [1]);
  const [up] = l.vertical(down, c.x, -1);
  assert.deepEqual(up, pos);
  const rects = l.selectionRects({story: 'body', path: [0], off: 0}, {story: 'body', path: [1], off: 5});
  assert.equal(rects.length, 2);
  assert.equal(rects[0][1].w, 63 + 5, 'the first paragraph and its mark');
  assert.deepEqual(l.lineBounds({story: 'body', path: [1], off: 12}).map(p => p.off), [0, 79]);
});

test('the display list draws text, rules and fills in page coordinates', () => {
  const p = para('Shaded', {borders: {top: {style: 'single', width: 1, color: null, space: 1}}, shading: [0xee, 0xee, 0xee]});
  const d = pageDisplay(lay(content([p])).pages[0]);
  assert.ok(d.some(x => x.type === 'fill' && x.color[0] === 0xee));
  assert.ok(d.some(x => x.type === 'line' && x.width === 1));
  const t = d.find(x => x.type === 'text');
  assert.equal(t.text, 'Shaded');
  assert.equal(t.font.size, 12);
});

test('incremental relayout: only the edited paragraph is laid out again', () => {
  const blocks = [];
  for (let i = 0; i < 50; i++) blocks.push(lines(2));
  const c = content(blocks);
  const cache = new LayoutCache();
  layout(c, {shaper, cache});
  const misses = cache.misses;
  // An edit replaces one block (structural sharing keeps the others).
  const chunk = c.body.chunks[0].slice();
  chunk[20] = para(chunk[20].text + 'x');
  const c2 = {...c, body: {chunks: [chunk]}};
  layout(c2, {shaper, cache});
  assert.equal(cache.misses - misses, 1);
});

test('benchmark: a one-character edit in a 300-page document relays out fast', () => {
  const blocks = [];
  // 300 pages: 32 lines a page, paragraphs of 4 lines -> 8 a page.
  for (let i = 0; i < 2400; i++) blocks.push(lines(4));
  const c = content(blocks);
  const cache = new LayoutCache();
  const t0 = performance.now();
  const first = layout(c, {shaper, cache});
  const cold = performance.now() - t0;
  assert.equal(first.pages.length, 300);
  const chunk = c.body.chunks.flat();
  chunk[1200] = para(chunk[1200].text.replace('abcdefg', 'abcdefgh'));
  const c2 = {...c, body: {chunks: [chunk]}};
  const t1 = performance.now();
  const second = layout(c2, {shaper, cache});
  const warm = performance.now() - t1;
  assert.equal(second.pages.length, 300);
  console.log(`# 300 pages: cold ${cold.toFixed(0)} ms, after a one-character edit ${warm.toFixed(0)} ms`);
  assert.ok(warm < cold, 'the relayout reuses the cache');
  assert.ok(warm < 400, `relayout took ${warm} ms`);
});

test('web view lays the body out as one long page as wide as the window', () => {
  const l = lay(content([lines(80)]), {view: 'web', webWidth: 500});
  assert.equal(l.pages.length, 1);
  assert.equal(l.pages[0].w, 500);
  assert.equal(bodyLines(l, 0)[0].x, 18);
});

test('hidden text takes no room unless hidden text is shown', () => {
  const p = paragraphWithText('visible');
  p.props = {spaceBefore: 0, spaceAfter: 0, lineSpacing: {rule: 'exactly', value: 20}};
  p.text = 'visible hidden';
  p.runs = [{len: 8}, {len: 6, props: {hidden: true}}];
  const w = l => { const ln = bodyLines(l, 0)[0].para.lines[0]; return ln.xs[ln.xs.length - 1]; };
  assert.equal(w(lay(content([p]))), 45);
  assert.equal(w(lay(content([p]), {showHidden: true})), 81);
});

test('page addresses: /page:<n> resolves to the body range on that page', async () => {
  const {pageRange, installPageResolver} = await import('../../core/quill/layout/index.mjs');
  const c = content([lines(40), para('tail')]);
  const l = lay(c);
  const r = pageRange(l, 2);
  assert.deepEqual([r.number, r.from.path, r.to.path], [2, [0], [1]]);
  assert.equal(pageRange(l, 3), null);
  let resolver = null;
  installPageResolver(fn => { resolver = fn; }, () => l);
  const got = resolver(c, 1, '/page:1');
  assert.deepEqual([got.kind, got.path, got.from, got.node.number], ['page', [0], 0, 1]);
  assert.throws(() => resolver(c, 9, '/page:9'), e => e.code === 'not_found');
});

test('the Canvas2D shaper measures through measureText and caches', async () => {
  const {createCanvasShaper, cssFont} = await import('../../core/quill/layout/shaper-canvas.mjs');
  const calls = [];
  const ctx = {font: '', measureText(t) { calls.push([this.font, t]); return {width: t.length * 7, fontBoundingBoxAscent: 9, fontBoundingBoxDescent: 3}; }};
  const s = createCanvasShaper(ctx);
  const f = {family: 'Aptos', size: 12, bold: true, italic: false};
  assert.equal(cssFont(f), 'bold 12px "Aptos", sans-serif');
  assert.deepEqual(s.metrics(f), {ascent: 9, descent: 3});
  assert.equal(s.advance('ab', f), 14);
  assert.equal(s.advance('ab', f), 14);
  assert.equal(calls.filter(c => c[1] === 'ab').length, 1, 'cached');
  const l = layout(content([para('Hello world')]), {shaper: s});
  assert.equal(bodyLines(l, 0)[0].para.lines[0].height, 20);
});
