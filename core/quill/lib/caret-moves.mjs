// Caret movement and selection units: what the `caret.*` and `select.*` commands do.
//
// Translated from wordcraft crates/engine/src/cmd/caret.rs (extend, apply, mv, rtl_para,
// bidi_para, lr, left, right, word_left, word_right, para_up, para_down, vert, line, page, set,
// select_all, select_range, Unit, unit_range, select_unit, select_paragraph, select_line,
// drag_unit, select_text) and crates/layout/src/hit.rs (line_span) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Up/Down, Home/End, Page Up/Down and Select Line read the layout (`S.layout()`, see
// caret-session.mjs). Not translated: visual (bidi) Left/Right inside right-to-left text
// (layout `visual_step` is not in core/quill/layout yet): Left/Right there move logically.

import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {hasRtl} from '../model/text.mjs';
import {caret, isCollapsed, ordered, cmpPos, samePath, at, cellOf} from './caret-session.mjs';
import {rp} from './text-edit.mjs';

const paraAt = (S, p) => S.d.paraAt(p);

/** Move the focus (extend) or the whole selection to `to` (apply). */
export function apply(S, to, ext) {
  S.sel = ext ? {anchor: S.sel.anchor, focus: to} : caret(to);
  S.view.pending = null;
}

/** mv: goal x forgotten, `f` from the focus. */
export function mv(S, ext, f) {
  S.view.goalX = null;
  const to = f(S, S.sel.focus);
  apply(S, to, ext);
}

/** Does the caret's paragraph read right to left? (rtl_para) */
export function rtlPara(S) {
  const p = paraAt(S, S.sel.focus);
  return !!p && !!rp(S, p).bidi;
}
/** Is the caret's paragraph bidirectional? (bidi_para) */
export function bidiPara(S) {
  const p = paraAt(S, S.sel.focus);
  return !!p && (hasRtl(p.text) || !!rp(S, p).bidi);
}

export function left(S, p) {
  const para = paraAt(S, p);
  if (para && p.off > 0) return at(p, P.prevBoundary(para, p.off));
  const q = S.d.prevPara(p.story, p.path);
  if (!q) return p;
  return {story: p.story, path: q, off: S.d.para(p.story, q)?.text.length ?? 0};
}

export function right(S, p) {
  const para = paraAt(S, p);
  if (para && p.off < para.text.length) return at(p, P.nextBoundary(para, p.off));
  const q = S.d.nextPara(p.story, p.path);
  return q ? {story: p.story, path: q, off: 0} : p;
}

export function wordLeft(S, p) {
  const para = paraAt(S, p);
  return para && p.off > 0 ? at(p, P.wordStart(para, p.off)) : left(S, p);
}

export function wordRight(S, p) {
  const para = paraAt(S, p);
  return para && p.off < para.text.length ? at(p, P.wordEnd(para, p.off)) : right(S, p);
}

export function paraUp(S, p) {
  if (p.off > 0) return at(p, 0);
  const q = S.d.prevPara(p.story, p.path);
  return q ? {story: p.story, path: q, off: 0} : p;
}

export function paraDown(S, p) {
  const q = S.d.nextPara(p.story, p.path);
  if (q) return {story: p.story, path: q, off: 0};
  return at(p, paraAt(S, p)?.text.length ?? 0);
}

/** Left/Right: with a selection and no Shift, collapse to its edge (lr). */
export function lr(S, isLeft, ext) {
  if (!ext && !isCollapsed(S.sel)) {
    const [a, b] = ordered(S.sel);
    const toStart = isLeft !== rtlPara(S);
    S.sel = caret(toStart ? a : b);
    S.view.goalX = null;
    return;
  }
  mv(S, ext, isLeft ? left : right);
}

/** Word Left/Right: in a right-to-left paragraph the word to the left is the next one. */
export function word(S, isLeft, ext) {
  mv(S, ext, isLeft !== rtlPara(S) ? wordLeft : wordRight);
}

/** Up/Down keep the goal x across lines (vert). */
export function vert(S, dir, ext) {
  const l = S.layout();
  const from = S.sel.focus;
  let to;
  const r = l ? l.vertical(from, S.view.goalX, dir, S.view.pageHint) : null;
  if (r) { to = r[0]; S.view.goalX = r[1]; } else to = dir < 0 ? S.d.startOf(from.story) : S.d.endOf(from.story);
  const c = l?.caret(to, S.view.pageHint);
  if (c) S.view.pageHint = c.page;
  const gx = S.view.goalX;
  apply(S, to, ext);
  S.view.goalX = gx;
}

