// Paragraphs: text with formatting runs and inline objects, plus the inline object kinds.
// Translated from wordcraft crates/doc/src/para.rs, para/run.rs, para/inline_object.rs,
// para/inline_kinds.rs and para/float.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A paragraph is `{kind: 'para', id, text, runs: [{len, props?}], props?, mark?, objects?,
// section?}`. The text is one string; run lengths sum to its length; inline objects sit in the
// text as U+FFFC and the k-th U+FFFC is `objects[k]`. Special characters: `\t` tab, `\n` manual
// line break, U+000C page break, U+000E column break. Lengths and offsets are UTF-16 code units
// (upstream: UTF-8 bytes); an offset inside a surrogate pair is refused as upstream refuses one
// inside a character.
//
// The mutating functions (insertText, delete, format, splitOff, append, normalize, ...) change the
// paragraph object passed in, as upstream's `&mut self` methods do: callers pass a paragraph they
// own (core/quill/model/document.mjs copies before it writes). They assign fresh `runs`/`objects`
// arrays and never mutate a run, props or object in place, so earlier versions stay intact.
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {same, charUnlinked, charIsEmpty, paraIsEmpty, shownFont} from './props.mjs';
import {OBJ, isCharBoundary, charFloor, charBefore, charAt, cpLen, prevCluster, nextCluster, backspacesByChar, isWordChar} from './text.mjs';
import {newId} from './ids.mjs';

export {OBJ};
/** Manual line break (Shift+Enter). */
export const LINE_BREAK = '\n';
/** Page break (Ctrl+Enter). */
export const PAGE_BREAK = '\u000C';
/** Column break (Ctrl+Shift+Enter). */
export const COLUMN_BREAK = '\u000E';
/** Optional hyphen (Ctrl+-). */
export const SOFT_HYPHEN = '­';
/** Nonbreaking hyphen (Ctrl+Shift+-). */
export const NB_HYPHEN = '‑';
/** Nonbreaking space (Ctrl+Shift+Space). */
export const NBSP = ' ';

const EMPTY = Object.freeze({});
const propsOf = r => r.props ?? EMPTY;

export const badOffset = off => new CommandError('invalid_address', `offset ${off} is not a character boundary in the paragraph`);

/** A new empty paragraph. */
export function newParagraph(id = newId()) {
  return {kind: 'para', id, text: '', runs: []};
}

/** A paragraph of plain text in one run (U+FFFC is dropped). */
export function paragraphWithText(text, props = {}, id = newId()) {
  const clean = String(text).split(OBJ).join('');
  const p = newParagraph(id);
  if (clean.length) p.runs = [run(clean.length, props)];
  p.text = clean;
  if (!charIsEmpty(props)) p.mark = {...props};
  return p;
}

const run = (len, props) => (props && !charIsEmpty(props) ? {len, props} : {len});

/** Set the paragraph style (Paragraph::styled); mutates and returns `p`. */
export function styled(p, style) {
  p.props = {...(p.props || {}), style};
  return p;
}

export const paraLen = p => p.text.length;
export const paraIsEmptyText = p => p.text.length === 0;
export const objectsOf = p => p.objects ?? [];

function setObjects(p, objs) { if (objs.length) p.objects = objs; else delete p.objects; }
function setMark(p, mark) { if (mark && !charIsEmpty(mark)) p.mark = mark; else delete p.mark; }
export const markOf = p => p.mark ?? EMPTY;
export const paraPropsOf = p => p.props ?? EMPTY;

/** The text with objects replaced by their text (fields → result). */
export function plainText(p) {
  if (!p.objects?.length) return p.text;
  let out = '', k = 0;
  for (const c of p.text) {
    if (c === OBJ) { out += objectPlainText(p.objects[k]); k++; } else out += c;
  }
  return out;
}

/** plainText without tracked deletions: the text as it reads with every change accepted. */
export const finalText = p => textWithout(p, deletedRanges(p));

