// Outline view's engine (View › Outline and the Outlining tab): which headings are collapsed and
// what is shown is view state ({collapsed: [[block, textHash]], showLevel, firstLineOnly,
// hideFormatting}), never saved in the document; level changes and moves are ordinary undoable
// edits. Expand and Collapse open or close one level at a time, Show Level hides everything deeper,
// Move Up / Move Down carry what a collapsed heading hides, Promote / Demote carry its hidden
// subheadings, and collapsed headings are found again after edits move them.
//
// Translated from wordcraft crates/engine/src/cmd/outline.rs (`OutlineState`, `targets`,
// `settle_show_level`, `expand`, `collapse`, `show_level`, `select_subtree`, `set_levels`,
// `hidden_subheadings`, `move_shown`, `remap_collapsed_headings`) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {CommandError} from '../../kernel/errors.mjs';
import {BODY, hidden as hiddenOf, subtreeEnd, hasChildren, textHashOf, remapPairs} from '../layout/outline.mjs';
import {headingLevel} from './para-lists.mjs';
import {cmpPos} from '../model/document.mjs';

export {BODY};

/** The default outline view state (OutlineState::default). */
export const defaultOutline = () => ({collapsed: [], showLevel: 0, firstLineOnly: false, hideFormatting: false});
/**
 * The document view's outline state, filled in; with the document `d`, its collapsed headings are
 * found again where edits, undo or redo moved them (outline.rs after_command).
 */
export function outlineOf(view, d = null) {
  const o = {...defaultOutline(), ...(view?.outline ?? {})};
  return d && o.collapsed.length ? remapCollapsed(d, o) : o;
}
/** What the layout needs (OutlineState::view): the collapsed headings with their text hashes, which the layout finds again. */
export const layoutOutline = o => ({collapsed: (o.collapsed ?? []).map(x => (Array.isArray(x) ? [...x] : x)), showLevel: o.showLevel ?? 0, firstLineOnly: !!o.firstLineOnly, plain: !!o.hideFormatting});
/** The outline view with the collapsed headings as block indices (for `hidden`). */
export const collapsedIdx = o => ({...layoutOutline(o), collapsed: (o.collapsed ?? []).map(x => (Array.isArray(x) ? x[0] : x))});

/** The top-level body blocks. */
export function bodyBlocks(d) {
  const bl = d.container('body', [0]);
  const out = [];
  for (let i = 0; i < bl.len(); i++) out.push(bl.get(i));
  return out;
}

/** The outline level of every body block (levels): 1–9 for headings, BODY for body text and tables. */
export function levelsOf(d) {
  return bodyBlocks(d).map(b => (b?.kind === 'para' ? headingLevel(d.styles, b.props) ?? BODY : BODY));
}

/** A short hash of a paragraph's text (text_hash): collapsed headings are found again by it. */
export function textHash(d, i) {
  const b = d.container('body', [0]).get(i);
  return b?.kind === 'para' ? textHashOf(b.text) : null;
}

const collapsedSet = o => new Set((o.collapsed ?? []).map(([i]) => i));
const withHashes = (d, set) => [...set].sort((a, b) => a - b).map(i => [i, textHash(d, i)]).filter(([, h]) => h !== null);

/** The top-level body blocks the selection touches (selected_blocks); null outside the body text. */
export function selectedBlocks(a, b) {
  if (a.story !== 'body' || b.story !== 'body' || !a.path.length || !b.path.length) return null;
  const i0 = a.path[0];
  let i1 = b.path[0];
  // A selection ending at the very start of a paragraph doesn't touch it.
  if (i1 > i0 && b.off === 0 && b.path.length === 1) i1 -= 1;
  return [i0, i1];
}

/** The headings a command acts on (targets): `block` when given, else the selected headings, else the heading the caret is under. */
export function targets(lv, sel, block) {
  const heading = i => lv[i] !== undefined && lv[i] < BODY;
  if (Number.isInteger(block)) return heading(block) ? [block] : [];
  if (!sel) return [];
  const r = selectedBlocks(sel[0], sel[1]);
  if (!r) return [];
  const [i0, i1] = r;
  const out = [];
  for (let i = i0; i <= Math.min(i1, lv.length - 1); i++) if (heading(i)) out.push(i);
  if (out.length) return out;
  for (let i = Math.min(i0, lv.length - 1); i >= 0; i--) if (heading(i)) return [i];
  return [];
}

/**
 * Show Level turned into collapsed headings (settle_show_level), so single headings can then be
 * expanded or collapsed: the headings at the shown level with something under them are collapsed
 * and every level is shown. Returns [collapsed set, showLevel after].
 */
