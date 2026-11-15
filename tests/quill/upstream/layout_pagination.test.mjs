// Ported from wordcraft crates/layout/src/tests.rs (pagination tests) at
// aadb077e072b7de05f724e359d8db82e151f125c, with the deterministic metrics shaper.
import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFromText, createContent} from '../../../core/quill/model/content.mjs';
import {paragraphWithText} from '../../../core/quill/model/para.mjs';
import {defaultSection} from '../../../core/quill/model/section.mjs';
import {layout, createMetricsShaper} from '../../../core/quill/layout/index.mjs';
import {itemBottom} from '../../../core/quill/layout/placed.mjs';

const shaper = createMetricsShaper();
const lay = c => layout(c, {shaper});
const pos = (block, off) => ({story: 'body', path: [block], off});
const mk = (text, props) => { const p = paragraphWithText(text); p.props = props; return p; };
const withBody = (c, blocks) => { c.body = {chunks: [blocks]}; return c; };

test('keep_with_next_moves_a_paragraph_only_when_it_would_fit', () => {
  const plain = {spaceBefore: 0, spaceAfter: 0, lineSpacing: {rule: 'multiple', value: 1}};
  const pages = (fillers, kept, next) => {
    const blocks = [];
    for (let i = 0; i < fillers; i++) blocks.push(mk(`F${i}`, plain));
    blocks.push(mk('Ka\nKb\nKc\nKd\nKe', {...plain, ...kept}));
    blocks.push(mk('NX', {...plain, ...next}));
    blocks.push(mk('NY', plain));
    const l = lay(withBody(createContent(), blocks));
    const k = fillers;
    return [0, 3, 6, 9, 12].map(off => l.caret(pos(k, off)).page).concat([l.caret(pos(k + 1, 0)).page]);
  };
  const none = {}, kn = {keepNext: true}, kl = {keepNext: true, keepLines: true};
  let fit = null;
  for (let n = 20; n < 80 && fit === null; n++) if (pages(n, none, none).join() === '0,0,0,0,0,1') fit = n;
  assert.ok(fit !== null, 'a filler count that fills the page');
  assert.deepEqual(pages(fit, kn, none), [1, 1, 1, 1, 1, 1], 'fits by itself: moves with the next');
  const split = pages(fit + 1, none, none);
  assert.ok(split[0] === 0 && split[4] === 1, `one more line splits it: ${split}`);
  assert.deepEqual(pages(fit + 1, kn, none), split, "doesn't fit anyway: breaks as usual");
  assert.deepEqual(pages(fit + 1, kl, none), [1, 1, 1, 1, 1, 1], 'with keep lines together it moves whole');
  assert.deepEqual(pages(fit - 1, kn, kn), [1, 1, 1, 1, 1, 1], 'a kept chain moves together');
});

function paraBoxes(l) {
  const out = [];
  l.pages.forEach((p, pi) => p.items.forEach(it => {
    if (it.kind === 'lines' && it.story === 'body') out.push([pi, it.path[0], it.y, itemBottom(it.y, it.para, it.l0, it.l1)]);
  }));
  return out;
}

test('section_vertical_alignment_top_center_justify_bottom', () => {
  const laid = (texts, va) => {
    const c = withBody(createContent(), texts.map(t => mk(t, {spaceBefore: 0, spaceAfter: 0})));
    c.lastSection = {...c.lastSection, valign: va};
    return lay(c);
  };
  const three = ['One', 'Two', 'Three'];
  const top = laid(three, 'top');
  const body = top.pages[0].body;
  const bodyTop = body.y, bodyBottom = body.y + body.h;
  const t = paraBoxes(top);
  const h = t[2][3] - t[0][2];
  assert.ok(Math.abs(t[0][2] - bodyTop) < 0.5);
  const c = paraBoxes(laid(three, 'center'));
  const room = bodyBottom - bodyTop - h;
  assert.ok(Math.abs(c[0][2] - (bodyTop + room / 2)) < 0.5, 'center');
  assert.ok(Math.abs(c[1][2] - c[0][3]) < 0.05 && Math.abs(c[2][2] - c[1][3]) < 0.05, 'center keeps the blocks together');
  const b = paraBoxes(laid(three, 'bottom'));
  assert.ok(Math.abs(b[2][3] - bodyBottom) < 0.5, 'bottom');
  const j = paraBoxes(laid(three, 'justify'));
  assert.ok(Math.abs(j[0][2] - bodyTop) < 0.5);
  assert.ok(Math.abs(j[2][3] - bodyBottom) < 0.5);
  const g1 = j[1][2] - j[0][3], g2 = j[2][2] - j[1][3];
  assert.ok(g1 > 100 && Math.abs(g1 - g2) < 0.05, `equal gaps ${g1} ${g2}`);
  const one = paraBoxes(laid(['Only'], 'justify'));
  assert.ok(Math.abs(one[0][2] - bodyTop) < 0.5);
  const p = paraBoxes(laid(['One', 'Two', 'Three', '\u000C', 'Four'], 'justify'));
  assert.deepEqual(p.map(e => e[0]), [0, 0, 0, 0, 1]);
  assert.ok(Math.abs(p[0][2] - bodyTop) < 0.5);
  assert.ok(Math.abs(p[3][3] - bodyBottom) < 0.5, "the break's paragraph sits on the bottom margin");
  const gaps = [1, 2, 3].map(i => p[i][2] - p[i - 1][3]);
  assert.ok(gaps.every(g => Math.abs(g - gaps[0]) < 0.05 && g > 50), String(gaps));
  assert.ok(Math.abs(p[4][2] - bodyTop) < 0.5);
});

