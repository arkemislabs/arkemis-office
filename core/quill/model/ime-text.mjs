// Visible logical text for IME surrounding-text queries (the page view's EditContext). The input
// method works on what the reader sees: tracked deletions are hidden and an inline object stands
// for its plain-text result. The helpers build a bounded window around a selection without copying
// the paragraph, and map both ends both ways so a query and a delete use exactly the same text.
// Translated from wordcraft crates/doc/src/ime_text.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Units: upstream counts UTF-8 bytes (its platforms' IME APIs do); here stored and visible offsets
// are UTF-16 code units, which is what EditContext and the DOM count. Delete counts come in 'units'
// (UTF-16 code units, upstream DeleteUnit::Bytes) or 'chars' (code points, DeleteUnit::Chars); a
// count ending inside a surrogate pair leaves the character whole, as upstream leaves a partly
// covered scalar whole. No DOM, no Node built-ins.

import {OBJ, deletedRanges, objectPlainText} from './para.mjs';

/** The largest visible window an IME query copies (code units). */
export const MAX_IME_TEXT = 4000;

const cpAt = (s, i) => s.codePointAt(i);
const cpLen = cp => (cp > 0xffff ? 2 : 1);

/** One paragraph's visible logical text (tracked deletions hidden, objects as their text). */
export class VisibleParagraph {
  constructor(para) {
    this.para = para;
    this.deleted = deletedRanges(para).slice().sort((a, b) => a[0] - b[0]);
  }
  /** Whether `off` is inside a tracked deletion; `cur` is a monotone cursor {i} over the ranges. */
  _isDeletedAt(cur, off) {
    while (cur.i < this.deleted.length && this.deleted[cur.i][1] <= off) cur.i++;
    const r = this.deleted[cur.i];
    return !!r && r[0] <= off && off < r[1];
  }
  /** Call `f(storedStart, piece, storedLen)` for visible pieces until it returns false. */
  _pieces(f) {
    const t = this.para.text;
    let object = 0;
    const cur = {i: 0};
    for (let i = 0; i < t.length;) {
      const cp = cpAt(t, i), w = cpLen(cp);
      const isObj = cp === 0xfffc;
      if (isObj) object++;
      if (!this._isDeletedAt(cur, i)) {
        const piece = isObj ? objectPlainText(this.para.objects?.[object - 1]) : t.slice(i, i + w);
        if (f(i, piece, w) === false) break;
      }
      i += w;
    }
  }
  _pieceLen(i, object) {
    const cp = cpAt(this.para.text, i);
    return cp === 0xfffc ? objectPlainText(this.para.objects?.[object - 1]).length : cpLen(cp);
  }
  /** Total visible length. */
  visibleLen() { let n = 0; this._pieces((_, p) => { n += p.length; }); return n; }

  /** Visible offset of a stored offset; null inside a character, a tracked deletion or an object's text. */
  visibleOffset(stored) {
    const t = this.para.text;
    if (stored < 0 || stored > t.length) return null;
    if (stored > 0 && stored < t.length) {
      const hi = t.charCodeAt(stored - 1), lo = t.charCodeAt(stored);
      if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return null;
    }
    let visible = 0, object = 0, found = false;
    const cur = {i: 0};
    for (let i = 0; i < t.length;) {
      if (i === stored) { found = true; break; }
      if (i > stored) break;
      const cp = cpAt(t, i), w = cpLen(cp);
      if (cp === 0xfffc) object++;
      if (!this._isDeletedAt(cur, i)) visible += cp === 0xfffc ? objectPlainText(this.para.objects?.[object - 1]).length : w;
      i += w;
    }
    if (!found) return this._isDeletedAt({i: 0}, stored) ? null : visible;
    if (stored < t.length && this._isDeletedAt(cur, stored)) return this.deleted.some(r => r[0] === stored) ? visible : null;
    return visible;
  }

  _storedScan(visible, mode) {
    const t = this.para.text;
    let acc = 0, object = 0;
    const cur = {i: 0};
    for (let i = 0; i < t.length;) {
      const cp = cpAt(t, i), w = cpLen(cp);
      if (mode === 'before' && visible === acc) return i;
      if (cp === 0xfffc) object++;
      if (this._isDeletedAt(cur, i)) { i += w; continue; }
      const len = cp === 0xfffc ? objectPlainText(this.para.objects?.[object - 1]).length : w;
      if (mode === 'plain' && visible === acc) return i;
      if (mode === 'after' && visible === acc && len > 0) return i;
      if (visible < acc + len) return null;
      acc += len;
      i += w;
    }
    return visible === acc ? t.length : null;
  }
  /** Stored offset for a visible offset; null inside a character or an object's text. */
  storedOffset(visible) { return this._storedScan(visible, 'plain'); }
  /** Stored offset for a range start: after zero-length markers (content controls) at that boundary. */
  storedOffsetAfter(visible) { return this._storedScan(visible, 'after'); }
  /** Stored offset for a range end: before a tracked deletion that starts there. */
  storedOffsetBefore(visible) { return this._storedScan(visible, 'before'); }

  /** Round a visible offset forward to the next visible boundary. */
  ceilBoundary(visible) {
    let acc = 0, out = null;
    this._pieces((_, p) => {
      if (out !== null) return false;
      if (acc >= visible) { out = acc; return false; }
      acc += p.length;
      if (acc >= visible) { out = acc; return false; }
      return true;
    });
    return out ?? acc;
  }
  /** Round a visible offset backward to the previous visible boundary. */
  floorBoundary(visible) {
    let acc = 0, out = 0;
    this._pieces((_, p) => { const next = acc + p.length; if (next > visible) return false; acc = next; out = acc; return true; });
    return out;
  }