export function settleShowLevel(lv, o) {
  const set = collapsedSet(o);
  const n = o.showLevel ?? 0;
  if (n >= 1 && n <= 9) {
    const hid = hiddenOf(lv, collapsedIdx(o));
    for (let i = 0; i < lv.length; i++) {
      const l = lv[i];
      if (l < BODY && l <= n && !hid[i] && hasChildren(lv, i)) {
        // A heading whose next shown paragraph is deeper keeps that open.
        let deeperShown = false;
        for (let j = i + 1; j < subtreeEnd(lv, i); j++) if (!hid[j]) { deeperShown = true; break; }
        if (!deeperShown) set.add(i);
      }
    }
    return [set, 0];
  }
  return [set, n];
}

/** Expand (expand): a collapsed heading opens; an open one shows the shallowest collapsed level under it. `all`: everything under it opens. */
export function expand(lv, o, tg, all = false) {
  const [set, showLevel] = settleShowLevel(lv, o);
  for (const h of tg) {
    const end = subtreeEnd(lv, h);
    if (all) { for (const i of [...set]) if (i >= h && i < end) set.delete(i); continue; }
    if (set.delete(h)) continue;
    const hid = hiddenOf(lv, {collapsed: [...set]});
    const open = [];
    for (let j = h + 1; j < end; j++) if (set.has(j) && !hid[j]) open.push(j);
    if (open.length) {
      const top = Math.min(...open.map(j => lv[j]));
      for (const j of open) if (lv[j] === top) set.delete(j);
    }
  }
  return {set, showLevel};
}

/** Collapse (collapse): the deepest open level under a heading closes first; a heading with nothing open under it closes itself. */
export function collapse(lv, o, tg, all = false) {
  const [set, showLevel] = settleShowLevel(lv, o);
  for (const h of tg) {
    if (!hasChildren(lv, h) || set.has(h)) continue;
    if (all) { set.add(h); continue; }
    const hid = hiddenOf(lv, {collapsed: [...set]});
    const open = [];
    for (let j = h + 1; j < subtreeEnd(lv, h); j++) if (lv[j] < BODY && hasChildren(lv, j) && !set.has(j) && !hid[j]) open.push(j);
    if (open.length) {
      const deepest = Math.max(...open.map(j => lv[j]));
      for (const j of open) if (lv[j] === deepest) set.add(j);
    } else set.add(h);
  }
  return {set, showLevel};
}

/** The outline state after `set` became the collapsed headings. */
export const withCollapsed = (d, o, set, showLevel = o.showLevel) => ({...o, showLevel, collapsed: withHashes(d, set)});

/**
 * The headings hidden under collapsed headings in the selection, with their levels
 * (hidden_subheadings): promoting or demoting a collapsed heading carries them along (Outline view only).
 */
export function hiddenSubheadings(view, lv, sel, d = null) {
  const o = outlineOf(view, d);
  if (view?.mode !== 'outline' || !o.collapsed.length) return [];
  const r = sel ? selectedBlocks(sel[0], sel[1]) : null;
  if (!r) return [];
  const [i0, i1] = r;
  const hid = hiddenOf(lv, collapsedIdx(o));
  const out = [];
  for (const [h] of o.collapsed) {
    if (h < i0 || h > i1) continue;
    for (let j = h + 1; j < subtreeEnd(lv, h); j++) {
      if (lv[j] !== undefined && lv[j] < BODY && hid[j] && !out.some(([k]) => k === j)) out.push([j, lv[j]]);
    }
  }
  return out;
}

/**
 * Move Up / Move Down in Outline view (move_shown): the selected paragraphs and what is hidden under
 * them pass the next shown paragraph and what is hidden under it. Works on the Document `d` (inside
 * ctx.model.edit) and returns the new [anchor, focus], or null when the selection isn't in top-level
 * body paragraphs (the ordinary move then applies).
 */