/** The ranges of the tracked deletions. */
export function deletedRanges(p) {
  return runRanges(p).filter(([, , c]) => c.del !== undefined && c.del !== null).map(([a, b]) => [a, b]);
}

/** plainText without the text in the ranges `dropped` (any order, overlapping or not). */
export function textWithout(p, dropped) {
  const sorted = dropped.slice().sort((x, y) => x[0] - y[0]);
  let r = 0, out = '', k = 0;
  for (let i = 0; i < p.text.length;) {
    const cp = p.text.codePointAt(i);
    const w = cpLen(cp);
    while (r < sorted.length && sorted[r][1] <= i) r++;
    const keep = r >= sorted.length || sorted[r][0] > i;
    if (cp === 0xfffc) {
      if (keep && p.objects?.[k]) out += objectPlainText(p.objects[k]);
      k++;
    } else if (keep) out += p.text.slice(i, i + w);
    i += w;
  }
  return out;
}

function check(p, off) {
  if (!isCharBoundary(p.text, off)) throw badOffset(off);
}

/** Clamp `off` to the text and back to a character boundary. */
export const clampOff = (p, off) => charFloor(p.text, off);

/** Index of the run containing `off` and where it starts; at a boundary the earlier run wins. */
function runAt(p, off) {
  let start = 0;
  for (let i = 0; i < p.runs.length; i++) {
    const end = start + p.runs[i].len;
    if (off < end || (off === end && off > start)) return [i, start];
    start = end;
  }
  return null;
}

/** Formatting in effect at `off` (what typing there would get). */
export function propsAt(p, off) {
  if (off === 0) return p.runs.length ? propsOf(p.runs[0]) : markOf(p);
  const r = runAt(p, off);
  return r ? propsOf(p.runs[r[0]]) : markOf(p);
}

/** Formatting of the character starting at `off`. */
export function propsOfChar(p, off) {
  let start = 0;
  for (const r of p.runs) {
    if (off < start + r.len) return propsOf(r);
    start += r.len;
  }
  return markOf(p);
}

/** Runs as [start, end, props]. */
export function runRanges(p) {
  const out = [];
  let s = 0;
  for (const r of p.runs) { out.push([s, s + r.len, propsOf(r)]); s += r.len; }
  return out;
}

/** Number of objects in text[0..off). */
export function objectsBefore(p, off) {
  if (!p.objects?.length) return 0;
  let n = 0;
  const end = Math.min(off, p.text.length);
  for (let i = p.text.indexOf(OBJ); i >= 0 && i < end; i = p.text.indexOf(OBJ, i + 1)) n++;
  return n;
}

/** The object at `off` (which must hold U+FFFC). */
export function objectAt(p, off) {
  if (p.text[off] !== OBJ) return null;
  return p.objects?.[objectsBefore(p, off)] ?? null;
}

/** Offsets of all objects, in order. */
export function objectOffsets(p) {
  const out = [];
  for (let i = p.text.indexOf(OBJ); i >= 0; i = p.text.indexOf(OBJ, i + 1)) out.push(i);
  return out;
}

/** [offset, object] for every object, in text order, in one pass. */
export function objectsWithOffsets(p) {
  if (!p.objects?.length) return [];
  const offs = objectOffsets(p);
  const out = [];
  for (let k = 0; k < offs.length && k < p.objects.length; k++) out.push([offs[k], p.objects[k]]);
  return out;
}

/** Replace the object at `off` with `obj` (object_at_mut + assignment). Returns false when there is none. */
export function setObjectAt(p, off, obj) {
  if (p.text[off] !== OBJ) return false;
  const k = objectsBefore(p, off);
  if (!p.objects || k >= p.objects.length) return false;
  const objs = p.objects.slice();
  objs[k] = obj;
  p.objects = objs;
  return true;
}

