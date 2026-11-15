// Text clusters, script classes and word counting for Quill's document model.
// Translated from wordcraft crates/doc/src/cluster.rs, crates/doc/src/bidi.rs and
// crates/doc/src/text_walk.rs (`count_words`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Offsets are UTF-16 code units (docs/architecture.md section 5.3) where upstream uses UTF-8
// bytes; "a character boundary" is an offset that doesn't split a surrogate pair. Extended
// grapheme clusters (UAX #29) come from Intl.Segmenter, as unicode-segmentation gives them
// upstream. No DOM, no Node built-ins.

export const OBJ = '￼';

const graphemes = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('und', {granularity: 'grapheme'}) : null;

const isHigh = c => c >= 0xd800 && c <= 0xdbff;
const isLow = c => c >= 0xdc00 && c <= 0xdfff;

/** Whether `off` is a character boundary of `text` (0..=length, not inside a surrogate pair). */
export function isCharBoundary(text, off) {
  if (!Number.isInteger(off) || off < 0 || off > text.length) return false;
  if (off === 0 || off === text.length) return true;
  return !(isHigh(text.charCodeAt(off - 1)) && isLow(text.charCodeAt(off)));
}

/** `off` clamped to `text` and moved back to a character boundary. */
export function charFloor(text, off) {
  let o = Math.max(0, Math.min(Number.isFinite(off) ? Math.floor(off) : 0, text.length));
  while (o > 0 && !isCharBoundary(text, o)) o--;
  return o;
}

/** The code point ending at `off` (or null). */
export function charBefore(text, off) {
  if (off <= 0) return null;
  const lo = text.charCodeAt(off - 1);
  if (isLow(lo) && off >= 2 && isHigh(text.charCodeAt(off - 2))) return text.codePointAt(off - 2);
  return lo;
}
/** The code point starting at `off` (or null). */
export function charAt(text, off) {
  return off < text.length ? text.codePointAt(off) : null;
}
/** UTF-16 length of the code point `cp`. */
export const cpLen = cp => (cp > 0xffff ? 2 : 1);

// --- cluster.rs -----------------------------------------------------------------------------

/** Invisible stackers: the next consonant is drawn under this one. */
const isStacker = c => c === 0x1039 || c === 0x17d2 || c === 0x1a60;

/** Dependent signs of Myanmar, Khmer and Tai Tham: never the start of a cluster. */
function isDependent(c) {
  return (c >= 0x102b && c <= 0x103e) || (c >= 0x1056 && c <= 0x1059) || (c >= 0x105e && c <= 0x1060)
    || (c >= 0x1062 && c <= 0x1064) || (c >= 0x1067 && c <= 0x106d) || (c >= 0x1071 && c <= 0x1074)
    || (c >= 0x1082 && c <= 0x108d) || c === 0x108f || (c >= 0x109a && c <= 0x109d) || c === 0xa9e5
    || (c >= 0xaa7b && c <= 0xaa7d) || (c >= 0x17b4 && c <= 0x17d1) || c === 0x17d3 || c === 0x17dd
    || (c >= 0x1a55 && c <= 0x1a5e) || (c >= 0x1a61 && c <= 0x1a7c) || c === 0x1a7f;
}

/** No caret stop between `prev` and `next` (code points) although a grapheme boundary falls there. */
export const joinsCluster = (prev, next) => isStacker(prev) || isDependent(next);

const isAscii = text => !/[^\x00-\x7f]/.test(text);

function graphemeStarts(text) {
  if (!graphemes) {
    const out = [];
    for (let i = 0; i < text.length; i += cpLen(text.codePointAt(i))) out.push(i);
    return out;
  }
  const out = [];
  for (const seg of graphemes.segment(text)) out.push(seg.index);
  return out;
}

/** Offsets where clusters start (graphemes, joined per `joinsCluster`); the first is 0. */
export function clusterStarts(text) {
  if (isAscii(text)) {
    const out = [];
    for (let i = 0; i < text.length; i++) if (!(i > 0 && text.charCodeAt(i - 1) === 13 && text.charCodeAt(i) === 10)) out.push(i);
    return out;
  }
  const out = [];
  const starts = graphemeStarts(text);
  let prev = null;
  for (let k = 0; k < starts.length; k++) {
    const i = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : text.length;
    const first = text.codePointAt(i);
    if (!(prev !== null && joinsCluster(prev, first))) out.push(i);
    prev = charBefore(text, end);
  }
  return out;
}

/** Whether `off` is a cluster boundary of `text` (0 and the length always are). */
export function isClusterBoundary(text, off) {
  if (off <= 0 || off >= text.length) return true;
  if (!isCharBoundary(text, off)) return false;
  return clusterStarts(text).includes(off);
}

/** The previous cluster boundary before `off` (0 at the start). */
export function prevCluster(text, off) {
  const o = charFloor(text, off);
  const starts = clusterStarts(text);
  let best = 0;
  for (const s of starts) { if (s < o) best = s; else break; }
  return best;
}