export function moveShown(d, view, a, b, up) {
  if (view?.mode !== 'outline') return null;
  if (a.story !== 'body' || b.story !== 'body' || a.path.length !== 1 || b.path.length !== 1) return null;
  const r = selectedBlocks(a, b);
  if (!r) return null;
  const [i0, i1] = r;
  const lv = levelsOf(d);
  const hid = hiddenOf(lv, collapsedIdx(outlineOf(view, d)));
  const isHidden = i => !!hid[i];
  let r1 = i1;
  while (isHidden(r1 + 1)) r1++;
  const bl = d.container('body', [0]);
  const len = bl.len();
  let lo, hi, shift;
  if (up) {
    let v = null;
    for (let j = i0 - 1; j >= 0; j--) if (!isHidden(j)) { v = j; break; }
    if (v === null) throw new CommandError('failed', 'already at the top');
    [lo, hi, shift] = [v, r1, -(i0 - v)];
  } else {
    const w = r1 + 1;
    if (w >= len) throw new CommandError('failed', 'already at the bottom');
    let e = w;
    while (isHidden(e + 1)) e++;
    [lo, hi, shift] = [i0, e, e - r1];
  }
  const slice = [];
  for (let i = lo; i <= hi; i++) slice.push(bl.get(i));
  if (slice.some(x => x?.kind === 'para' && x.section)) throw new CommandError('failed', "paragraphs don't move across a section break");
  const k = up ? i0 - lo : hi - r1;
  const rotated = up ? [...slice.slice(k), ...slice.slice(0, k)] : [...slice.slice(slice.length - k), ...slice.slice(0, slice.length - k)];
  const ml = d.containerMut('body', [0]);
  rotated.forEach((x, n) => ml.set(lo + n, x));
  // The selection moves with the paragraphs; an end just past them stays just past them.
  const newR1 = r1 + shift;
  const blockEnd = i => { const p = bl.get(i); return p?.kind === 'para' ? {story: 'body', path: [i], off: p.text.length} : {story: 'body', path: [Math.min(i + 1, len - 1)], off: 0}; };
  const map = p => {
    const i = p.path[p.path.length - 1];
    if (i >= i0 && i <= r1) return {...p, path: [i + shift]};
    return newR1 + 1 < len ? {story: 'body', path: [newR1 + 1], off: 0} : blockEnd(newR1);
  };
  return [d.clamp(map(a)), d.clamp(map(b))];
}

/** Keeps collapsed headings collapsed after an edit (remap_collapsed_headings): each moves to the nearest free heading with the same text. */
export function remapCollapsed(d, o) {
  const texts = bodyBlocks(d).map(b => (b?.kind === 'para' ? b.text : null));
  return {...o, collapsed: remapPairs(levelsOf(d), texts, o.collapsed ?? [])};
}

/** The selection of a heading and everything under it (select_subtree). */
export function subtreeSelection(d, start) {
  const lv = levelsOf(d);
  if (start >= lv.length) throw new CommandError('invalid_params', '`block` is past the end of the document', {path: '/block'});
  const end = Math.max(subtreeEnd(lv, start), start + 1);
  const bl = d.container('body', [0]);
  const last = bl.get(end - 1);
  const focus = last?.kind === 'para' ? {story: 'body', path: [end - 1], off: last.text.length} : d.clamp({story: 'body', path: [end], off: 0});
  return {anchor: d.clamp({story: 'body', path: [start], off: 0}), focus};
}

export const orderedPair = (x, y) => (cmpPos(x, y) <= 0 ? [x, y] : [y, x]);

/**
 * The Navigation pane's drag (Word): heading `from` and everything under it move before body block
 * `to` (or to the end when `to` is the block count). Refused for body text, into its own section,
 * and across a section break, as Move Up / Move Down are. Works on `d` inside ctx.model.edit;
 * returns the caret at the moved heading's start.
 */
export function moveSection(d, from, to) {
  const lv = levelsOf(d);
  if (lv[from] === undefined || lv[from] >= BODY) throw new CommandError('failed', 'only a heading moves with its content');
  const end = subtreeEnd(lv, from);
  if (to > lv.length) throw new CommandError('invalid_params', '`to` is past the end of the document', {path: '/to'});
  if (to >= from && to <= end) return d.clamp({story: 'body', path: [from], off: 0});
  const bl = d.container('body', [0]);
  const moving = [];
  for (let i = from; i < end; i++) moving.push(bl.get(i));
  const [lo, hi] = to < from ? [to, end] : [from, to];
  const span = [];
  for (let i = lo; i < hi; i++) span.push(bl.get(i));
  if (span.some(x => x?.kind === 'para' && x.section)) {
    throw new CommandError('failed', "paragraphs don't move across a section break");
  }
  const rest = span.filter((_, k) => lo + k < from || lo + k >= end);
  const out = to < from ? [...moving, ...rest] : [...rest, ...moving];
  const ml = d.containerMut('body', [0]);
  out.forEach((x, k) => ml.set(lo + k, x));
  const at = to < from ? to : to - moving.length;
  return d.clamp({story: 'body', path: [at], off: 0});
}