test('mirror_indents_swap_sides_on_even_pages', () => {
  const c = contentFromText('odd page\neven page');
  c.body.chunks[0][0].props = {indentLeft: 72, mirrorIndents: true};
  c.body.chunks[0][1].props = {indentLeft: 72, mirrorIndents: true, pageBreakBefore: true};
  const l = lay(c);
  assert.equal(l.pages.length, 2);
  const odd = l.caret(pos(0, 0)), even = l.caret(pos(1, 0));
  assert.equal(even.page, 1);
  assert.ok(Math.abs(odd.x - 144) < 0.5);
  assert.ok(Math.abs(even.x - 72) < 0.5);
});

test('long_footnotes_continue_on_the_next_page', () => {
  const c = contentFromText('Body text line.\n'.repeat(16));
  const ref = (block, id) => { const p = c.body.chunks[0][block]; p.text = p.text.slice(0, 4) + '￼' + p.text.slice(4); p.runs = [{len: p.text.length}]; p.objects = [{type: 'noteRef', kind: 'footnote', id, custom: ''}]; };
  ref(4, 50);
  ref(14, 51);
  c.parts = {50: {kind: 'footnote', blocks: [paragraphWithText('A long footnote that runs on and on. '.repeat(100))]},
    51: {kind: 'footnote', blocks: [paragraphWithText("The second page's own note.")]}};
  const l = lay(c);
  assert.equal(l.caret(pos(4, 4)).page, 0, 'the reference stays where it was');
  const pieces = [];
  l.pages.forEach((p, pi) => p.items.forEach(it => { if (it.kind === 'lines' && it.story === 50) pieces.push([pi, it.l0, it.l1, it.y]); }));
  assert.ok(pieces.length >= 2);
  assert.deepEqual([pieces[0][0], pieces[1][0]], [0, 1]);
  assert.equal(pieces[0][1], 0);
  assert.equal(pieces[0][2], pieces[1][1], 'continues at the next line');
  const n = l.pages[0].items.find(it => it.kind === 'lines' && it.story === 50).para.lines.length;
  assert.equal(pieces.reduce((s, p) => s + p[2] - p[1], 0), n, 'every line of the note is placed once');
  const bodyBottom = pi => Math.max(...l.pages[pi].items.filter(it => it.kind === 'lines' && it.story === 'body').map(it => itemBottom(it.y, it.para, it.l0, it.l1)));
  const rulesBelow = (pi, y) => l.pages[pi].items.filter(it => it.kind === 'rule' && it.y0 === it.y1 && it.y0 > y).map(it => it.x1 - it.x0);
  assert.ok(bodyBottom(0) <= pieces[0][3]);
  assert.deepEqual(rulesBelow(0, bodyBottom(0)), [144], 'a normal separator on page 1');
  assert.deepEqual(rulesBelow(1, bodyBottom(1)), [468], 'continuation separator');
  const own = l.pages[1].items.find(it => it.kind === 'lines' && it.story === 51);
  assert.ok(own && own.y > pieces[1][3], 'own note after the continued one');
});

function twoColumnSection(start) {
  const text = Array.from({length: 10}, (_, i) => 'Short paragraph ' + i).concat(['After the break']);
  const c = contentFromText(text.join('\n'));
  c.body.chunks[0][9].section = {...defaultSection(), columns: {count: 2, space: 36, separator: false, widths: []}};
  c.lastSection = {...c.lastSection, start};
  return c;
}
function columnBottoms(l) {
  const b = paraBoxes(l).map(([pi, , y, bottom], i) => [pi, xs[i], y, bottom]);
  const x0 = b[0][1];
  const first = b.slice(0, 10);
  const left = first.filter(e => Math.abs(e[1] - x0) < 1), right = first.filter(e => Math.abs(e[1] - x0) >= 1);
  const bottom = v => v.reduce((m, e) => Math.max(m, e[3]), 0);
  return [left.length, bottom(left), right.length, bottom(right), [b[10][0], b[10][2]]];
}
let xs = [];
const layCols = c => { const l = lay(c); xs = []; l.pages.forEach(p => p.items.forEach(it => { if (it.kind === 'lines' && it.story === 'body') xs.push(it.x); })); return l; };

test('columns_before_a_page_break_or_a_column_break_are_not_balanced', () => {
  let [nl, , nr, , [page]] = columnBottoms(layCols(twoColumnSection('nextPage')));
  assert.deepEqual([nl, nr, page], [10, 0, 1]);
  const c = twoColumnSection('continuous');
  const p = c.body.chunks[0][1];
  p.text += '\u000E';
  p.runs = [{len: p.text.length}];
  const [nl2, bl, nr2, br, [page2, after]] = columnBottoms(layCols(c));
  assert.deepEqual([nl2, nr2, page2], [2, 8, 0]);
  assert.ok(br > bl + 50 && after >= br - 0.5, `columns end at ${bl} and ${br}, next section at ${after}`);
});

test('columns_before_a_continuous_break_are_balanced', () => {
  const [nl, bl, nr, br, [page, after]] = columnBottoms(layCols(twoColumnSection('continuous')));
  assert.deepEqual([nl, nr, page], [5, 5, 0]);
  assert.ok(Math.abs(bl - br) < 0.5 && after >= br - 0.5);
});