/** Home/End: the start or end of the caret's line (line). */
export function line(S, home, ext) {
  const l = S.layout();
  const from = S.sel.focus;
  const b = l?.lineBounds(from, S.view.pageHint);
  const to = b ? (home ? b[0] : b[1]) : from;
  S.view.goalX = null;
  apply(S, to, ext);
}

/** Page Up/Down: the same place on the previous or next page (page). */
export function page(S, dir, ext) {
  const l = S.layout();
  const from = S.sel.focus;
  const c = l?.caret(from, S.view.pageHint);
  if (!c) return;
  const np = dir < 0 ? Math.max(c.page - 1, 0) : Math.min(c.page + 1, Math.max(l.pages.length - 1, 0));
  const to = l.hit(np, c.x, c.top + 1, from.story) ?? from;
  S.view.pageHint = np;
  apply(S, to, ext);
}

/** caret.set: a position, or the text nearest a point on a page (set). */
export function setCaret(S, p) {
  let to;
  if (p.pos) to = p.pos;
  else if (Number.isInteger(p.page) && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    const l = S.layout();
    S.view.pageHint = p.page;
    to = l?.hit(p.page, p.x, p.y, p.story ?? S.sel.focus.story) ?? null;
    if (!to) throw new CommandError('invalid_params', 'no text on that page');
  } else throw new CommandError('invalid_params', '`pos` or `page`/`x`/`y` required');
  to = S.d.clamp(to);
  S.view.goalX = null;
  apply(S, to, !!p.extend);
}

/** Select All: the whole story the caret is in; in a table, the cell first (select_all). */
export function selectAll(S, whole = false) {
  const st = S.sel.focus.story;
  const all = {anchor: S.d.startOf(st), focus: S.d.endOf(st)};
  // selects_whole_story: nothing more to select.
  if (cmpPos(ordered(S.sel)[0], all.anchor) === 0 && cmpPos(ordered(S.sel)[1], all.focus) === 0) return;
  if (!whole) {
    // grow_select_all: inside a table cell, Ctrl+A selects the cell's text, then the table.
    const g = growSelectAll(S);
    if (g) { S.sel = g; return; }
  }
  S.sel = all;
}

/**
 * Ctrl+A inside a table grows the selection: the cell, then its row, then the table, then the cell
 * around a nested table, then the story (table/select.rs grow_select_all over cell ranges; here
 * the cell ranges are the text they span).
 */
function growSelectAll(S) {
  const story = S.sel.focus.story;
  const [a, b] = ordered(S.sel);
  const paths = S.d.paraPaths(story);
  const span = (inside) => {
    const list = paths.filter(inside);
    if (!list.length) return null;
    const last = list[list.length - 1];
    return {anchor: {story, path: list[0], off: 0}, focus: {story, path: last, off: S.d.para(story, last)?.text.length ?? 0}};
  };
  const under = prefix => q => q.length > prefix.length && samePath(q.slice(0, prefix.length), prefix);
  const covers = sel => sel && cmpPos(a, sel.anchor) <= 0 && cmpPos(sel.focus, b) <= 0;
  for (let cell = cellOf(a.path); cell; cell = cellOf(cell[0])) {
    const [tpath, r, c] = cell;
    const steps = [span(under([...tpath, r, c])), span(under([...tpath, r])), span(under(tpath))];
    for (const sel of steps) if (sel && !covers(sel)) return sel;
  }
  return null;
}

export function selectRange(S, a, b) {
  S.sel = {anchor: S.d.clamp(a), focus: S.d.clamp(b)};
}

export const UNITS = Object.freeze(['word', 'sentence', 'line', 'paragraph', 'document']);

/** The line around `pos`: [start, end, isLastLine] (layout line_span). */
export function lineSpan(S, pos) {
  const l = S.layout();
  if (!l) return null;
  for (const [, it] of l.pieces(pos.story, pos.path, S.view.pageHint)) {
    const para = it.para;
    const li = para.lineOf(pos.off);
    if (li < it.l0 || li >= it.l1) continue;
    const ln = para.lines[li];
    return [at(pos, ln.start), at(pos, ln.stop), li + 1 === para.lines.length];
  }
  return null;
}