/** Insert plain text (U+FFFC dropped) at `off` with `props`. Returns the inserted length. */
export function insertText(p, off, s, props = {}) {
  check(p, off);
  const clean = String(s).includes(OBJ) ? String(s).split(OBJ).join('') : String(s);
  if (!clean.length) return 0;
  p.text = p.text.slice(0, off) + clean + p.text.slice(off);
  insertRun(p, off, clean.length, props);
  return clean.length;
}

/** Insert an object at `off`. */
export function insertObject(p, off, obj, props = {}) {
  check(p, off);
  const k = objectsBefore(p, off);
  p.text = p.text.slice(0, off) + OBJ + p.text.slice(off);
  const objs = objectsOf(p).slice();
  objs.splice(Math.min(k, objs.length), 0, obj);
  setObjects(p, objs);
  insertRun(p, off, 1, props);
}

function insertRun(p, off, len, props) {
  const runs = p.runs.slice();
  let start = 0;
  let idx = runs.length;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (off <= start) { idx = i; break; }
    if (off < start + r.len) {
      const left = off - start, right = r.len - left;
      runs[i] = {...r, len: left};
      runs.splice(i + 1, 0, {...r, len: right});
      idx = i + 1;
      break;
    }
    start += r.len;
  }
  runs.splice(Math.min(idx, runs.length), 0, run(len, props));
  p.runs = runs;
  normalize(p);
}

/** Merge adjacent equal runs and drop empty ones; repair runs that don't cover the text exactly. */
export function normalize(p) {
  const n = p.text.length;
  let end = 0;
  const out = [];
  for (const r of p.runs) {
    let e = Math.min(end + Math.max(0, Number.isFinite(r.len) ? r.len : 0), n);
    while (!isCharBoundary(p.text, e)) e++;
    if (e === end) continue;
    const last = out[out.length - 1];
    if (last && same(propsOf(last), propsOf(r))) out[out.length - 1] = {...last, len: last.len + (e - end)};
    else out.push(run(e - end, r.props));
    end = e;
  }
  if (end < n) {
    const last = out[out.length - 1];
    if (last) out[out.length - 1] = {...last, len: last.len + (n - end)};
    else out.push(run(n, p.mark));
  }
  p.runs = out;
}

/** Delete [a, b). Objects inside are removed. */
export function deleteRange(p, a, b) {
  [a, b] = [Math.min(a, b), Math.max(a, b)];
  check(p, a); check(p, b);
  if (a === b) return;
  if ((!p.runs.length || a === 0) && b === p.text.length) {
    // Formatting only: the mark keeps its own revision state, whatever the deleted text was part of.
    const m = markOf(p);
    const mark = {...propsOfChar(p, a)};
    for (const k of ['ins', 'del', 'fmtChange']) { if (m[k] !== undefined) mark[k] = m[k]; else delete mark[k]; }
    setMark(p, mark);
  }
  const k0 = objectsBefore(p, a), k1 = objectsBefore(p, b);
  if (k1 > k0 && p.objects && k1 <= p.objects.length) {
    const objs = p.objects.slice();
    objs.splice(k0, k1 - k0);
    setObjects(p, objs);
  }
  p.text = p.text.slice(0, a) + p.text.slice(b);
  let start = 0;
  p.runs = p.runs.map(r => {
    const rs = start, re = start + r.len;
    start = re;
    const ov = Math.max(0, Math.min(re, b) - Math.max(rs, a));
    return ov ? {...r, len: r.len - Math.min(ov, r.len)} : r;
  });
  normalize(p);
}

/** Delete [a, b) except the one-character objects at the offsets in `keep`. */
export function deleteExcept(p, a, b, keep) {
  [a, b] = [Math.min(a, b), Math.max(a, b)];
  let k = (keep || []).filter(o => o >= a && o + 1 <= b && p.text[o] === OBJ);
  if (!k.length) { deleteRange(p, a, b); return; }
  k = [...new Set(k)].sort((x, y) => x - y);
  const pieces = [];
  let from = a;
  for (const o of k) { pieces.push([from, o]); from = o + 1; }
  pieces.push([from, b]);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const [x, y] = pieces[i];
    if (y > x) deleteRange(p, x, y);
  }
}