  /**
   * A bounded window {text, cursor, anchor} around the selection (visible offsets). Never splits
   * the selection, never exceeds MAX_IME_TEXT; null when the selection is wider than the budget.
   */
  window(cursor, anchor, max = MAX_IME_TEXT) {
    max = Math.min(max, MAX_IME_TEXT);
    const selStart = Math.min(cursor, anchor), selEnd = Math.max(cursor, anchor);
    if (selEnd - selStart > max) return null;
    const before = Math.floor((max - (selEnd - selStart)) / 2);
    const winStart = Math.max(0, selStart - before);
    const winEnd = winStart + max;
    let text = '', first = null, acc = 0;
    this._pieces((_, piece) => {
      for (let k = 0; k < piece.length;) {
        const w = cpLen(cpAt(piece, k));
        const start = acc + k, end = start + w;
        if (end > winEnd) return false;
        if (start >= winStart) { if (first === null) first = start; text += piece.slice(k, k + w); }
        k += w;
      }
      acc += piece.length;
      return acc < winEnd;
    });
    if (first === null) return cursor === 0 && anchor === 0 ? {text: '', cursor: 0, anchor: 0} : null;
    return {text, cursor: Math.max(0, cursor - first), anchor: Math.max(0, anchor - first)};
  }
}

const samePara = (a, b) => a.story === b.story && a.path.length === b.path.length && a.path.every((x, i) => x === b.path[i]);

/** Bounded visible text around cursor/anchor in one paragraph (Document::ime_surrounding); null across paragraphs. */
export function imeSurrounding(doc, cursor, anchor, max = MAX_IME_TEXT) {
  if (!samePara(cursor, anchor)) return null;
  const para = doc.paraAt(cursor);
  if (!para) return null;
  const view = new VisibleParagraph(para);
  const c = view.visibleOffset(cursor.off), a = view.visibleOffset(anchor.off);
  if (c === null || a === null) return null;
  return view.window(c, a, Math.min(max, MAX_IME_TEXT));
}

/** Visible boundaries `before` code points back from selStart and `after` on from selEnd. */
function charBoundaries(view, selStart, selEnd, before, after) {
  let acc = 0, chars = 0, startIndex = null, endIndex = null;
  view._pieces((_, piece) => {
    for (let k = 0; k < piece.length;) {
      const at = acc + k;
      if (at === selStart) startIndex = chars;
      if (at === selEnd) endIndex = chars;
      chars++;
      k += cpLen(cpAt(piece, k));
    }
    acc += piece.length;
  });
  if (selStart === acc) startIndex = chars;
  if (selEnd === acc) endIndex = chars;
  if (startIndex === null || endIndex === null) return null;
  const targetBefore = Math.max(0, startIndex - before);
  const targetAfter = Math.min(endIndex + after, chars);
  acc = 0;
  let index = 0, beforeStart = null, afterEnd = targetAfter === 0 ? 0 : null;
  view._pieces((_, piece) => {
    for (let k = 0; k < piece.length;) {
      const at = acc + k;
      if (index === targetBefore && beforeStart === null) beforeStart = at;
      if (index === targetAfter && afterEnd === null) afterEnd = at;
      index++;
      k += cpLen(cpAt(piece, k));
    }
    acc += piece.length;
  });
  if (index === targetBefore && beforeStart === null) beforeStart = acc;
  if (index === targetAfter && afterEnd === null) afterEnd = acc;
  return beforeStart === null || afterEnd === null ? null : [beforeStart, afterEnd];
}

/**
 * Delete-surrounding ranges in the stored paragraph text (Document::ime_delete_surrounding):
 * {before: [from, to]|null, after: [from, to]|null, anchor, focus} (stored offsets before the
 * deletions). Unit counts that end inside a character leave it whole; a unit count past the
 * visible text is refused; char counts clamp at the paragraph ends; nothing to erase gives null.
 */
export function imeDeleteSurrounding(doc, cursor, anchor, before, after, unit = 'chars') {
  if (!samePara(cursor, anchor)) return null;
  if (before === 0 && after === 0) return null;
  const para = doc.paraAt(cursor);
  if (!para) return null;
  const view = new VisibleParagraph(para);
  const c = view.visibleOffset(cursor.off), a = view.visibleOffset(anchor.off);
  if (c === null || a === null) return null;
  const selStart = Math.min(c, a), selEnd = Math.max(c, a);
  let bs, ae;
  if (unit === 'units') {
    const total = view.visibleLen();
    if (before > selStart || after > total - selEnd) return null;
    bs = view.ceilBoundary(selStart - before);
    ae = view.floorBoundary(selEnd + after);
  } else {
    const r = charBoundaries(view, selStart, selEnd, before, after);
    if (!r) return null;
    [bs, ae] = r;
  }
  const beforeStart = view.storedOffsetAfter(bs), beforeEnd = view.storedOffsetBefore(selStart);
  const afterStart = view.storedOffsetAfter(selEnd), afterEnd = view.storedOffsetBefore(ae);
  if ([beforeStart, beforeEnd, afterStart, afterEnd].some(x => x === null)) return null;
  return {before: beforeStart < beforeEnd ? [beforeStart, beforeEnd] : null, after: afterStart < afterEnd ? [afterStart, afterEnd] : null,
    anchor: anchor.off, focus: cursor.off};
}

export {OBJ};