/** The word, sentence, line, paragraph or story around `p`; a paragraph includes its mark (unit_range). */
export function unitRange(S, p, unit) {
  const para = paraAt(S, p);
  if (!para) return [p, p];
  const len = para.text.length;
  const markEnd = () => {
    const q = S.d.nextPara(p.story, p.path);
    if (q && samePath(q.slice(0, -1), p.path.slice(0, -1))) return {story: p.story, path: q, off: 0};
    return at(p, len);
  };
  switch (unit) {
    case 'word': { const [a, b] = P.wordAt(para, p.off); return [at(p, a), at(p, b)]; }
    case 'sentence': { const [a, b] = P.sentenceAt(para, p.off); return [at(p, a), at(p, b)]; }
    case 'paragraph': return [at(p, 0), markEnd()];
    case 'document': return [S.d.startOf(p.story), S.d.endOf(p.story)];
    case 'line': {
      const span = lineSpan(S, p);
      if (!span) return [p, p];
      return span[2] ? [span[0], markEnd()] : [span[0], span[1]];
    }
    default: throw new CommandError('invalid_params', '`unit` must be word, sentence, line, paragraph or document');
  }
}

export function selectUnit(S, unit) {
  const f = S.sel.focus;
  if (paraAt(S, f)) { const [a, b] = unitRange(S, f, unit); S.sel = {anchor: a, focus: b}; }
}

/**
 * Select Paragraph; with `cell` (a triple-click) on the last paragraph of a table cell, the cell
 * (select_paragraph). The cell selection is its whole content, as table.rs select_range gives it.
 */
export function selectParagraph(S, cell = false) {
  selectUnit(S, 'paragraph');
  if (!cell) return;
  const a = S.sel.anchor, b = S.sel.focus;
  const c = cellOf(a.path);
  if (!c || a.story !== b.story) return;
  const [tpath, r, ci] = c;
  const t = S.d.table(a.story, tpath);
  const blocks = t?.rows[r]?.cells[ci]?.blocks.length ?? 0;
  if (a.path[a.path.length - 1] !== blocks - 1) return;
  const prefix = [...tpath, r, ci];
  const paths = S.d.paraPaths(a.story).filter(q => samePath(q.slice(0, prefix.length), prefix));
  if (!paths.length) return;
  const last = paths[paths.length - 1];
  S.sel = {anchor: {story: a.story, path: paths[0], off: 0}, focus: {story: a.story, path: last, off: S.d.para(a.story, last)?.text.length ?? 0}};
}

/** A click in the selection bar: the whole line at `pos` (select_line). */
export function selectLine(S, pos) {
  if (pos) S.sel = caret(S.d.clamp(pos));
  selectUnit(S, 'line');
}

/** Drag after a double-click, triple-click or Ctrl+click: grow by whole units (drag_unit). */
export function dragUnit(S, unit, start0, end0, pos0) {
  if (!UNITS.includes(unit)) throw new CommandError('invalid_params', '`unit` must be word, sentence, line, paragraph or document');
  const pos = S.d.clamp(pos0);
  let start = S.d.clamp(start0), end = S.d.clamp(end0);
  if (cmpPos(start, end) > 0) [start, end] = [end, start];
  if (pos.story !== start.story || end.story !== start.story) return;
  const [us, ue] = unitRange(S, pos, unit);
  if (unit === 'document') S.sel = {anchor: us, focus: ue};
  else if (cmpPos(pos, start) >= 0) S.sel = {anchor: start, focus: cmpPos(ue, end) >= 0 ? ue : end};
  else S.sel = {anchor: end, focus: cmpPos(us, start) <= 0 ? us : start};
  S.view.goalX = null;
  S.view.pending = null;
}

/** Select the n-th occurrence of `needle` in a story (select_text). */
export function selectText(S, needle, n = 1, story = 'body') {
  if (!needle) throw new CommandError('invalid_params', '`text` is empty');
  let count = 0;
  for (const path of S.d.paraPaths(story)) {
    const p = S.d.para(story, path);
    if (!p) continue;
    let i = p.text.indexOf(needle);
    while (i >= 0) {
      count++;
      if (count === n) { S.sel = {anchor: {story, path, off: i}, focus: {story, path, off: i + needle.length}}; return; }
      i = p.text.indexOf(needle, i + needle.length);
    }
  }
  throw new CommandError('failed', `\`${needle}\` not found`);
}

/** Escape: collapse to the start (or end) (select.collapse). */
export function collapse(S, toEnd) {
  const [a, b] = ordered(S.sel);
  S.sel = caret(toEnd ? b : a);
}
