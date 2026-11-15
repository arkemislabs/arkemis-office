// An input method's composition (pre-edit) in the text being edited, the bounded committed text
// around the selection that input methods ask for, and the walks `text.deleteSurrounding` deletes
// with. Translated from deckcraft crates/engine/src/cmd/text/ime.rs (`ime_char`, `committed_chars`,
// `composition_range`, `model_pos`, `walk_forward`, `walk_backward`, `logical_between`,
// `ime_surrounding`, `ime_text`, `composition_fits`, `underline_segments`) and
// crates/engine/src/cmd/text/caret.rs (`count_param`, `delete_surrounding`, `remap_after_delete`)
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// U:prism/text owns this file. No DOM, no Node built-ins.
//
// Where the composition lives. deckcraft writes the pre-edit into the document and keeps the
// presentation from before it (`Composition.before`), so the whole composition becomes one undo
// step when it is committed and an empty pre-edit restores the text exactly. The kernel records
// every document change as an undo entry (consecutive ones merge only within one second, which a
// conversion easily outlasts), so here the pre-edit is session view state, `view.composition`
// = {slide, shape, cell, notes, from, to, text, active, props}: it stands in for the selected range
// [from, to] of the body being edited. The surface draws the body with the pre-edit in place
// (`composedText`), the caret after it and its underlines; `text.commit` writes it as one undo
// step; an empty pre-edit drops it, leaving the text and selection as they were. Same behaviour as
// deckcraft, seen from the person and from the bridge.
//
// Units: model positions are [paragraph, UTF-16 offset] (core/prism/model/edit.mjs). Input
// methods count characters (Unicode scalars) or UTF-8 bytes of the logical text, as deckcraft
// does: a paragraph mark and a soft line break read as one `\n`.

import {paraLen} from '../model/text.mjs';
import {remove, insert} from '../model/edit.mjs';
import {cmpPos, ordered} from './text-session.mjs';

/** deckcraft `IME_SURROUNDING_MAX_BYTES` (egui's MAX_IME_SURROUNDING_TEXT_BYTES). */
export const IME_SURROUNDING_MAX_BYTES = 4000;

/** deckcraft `ime_char`: a soft line break reads as a newline. */
const imeChar = ch => (ch === '\u000b' ? '\n' : ch);
/** UTF-8 length of one scalar. */
const utf8Len = ch => { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; };
/** UTF-8 length of a string. */
export const utf8Bytes = str => { let n = 0; for (const ch of str) n += utf8Len(ch); return n; };

/** deckcraft `ime_text`: text an input method sends has no control characters (Enter is a key of its own). */
// eslint-disable-next-line no-control-regex
export const imeText = str => [...String(str ?? '')].filter(c => !/\p{Cc}/u.test(c)).join('');

/** deckcraft `count_param`: a non-negative count, clamped (never wrapped) when huge; 0 when absent. */
export function countParam(p, name) {
  const v = p?.[name];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER);
}

/** The scalars of paragraph `p` as [UTF-16 offset, character] (soft line breaks as `\n`). */
function chars(p) {
  const out = [];
  let i = 0;
  for (const r of p?.runs ?? []) {
    const content = r.kind?.kind === 'break' ? '\u000b' : r.text ?? '';
    for (const ch of content) { out.push([i, imeChar(ch)]); i += ch.length; }
  }
  return out;
}

/** deckcraft `model_pos`: clip a position to the body; an empty body only has [0, 0]. */
export function modelPos(body, pos) {
  const ps = body?.paragraphs ?? [];
  if (!ps.length) return pos[0] === 0 && pos[1] === 0 ? [0, 0] : null;
  const p = ps[pos[0]];
  return p ? [pos[0], Math.min(pos[1], paraLen(p))] : null;
}

/**
 * deckcraft `walk_forward`: from `from`, over at most `limit` characters (or UTF-8 bytes of whole
 * characters), stopping at the end of the body. Returns [position reached, characters, bytes].
 */
export function walkForward(body, from, limit, bytes) {
  const ps = body?.paragraphs ?? [];
  let [pi, at] = from;
  let n = 0, used = 0;
  const fits = (k) => (bytes ? used + k <= limit : n < limit);
  while (ps[pi]) {
    for (const [i, ch] of chars(ps[pi])) {
      if (i < at) continue;
      const k = utf8Len(ch);
      if (!fits(k)) return [[pi, i], n, used];
      used += k; n += 1; at = i + ch.length;
    }
    if (pi + 1 >= ps.length) break;
    // The paragraph separator between this paragraph and the next.
    if (!fits(1)) return [[pi, at], n, used];
    used += 1; n += 1; pi += 1; at = 0;
  }
  return [[pi, at], n, used];
}

/** deckcraft `walk_backward`: the same, towards the start of the body. */
export function walkBackward(body, from, limit, bytes) {
  const ps = body?.paragraphs ?? [];
  let [pi, at] = from;
  let n = 0, used = 0;
  const fits = (k) => (bytes ? used + k <= limit : n < limit);
  for (;;) {
    const para = ps[pi];
    if (!para) return [[pi, at], n, used];
    let boundary = Math.min(at, paraLen(para));
    const list = chars(para);
    for (let k = list.length - 1; k >= 0; k--) {
      const [i, ch] = list[k];
      if (i >= boundary) continue;
      const b = utf8Len(ch);
      if (!fits(b)) return [[pi, boundary], n, used];
      used += b; n += 1; boundary = i;
    }
    if (pi === 0) return [[0, 0], n, used];
    if (!fits(1)) return [[pi, 0], n, used];
    used += 1; n += 1; pi -= 1; at = Infinity;
  }
}

