// Word boundaries in a paragraph, as PowerPoint's Ctrl+arrow, Ctrl+Backspace/Delete and
// double-click see them.
// Translated from deckcraft crates/model/src/words.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// A paragraph splits into tokens: a run of one class of grapheme clusters plus the spaces that
// follow it (word, punctuation, symbol, ideograph, tab, line break, space). Positions are UTF-16
// offsets in the paragraph text (deckcraft counts scalar values; see text.mjs); a token never
// splits a grapheme cluster, so the caret never lands inside an emoji sequence or between a letter
// and its combining marks. Grapheme clusters come from Intl.Segmenter (unicode-segmentation in
// deckcraft).

const SPACE_RE = /^[    -   　]$/u;
/** A space for word movement: absorbed into the token before it. */
export const isSpace = c => SPACE_RE.test(c);
const cp = c => c.codePointAt(0) ?? 0;
const inRanges = (c, ranges) => { const v = cp(c); return ranges.some(([a, b]) => v >= a && v <= b); };
const IDEO = [[0x1100, 0x11ff], [0x2e80, 0x2fdf], [0x3005, 0x3007], [0x3021, 0x3029], [0x3031, 0x3035], [0x3038, 0x303c], [0x3040, 0x309f], [0x30a0, 0x30ff],
  [0x3100, 0x318f], [0x31a0, 0x31ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xf900, 0xfaff], [0xff66, 0xffdc], [0x20000, 0x3134f]];
const SYMBOL = [[0xa9, 0xa9], [0xae, 0xae], [0x2122, 0x2122], [0x2190, 0x21ff], [0x2300, 0x23ff], [0x25a0, 0x27bf], [0x2b00, 0x2bff], [0x1f000, 0x1faff]];
const MARKS = [[0x300, 0x36f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20ff], [0xfe20, 0xfe2f]];
const isAlnum = c => /^[\p{L}\p{N}]$/u.test(c) || /^\p{Alphabetic}$/u.test(c);
const isNumeric = c => /^\p{N}$/u.test(c);

function baseClass(c) {
  if (c === '\u000b' || c === '\n' || c === '\r' || c === ' ' || c === ' ') return 'break';
  if (c === '\t') return 'tab';
  if (isSpace(c)) return 'space';
  if (inRanges(c, IDEO)) return 'ideo';
  if (isAlnum(c)) return 'word';
  if (inRanges(c, SYMBOL)) return 'symbol';
  if (inRanges(c, MARKS)) return 'word';
  return 'punct';
}

let segmenter = null;
function graphemes(text) {
  segmenter ??= typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', {granularity: 'grapheme'}) : null;
  if (segmenter) return [...segmenter.segment(text)].map(s => [s.index, s.segment]);
  const out = [];
  let i = 0;
  for (const ch of text) { out.push([i, ch]); i += ch.length; }
  return out;
}
const firstChar = s => String.fromCodePoint(s.codePointAt(0) ?? 32);

function clusters(text) {
  const out = [];
  const firsts = [];
  for (const [start, g] of graphemes(text)) {
    const first = firstChar(g);
    out.push({start, cls: baseClass(first)});
    firsts.push(first);
  }
  const classes = out.map(c => c.cls);
  out.forEach((cl, i) => {
    const c = firsts[i], prev = firsts[i - 1], next = firsts[i + 1];
    let joins = false;
    if (c === "'" || c === '’') joins = !!next && isAlnum(next);
    else if (c === '-') joins = !!prev && isAlnum(prev);
    else if (c === '.' || c === ',' || c === ':') joins = !!prev && isNumeric(prev) && !!next && isNumeric(next);
    if (joins && classes[i] === 'punct') cl.cls = 'word';
  });
  return out;
}

/** Does a token start at cluster `cur` (after `prev`)? */
function startsToken(prev, cur) {
  if (cur === 'space') return prev === 'tab' || prev === 'break';
  return prev === 'space' || prev !== cur || cur === 'ideo' || cur === 'tab' || cur === 'break';
}