/** The next cluster boundary after `off` (the length at the end). */
export function nextCluster(text, off) {
  const o = charFloor(text, off);
  for (const s of clusterStarts(text)) if (s > o) return s;
  return text.length;
}

/** Scripts whose Backspace removes one character at a time (the Brahmic scripts). */
export function backspacesByChar(c) {
  return (c >= 0x0900 && c <= 0x0dff) || (c >= 0x0e00 && c <= 0x0eff) || (c >= 0x0f00 && c <= 0x0fff)
    || (c >= 0x1000 && c <= 0x109f) || (c >= 0x1780 && c <= 0x17ff) || (c >= 0x1a20 && c <= 0x1aaf)
    || (c >= 0x1b00 && c <= 0x1b7f) || (c >= 0xa980 && c <= 0xa9ff) || (c >= 0xaa60 && c <= 0xaa7f);
}

function myanmarSyllableStart(c) {
  return (c >= 0x1000 && c <= 0x102a) || c === 0x103f || (c >= 0x1050 && c <= 0x1055) || (c >= 0x105a && c <= 0x105d)
    || c === 0x1061 || (c >= 0x1065 && c <= 0x1066) || (c >= 0x106e && c <= 0x1070) || (c >= 0x1075 && c <= 0x1081) || c === 0x108e;
}

/** Line-break opportunities inside Myanmar text: before each syllable (UTF-16 offsets, sorted). */
export function myanmarBreaks(text) {
  const chars = [];
  for (let i = 0; i < text.length;) { const c = text.codePointAt(i); chars.push([i, c]); i += cpLen(c); }
  const myanmar = c => (c >= 0x1000 && c <= 0x109f) || (c >= 0xa9e0 && c <= 0xa9ff) || (c >= 0xaa60 && c <= 0xaa7f);
  const out = [];
  for (let k = 1; k < chars.length; k++) {
    const [i, c] = chars[k];
    const prev = chars[k - 1][1];
    if (!myanmar(prev) || !myanmarSyllableStart(c) || isStacker(prev)) continue;
    let j = k + 1;
    if (j < chars.length && (chars[j][1] === 0x103b || chars[j][1] === 0x103e)) j++;
    if (j < chars.length && (chars[j][1] === 0x1037 || chars[j][1] === 0x1039 || chars[j][1] === 0x103a)) continue;
    out.push(i);
  }
  return out;
}

// --- bidi.rs --------------------------------------------------------------------------------

/** A character of a right-to-left script (Hebrew, Arabic, Syriac, Thaana, N'Ko, ...). */
export function isRtlScript(c) {
  return (c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)
    || (c >= 0x10800 && c <= 0x10fff) || (c >= 0x1e800 && c <= 0x1efff);
}

/** A character Word formats with the complex-script properties. */
export const isComplexScript = c => isRtlScript(c) || (c >= 0x0900 && c <= 0x0eff);

const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const ALPHA = /\p{Alphabetic}/u;
const WHITE = /\p{White_Space}/u;
const fromCp = c => String.fromCodePoint(c);
/** Rust `char::is_alphanumeric` (Alphabetic or Numeric). */
export const isAlphanumeric = c => ALNUM.test(fromCp(c));
/** Rust `char::is_whitespace` (White_Space). */
export const isWhitespace = c => WHITE.test(fromCp(c));

/** A character that belongs to a word for word selection and Ctrl+arrow movement. */
export function isWordChar(c) {
  return isAlphanumeric(c) || c === 0x5f || c === 0x27 || c === 0x200c || c === 0x200d || c === 0x0640
    || (c >= 0x0610 && c <= 0x061a) || (c >= 0x064b && c <= 0x065f) || c === 0x0670 || (c >= 0x06d6 && c <= 0x06dc)
    || (c >= 0x06df && c <= 0x06e8) || (c >= 0x06ea && c <= 0x06ed) || (c >= 0x08d3 && c <= 0x08ff) || (c >= 0x0300 && c <= 0x036f);
}

/** Does `text` contain a right-to-left character? */
export function hasRtl(text) {
  for (const ch of text) if (isRtlScript(ch.codePointAt(0))) return true;
  return false;
}

/** Does the first strong directional character in `text` belong to a right-to-left script? */
export function firstStrongIsRtl(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0x200f) return true;
    if (c === 0x200e) return false;
    if (ALPHA.test(ch)) return isRtlScript(c);
  }
  return false;
}

// --- text_walk.rs ---------------------------------------------------------------------------

/** Words in `s`: whitespace- (or object-) separated tokens with at least one alphanumeric char. */
export function countWords(s) {
  let n = 0, word = false;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xfffc || WHITE.test(ch)) { if (word) n++; word = false; continue; }
    if (!word && ALNUM.test(ch)) word = true;
  }
  if (word) n++;
  return n;
}
