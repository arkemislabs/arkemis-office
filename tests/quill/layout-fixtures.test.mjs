// (Helpers only: no tests run from this file; named *.test.mjs to stay inside the layout unit's test paths.)
// Fixtures for the Quill layout tests: documents with exact line heights so pagination arithmetic
// is exact with the deterministic metrics shaper (12 pt text: 0.5 em per letter, 0.25 em spaces).
import {createContent} from '../../core/quill/model/content.mjs';
import {paragraphWithText} from '../../core/quill/model/para.mjs';
import {defaultSection} from '../../core/quill/model/section.mjs';
import {layout, LayoutCache, createMetricsShaper} from '../../core/quill/layout/index.mjs';

export const shaper = createMetricsShaper();
/** 20 pt exact lines, no paragraph spacing: a Letter page with 1" margins holds 32 lines (648 pt). */
export const EXACT = Object.freeze({spaceBefore: 0, spaceAfter: 0, lineSpacing: {rule: 'exactly', value: 20}});

/** A paragraph of text with EXACT spacing plus `props`. */
export function para(text, props = {}, chr = {}) {
  const p = paragraphWithText(text.replace(/￼/g, 'X'), chr);
  // paragraphWithText drops U+FFFC; objects are put back at their places.
  p.text = text;
  p.props = {...EXACT, ...props};
  return p;
}
/** N one-line paragraphs ("x"). */
export const shortParas = (n, props = {}) => Array.from({length: n}, () => para('x', props));
/** A paragraph N lines long at width 468 (each line ~39 letters of 6 pt): words of 7 letters. */
export function lines(n, props = {}) {
  // 468 pt / 6 pt per letter: a line holds 9 words "abcdefg " (7*6 + 3 = 45 pt each -> 10 words = 450 pt).
  const words = [];
  for (let i = 0; i < n * 10; i++) words.push('abcdefg');
  return para(words.join(' '), props);
}
export function content(blocks, f = null) {
  const c = createContent(blocks);
  if (f) f(c);
  return c;
}
export const lay = (c, opts = {}) => layout(c, {shaper, ...opts});
export {layout, LayoutCache, defaultSection};

/** The body `lines` items on page `pi`: [{path, l0, l1, y}]. */
export function bodyLines(l, pi) {
  return l.pages[pi].items.filter(it => it.kind === 'lines' && it.story === 'body').map(it => ({path: it.path, l0: it.l0, l1: it.l1, y: it.y, x: it.x, para: it.para}));
}
/** Which top-level blocks are on each page. */
export function blocksPerPage(l) {
  return l.pages.map(p => [...new Set(p.items.filter(it => it.kind === 'lines' && it.story === 'body').map(it => it.path[0]))]);
}