/**
 * Apply `f` to the formatting of [a, b). `f` gets a copy of each run's props; it may change the
 * copy or return a new props object.
 */
export function formatRange(p, a, b, f) {
  [a, b] = [Math.min(a, b), Math.max(a, b)];
  check(p, a); check(p, b);
  if (a === b) return;
  const out = [];
  let start = 0;
  for (const r of p.runs) {
    const rs = start, re = start + r.len;
    start = re;
    const cut = [rs, Math.max(rs, Math.min(re, a)), Math.max(rs, Math.min(re, b)), re];
    for (let w = 0; w < 3; w++) {
      const x = cut[w], y = cut[w + 1];
      if (y <= x) continue;
      let props = r.props;
      if (x >= a && y <= b) props = applyProps(propsOf(r), f);
      out.push(run(y - x, props));
    }
  }
  p.runs = out;
  normalize(p);
}

/** Apply a props function (mutating a copy, or returning a new object). */
export function applyProps(props, f) {
  const copy = {...(props || {})};
  const r = f(copy);
  const next = r === undefined ? copy : r;
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
  return next;
}

/**
 * Split at `off`: `p` keeps [0, off), the returned paragraph (id `tailId`) gets the rest with the
 * same paragraph properties; the section break, if any, moves to the second half.
 */
export function splitOff(p, off, tailId = newId()) {
  check(p, off);
  const k = objectsBefore(p, off);
  const tailText = p.text.slice(off);
  const objs = objectsOf(p);
  const tailObjs = k <= objs.length ? objs.slice(k) : [];
  const keepObjs = objs.slice(0, Math.min(k, objs.length));
  const tailRuns = [], keep = [];
  let start = 0;
  for (const r of p.runs) {
    const rs = start, re = start + r.len;
    start = re;
    if (re <= off) keep.push(r);
    else if (rs >= off) tailRuns.push(r);
    else { keep.push({...r, len: off - rs}); tailRuns.push({...r, len: re - off}); }
  }
  p.text = p.text.slice(0, off);
  p.runs = keep;
  setObjects(p, keepObjs);
  const carry = charUnlinked(propsAt(p, off));
  const tail = {kind: 'para', id: tailId, text: tailText, runs: tailRuns};
  if (p.props && !paraIsEmpty(p.props)) tail.props = {...p.props};
  setMark(tail, p.text.length === 0 && off === 0 ? markOf(p) : carry);
  setObjects(tail, tailObjs);
  if (p.section) { tail.section = p.section; delete p.section; }
  if (tail.text.length === 0) setMark(tail, charUnlinked(propsAt(p, off)));
  normalize(p);
  normalize(tail);
  return tail;
}

/** Append `other`'s content (its paragraph properties are dropped; its section break kept). */
export function append(p, other) {
  p.text += other.text;
  p.runs = [...p.runs, ...other.runs];
  setObjects(p, [...objectsOf(p), ...objectsOf(other)]);
  if (other.section) p.section = other.section;
  normalize(p);
}

/** Previous caret stop before `off` (a cluster boundary). */
export const prevBoundary = (p, off) => prevCluster(p.text, clampOff(p, off));
/** Next caret stop after `off`. */
export const nextBoundary = (p, off) => nextCluster(p.text, clampOff(p, off));

/** Where Backspace at `off` deletes from (one character at a time in the Brahmic scripts). */
export function backspaceFrom(p, off) {
  off = clampOff(p, off);
  const c = charBefore(p.text, off);
  if (c !== null && backspacesByChar(c)) return off - cpLen(c);
  return prevBoundary(p, off);
}