/** deckcraft `logical_between`: the logical text from `a` to `b` (excluding `b`), or null when longer than `cap` bytes. */
export function logicalBetween(body, a0, b0, cap) {
  const [a, b] = ordered(a0, b0);
  const ps = body?.paragraphs ?? [];
  let out = '', bytes = 0;
  for (let pi = a[0]; pi <= b[0]; pi++) {
    const para = ps[pi];
    if (!para) return out;
    const from = pi === a[0] ? a[1] : 0;
    const to = pi === b[0] ? b[1] : Infinity;
    for (const [i, ch] of chars(para)) {
      if (i < from || i >= to) continue;
      out += ch; bytes += utf8Len(ch);
      if (bytes > cap) return null;
    }
    if (pi < b[0]) { out += '\n'; bytes += 1; if (bytes > cap) return null; }
  }
  return out;
}

/**
 * deckcraft `ime_surrounding`: bounded committed text around the selection [anchor, caret] of
 * `body`, in logical order, with UTF-8 byte offsets `cursor` (the caret) and `anchor`. A pending
 * composition is not committed text: pass the body without it (`committedBody`). Null when the
 * selection is not in the body or is wider than the bound; an empty body is {text: '', 0, 0}.
 */
export function imeSurrounding(body, anchorPos, caretPos) {
  const caret = modelPos(body, caretPos);
  const anchor = modelPos(body, anchorPos);
  if (!caret || !anchor) return null;
  const [start, end] = ordered(caret, anchor);
  const selected = logicalBetween(body, start, end, IME_SURROUNDING_MAX_BYTES);
  if (selected === null) return null;
  const selLen = utf8Bytes(selected);
  const budget = Math.max(0, IME_SURROUNDING_MAX_BYTES - selLen);
  const beforeAvail = walkBackward(body, start, budget, true)[2];
  const afterAvail = walkForward(body, end, budget, true)[2];
  let before = Math.min(Math.floor(budget / 2), beforeAvail);
  let after = Math.min(budget - before, afterAvail);
  before = Math.min(budget - after, beforeAvail);
  after = Math.min(budget - before, afterAvail);
  const wStart = walkBackward(body, start, before, true)[0];
  const wEnd = walkForward(body, end, after, true)[0];
  const beforeText = logicalBetween(body, wStart, start, budget);
  const afterText = logicalBetween(body, end, wEnd, budget);
  if (beforeText === null || afterText === null) return null;
  const text = beforeText + selected + afterText;
  if (utf8Bytes(text) > IME_SURROUNDING_MAX_BYTES) return null;
  const bl = utf8Bytes(beforeText);
  const caretLast = cmpPos(caret, anchor) >= 0;
  return {text, cursor: caretLast ? bl + selLen : bl, anchor: caretLast ? bl : bl + selLen};
}

/** deckcraft `remap_after_delete`: a position at or after `start` once [from, start) is deleted. */
export function remapAfterDelete(pos, start, from) {
  if (cmpPos(pos, start) < 0) return pos;
  if (pos[0] === start[0]) return [from[0], from[1] + (pos[1] - start[1])];
  return [pos[0] - (start[0] - from[0]), pos[1]];
}

// ---------------------------------------------------------------------------------------------
// The composition (view.composition)

/** The text target of a composition or text selection: same slide, shape, cell and notes. */
export const sameTarget = (c, t) => !!c && !!t && c.slide === t.slide && !!c.notes === !!t.notes
  && (c.notes || String(c.shape) === String(t.shape)) && JSON.stringify(c.cell ?? null) === JSON.stringify(t.cell ?? null);

/**
 * deckcraft `composition_fits`: the composition still stands for the selection of the text being
 * edited (same body, the selection is still [from, to], both inside the body).
 */
export function compositionFits(c, t, body, sel) {
  if (!c || !t || !body || !sameTarget(c, t)) return false;
  const a = modelPos(body, c.from), b = modelPos(body, c.to);
  if (!a || !b || cmpPos(a, c.from) || cmpPos(b, c.to)) return false;
  const [s, e] = ordered(sel.anchor, sel.caret);
  return !cmpPos(s, c.from) && !cmpPos(e, c.to);
}

/** The body without the range the composition replaces: the committed text input methods see. */
export function committedBody(body, c) {
  return c ? remove(body, c.from, c.to).body : body;
}

/**
 * The body as drawn while composing: the pre-edit in place of [from, to] with its text props,
 * the caret after it, and the underline ranges (deckcraft `underline_segments`): the whole
 * pre-edit thin, the part being converted (`active`) thick. Offsets are UTF-16, in the composed body.
 */
export function composedText(body, c) {
  const r = remove(body, c.from, c.to);
  const ins = insert(r.body, r.pos, c.text, c.props ?? undefined);
  const [pi, s] = r.pos;
  const ranges = c.text ? [{para: pi, start: s, end: s + c.text.length, thick: false}] : [];
  if (c.text && c.active) ranges.push({para: pi, start: s + c.active[0], end: s + Math.min(c.active[1], c.text.length), thick: true});
  return {body: ins.body, caret: ins.pos, ranges};
}

/** `active` [start, end] in characters of `text` → UTF-16 offsets, clamped to the text (deckcraft clamps to the pre-edit). */
export function activeRange(active, text) {
  if (!Array.isArray(active) || active.length !== 2) return null;
  const cps = [...text];
  const [x, y] = active.map(v => Math.min(Math.max(0, Math.floor(Number(v) || 0)), cps.length));
  if (!(Number(active[0]) < Number(active[1]))) return null;
  const off = k => cps.slice(0, k).join('').length;
  return [off(x), off(y)];
}