/** The word stops of a paragraph's text in ascending order (Ctrl+Right goes to the next one). */
export function stops(text) {
  const cs = clusters(text);
  const out = [0];
  for (let i = 1; i < cs.length; i++) if (startsToken(cs[i - 1].cls, cs[i].cls)) out.push(cs[i].start);
  const n = text.length;
  if (out[out.length - 1] !== n) out.push(n);
  return out;
}

/** The stops Ctrl+Left uses (non-ASCII spaces are stops; symbol + punctuation is one token). */
export function backStops(text) {
  const cs = clusters(text);
  const out = [0];
  for (let i = 1; i < cs.length; i++) {
    const a = cs[i - 1].cls, b = cs[i].cls;
    const symbolPunct = (a === 'symbol' && b === 'punct') || (a === 'punct' && b === 'symbol');
    if (startsToken(a, b) && !symbolPunct) out.push(cs[i].start);
  }
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c !== ' ' && isSpace(c) && text[i + 1] !== ' ') out.push(i);
  }
  const sorted = [...new Set(out)].sort((x, y) => x - y);
  if (sorted[sorted.length - 1] !== text.length) sorted.push(text.length);
  return sorted;
}

/** The next stop after `ch` (Ctrl+Right), or null at the end of the text. */
export const nextStop = (text, ch) => stops(text).find(s => s > ch) ?? null;
/** The previous stop before `ch` (Ctrl+Left), or null at the start. */
export const prevStop = (text, ch) => [...backStops(text)].reverse().find(s => s < ch) ?? null;

const spaceAt = (text, i) => i >= 0 && i < text.length && isSpace(text[i]);

/** The end of the token's text (before its trailing spaces) for the token containing `ch`. */
function contentEnd(text, ch) {
  const next = nextStop(text, ch) ?? text.length;
  let e = ch;
  while (e < next && !spaceAt(text, e)) e++;
  return e === ch && spaceAt(text, ch) ? next : e;
}

/** The word a double-click at `ch` selects: [start, end]. */
export function wordAt(text, chIn) {
  const n = text.length;
  if (n === 0) return [0, 0];
  const ch = Math.min(chIn, n);
  const onSpace = ch >= n || spaceAt(text, ch);
  const afterToken = ch > 0 && !spaceAt(text, ch - 1);
  const at = onSpace && afterToken ? ch - 1 : Math.min(ch, n - 1);
  if (spaceAt(text, at)) {
    let s = at;
    while (s > 0 && spaceAt(text, s - 1)) s--;
    let e = at;
    while (e < n && spaceAt(text, e)) e++;
    return [s, e];
  }
  const s = [...stops(text)].reverse().find(x => x <= at) ?? 0;
  return [s, Math.min(Math.max(contentEnd(text, s), at + 1), n)];
}

/** What Ctrl+Delete removes from `ch` (before smart spacing); null at the end of the text. */
export function deleteForwardEnd(text, ch) {
  const n = text.length;
  if (ch >= n) return null;
  const st = stops(text);
  if (!st.includes(ch) && !spaceAt(text, ch)) return contentEnd(text, ch);
  const prevIsText = ch > 0 && !isSpace(text[ch - 1]) && !['tab', 'break'].includes(baseClass(text[ch - 1]));
  if (spaceAt(text, ch) && prevIsText) {
    let j = ch;
    while (j < n && spaceAt(text, j)) j++;
    if (j >= n) return n;
    return contentEnd(text, j);
  }
  return st.find(s => s > ch) ?? null;
}

/** Closing punctuation that a smart delete pulls its word's spaces up to. */
export const isClosingPunct = c => '.,;:!?)]}%…”’»'.includes(c) && c.length === 1;
/** Punctuation that a smart delete keeps a space after when a word follows. */
export const isSentencePunct = c => '.,;:!?…'.includes(c) && c.length === 1;
export {isAlnum, isNumeric};