function charsOf(text, from, to) {
  const out = [];
  for (let i = from; i < to;) { const c = text.codePointAt(i); out.push([i, c]); i += cpLen(c); }
  return out;
}

/** Start of the word at or before `off` (Ctrl+Left). */
export function wordStart(p, off) {
  off = clampOff(p, off);
  let idx = off, seenWord = false;
  const cs = charsOf(p.text, 0, off);
  for (let j = cs.length - 1; j >= 0; j--) {
    const [i, c] = cs[j];
    if (isWordChar(c)) { seenWord = true; idx = i; } else if (seenWord) break; else idx = i;
  }
  return idx;
}

/** End of the word after `off`, including trailing spaces (Ctrl+Right, like Word). */
export function wordEnd(p, off) {
  off = clampOff(p, off);
  const after = charsOf(p.text, off, p.text.length);
  let end = p.text.length;
  const first = after[0]?.[1];
  const firstWord = first !== undefined && isWordChar(first) && first !== 0x27;
  let inSpace = false;
  for (const [abs, c] of after) {
    const i = abs - off;
    const w = isWordChar(c);
    if (c === 0x20 || c === 0xa0) { inSpace = true; continue; }
    if (inSpace || (firstWord && !w) || (!firstWord && i > 0)) { end = off + i; break; }
  }
  return end;
}

/** The word around `off` (double-click): [start, end] with trailing spaces, as Word selects. */
export function wordAt(p, off) {
  off = clampOff(p, off);
  let a = off;
  const before = charsOf(p.text, 0, off);
  for (let j = before.length - 1; j >= 0; j--) { const [i, c] = before[j]; if (!isWordChar(c)) break; a = i; }
  let b = off;
  for (const [i, c] of charsOf(p.text, off, p.text.length)) {
    if (!isWordChar(c)) { if (i === off && a === off) b = off + cpLen(c); break; }
    b = i + cpLen(c);
  }
  let e = b;
  for (let i = b; i < p.text.length; i++) { if (p.text[i] !== ' ') break; e = i + 1; }
  return [a, e];
}

/** Sentence around `off` (Ctrl+click): ends after `.`, `!`, `?` and following spaces. */
export function sentenceAt(p, off) {
  off = clampOff(p, off);
  const t = p.text;
  let a = 0, prevEnd = false;
  for (const [i, c] of charsOf(t, 0, t.length)) {
    if (i > off) break;
    if (prevEnd && c !== 0x20) a = i;
    if (c === 0x2e || c === 0x21 || c === 0x3f) prevEnd = true; else if (c !== 0x20) prevEnd = false;
  }
  let b = t.length;
  let ended = /[.!?]$/.test(t.slice(0, off)) && t.slice(off).startsWith(' ');
  for (const [i, c] of charsOf(t, off, t.length)) {
    if (ended && c !== 0x20) { b = i; break; }
    if (c === 0x2e || c === 0x21 || c === 0x3f) ended = true;
  }
  return [a, b];
}

// --- inline_kinds.rs ------------------------------------------------------------------------

export const SHAPE_KINDS = Object.freeze(['rectangle', 'roundedRectangle', 'ellipse', 'flowchartOr', 'triangle', 'rightTriangle', 'diamond', 'line',
  'arrow', 'arrowLeft', 'arrowUp', 'arrowDown', 'star', 'heart', 'textBox', 'freeform', 'straightConnector', 'elbowConnector', 'curvedConnector']);
export const NOTE_KINDS = Object.freeze(['footnote', 'endnote']);
export const PTAB_ALIGNS = Object.freeze(['left', 'center', 'right']);
export const PTAB_BASES = Object.freeze(['margin', 'indent']);
export const RUBY_ALIGNS = Object.freeze(['center', 'distributeLetter', 'distributeSpace', 'left', 'right', 'rightVertical']);
/** Phonetic Guide's Offset for a ruby raise (baseline to baseline, points). */
export const rubyOffset = (raise, baseSize, size) => raise - 0.8 * baseSize - 0.2 * size;
/** The ruby raise for a Phonetic Guide Offset. */
export const rubyRaise = (offset, baseSize, size) => offset + 0.8 * baseSize + 0.2 * size;

// --- float.rs -------------------------------------------------------------------------------

export const WRAPS = Object.freeze(['inline', 'square', 'tight', 'through', 'topAndBottom', 'behindText', 'inFrontOfText']);
export const WRAP_TEXTS = Object.freeze(['bothSides', 'left', 'right', 'largest']);
export function wrapTextFromOoxml(v) {
  const s = String(v).trim().toLowerCase();
  if (s === 'bothsides' || s === 'both') return 'bothSides';
  if (s === 'left' || s === 'right' || s === 'largest') return s;
  return null;
}
export const ANCHORS = Object.freeze(['column', 'margin', 'page', 'paragraph', 'leftMargin', 'rightMargin', 'topMargin', 'bottomMargin',
  'insideMargin', 'outsideMargin', 'character', 'line']);
export const FLOAT_ALIGNS = Object.freeze(['start', 'center', 'end', 'inside', 'outside']);
export function floatAlignFromOoxml(v) {
  return {left: 'start', top: 'start', center: 'center', right: 'end', bottom: 'end', inside: 'inside', outside: 'outside'}[v] ?? null;
}
export function floatAlignOoxml(a, horizontal) {
  if (a === 'start') return horizontal ? 'left' : 'top';
  if (a === 'end') return horizontal ? 'right' : 'bottom';
  return a;
}
/** A floating placement with upstream's defaults (in line with text). */
export const defaultFloat = () => ({wrap: 'inline', hRel: 'column', vRel: 'column', x: 0, y: 0, dist: 0, distTop: 0, distBottom: 0, effect: [0, 0, 0, 0]});
/** Longest alternative text kept (characters). */
export const MAX_ALT_TEXT = 10_000;
export const capAlt = s => [...String(s)].slice(0, MAX_ALT_TEXT).join('');
/** The effect extents, finite and clamped (left, top, right, bottom). */
export const effectExtent = f => (f?.effect ?? [0, 0, 0, 0]).map(v => (Number.isFinite(v) ? Math.max(0, Math.min(1584, v)) : 0));

// --- inline_object.rs -----------------------------------------------------------------------

/** Most members a group keeps. */
export const MAX_GROUP_CHILDREN = 1000;
const DRAWINGS = new Set(['image', 'graphic', 'shape', 'group']);
const MARKERS = new Set(['bookmarkStart', 'bookmarkEnd', 'commentStart', 'commentEnd', 'permStart', 'permEnd', 'fieldStart', 'fieldEnd',
  'controlStart', 'controlEnd']);

/** A picture, chart or diagram, shape, text box or group. */
export const isDrawing = o => DRAWINGS.has(o?.type);
/** A drawing's [w, h, float]. */
export const objectFrame = o => (isDrawing(o) ? [o.w, o.h, o.float ?? defaultFloat()] : null);
/** Resize a drawing (a canvas's members keep their size and place). Returns the new object. */
export function setObjectSize(o, w, h) {
  if (!isDrawing(o)) return o;
  const out = {...o, w, h};
  if (o.type === 'group' && o.canvas) { out.ch_w = w; out.ch_h = h; }
  return out;
}
export const canvasStyle = o => (o?.type === 'group' ? o.canvas ?? null : null);
export const isCanvas = o => !!canvasStyle(o);
/** The text box story this object shows, if it is a text box. */
export const textBoxOf = o => (o?.type === 'shape' ? o.story ?? null : null);
/** The text box stories this object (or its group members) shows. */
export function textBoxesOf(o) {
  if (o?.type === 'shape') return o.story !== undefined && o.story !== null ? [o.story] : [];
  if (o?.type === 'group') return (o.children || []).map(c => textBoxOf(c.obj)).filter(id => id !== null && id !== undefined);
  return [];
}
/** Repoint the text box stories of an object and its members: `f(oldId) -> newId|null`. Returns the new object. */
export function mapTextBoxes(o, f) {
  if (o?.type === 'shape' && o.story !== undefined && o.story !== null) return {...o, story: f(o.story)};
  if (o?.type === 'group') {
    let changed = false;
    const children = (o.children || []).map(c => {
      if (c.obj?.type === 'shape' && c.obj.story !== undefined && c.obj.story !== null) { changed = true; return {...c, obj: {...c.obj, story: f(c.obj.story)}}; }
      return c;
    });
    return changed ? {...o, children} : o;
  }
  return o;
}
/** A group's members placed in a w × h box at (x, y): [[x, y, w, h], member]. */
export function groupRects(o, x, y, w, h) {
  if (o?.type !== 'group') return [];
  const fin = v => (Number.isFinite(v) ? v : 0);
  const sx = fin(o.ch_w) > 0 ? fin(w) / o.ch_w : 1;
  const sy = fin(o.ch_h) > 0 ? fin(h) / o.ch_h : 1;
  const out = [];
  for (const c of (o.children || []).slice(0, MAX_GROUP_CHILDREN)) {
    const fr = objectFrame(c.obj);
    if (!fr || c.obj.type === 'group') continue;
    out.push([[x + fin(c.x) * sx, y + fin(c.y) * sy, Math.max(0, Math.min(4000, fin(fr[0]) * sx)), Math.max(0, Math.min(4000, fin(fr[1]) * sy))], c.obj]);
  }
  return out;
}
/** Zero-width markers don't take part in layout. */
export const isMarker = o => MARKERS.has(o?.type);
/** A drawing's description (alternative text), wherever it is kept. */
export function altTextOf(o) {
  if (o?.type === 'image' || o?.type === 'graphic') return o.alt ?? '';
  if (o?.type === 'shape' || o?.type === 'group') return o.float?.alt?.text ?? '';
  return '';
}
/** Set a drawing's description (capped); returns the new object or null if it is no drawing. */
export function withAltText(o, text) {
  const t = capAlt(text);
  if (o?.type === 'image' || o?.type === 'graphic') return {...o, alt: t};
  if (o?.type === 'shape' || o?.type === 'group') {
    const fl = {...(o.float ?? defaultFloat())};
    fl.alt = {...(fl.alt || {}), text: t};
    return {...o, float: fl};
  }
  return null;
}
export const isDecorative = o => !!objectFrame(o)?.[2]?.alt?.decorative;
export const isFloating = o => isDrawing(o) && (o.float?.wrap ?? 'inline') !== 'inline';
/** The line a footnote or endnote separator draws, kept as the run element itself. */
export function noteSeparator(continuation) {
  const el = continuation ? 'w:continuationSeparator' : 'w:separator';
  return {type: 'opaque', format: 'docx', xml: `<w:r><${el}/></w:r>`, text: ''};
}
/** For a noteSeparator: whether it is the continuation separator (null for anything else). */
export function asNoteSeparator(o) {
  if (o?.type !== 'opaque' || o.format !== 'docx') return null;
  if (o.xml === '<w:r><w:separator/></w:r>') return false;
  if (o.xml === '<w:r><w:continuationSeparator/></w:r>') return true;
  return null;
}
/** The text an object contributes to plain-text extraction. */
export function objectPlainText(o) {
  switch (o?.type) {
    case 'field': return o.result ?? '';
    case 'equation': return o.linear ?? '';
    case 'ruby': return o.base ?? '';
    case 'positionalTab': return '\t';
    case 'opaque': return o.text ?? '';
    default: return '';
  }
}

/** The symbol font used to show a character (CharProps::shown_font), for callers that need it. */
export {shownFont};
export {charAt, charBefore};
