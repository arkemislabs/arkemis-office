// Text targets for Slate's Home tab families (format, paragraph, tags; U:slate units).
//
// Slate has no ArtCraft upstream: behaviour follows docs/spec/slate.json (`format.*`,
// `paragraph.*`, `list.*`, `style.apply`, `tag.*`, sourceRef core/slate-format.mjs,
// core/slate-paragraph.mjs, core/slate-tags.mjs) and OneNote's Home tab:
//   * the commands act on the selection in a note: a text range, a caret (character formatting
//     then applies to the word around the caret, as OneNote and Word do; outside a word there is
//     nothing to format and the result says so), a selected note container (everything in it)
//     or a selected object;
//   * a page tab selection (`/pg:<id>`) or the page title holds no formattable text.
//
// Every edit is a ProseMirror Transform turned into steps and applied through the foundation's
// `steps` app op (core/slate/model/canvas.mjs applySteps), so it runs headless, is undoable as one
// entry, and the kernel maps the selection through it.
//
// No DOM, no Node built-ins.

import {Transform} from '@tiptap/pm/transform';
import {EditorState, TextSelection} from '@tiptap/pm/state';
import {CommandError} from '../../kernel/errors.mjs';
import {ID_NODES, isNotebook, nodeOf, schema} from '../schema.mjs';
import {blockIndex, pointToPos} from '../model/page.mjs';
import {applySteps} from '../model/canvas.mjs';

const POINT = /^\/pg:([^/]+)(?:\/(b|c|media):([^/]+)(?:\/t:(\d+)(?:-(\d+))?)?)?$/;

export const NO_TEXT = 'Click in a note to format text';

/**
 * The text range the selection names: {pageId, doc, from, to, kind} with kind 'text' (a range
 * or caret), 'container' (a selected note container), 'node' (a selected object) or null when the
 * selection holds no note text (a page tab, the title, nothing).
 */
export function textRange(ctx) {
  const c = ctx.doc;
  if (!isNotebook(c)) return null;
  const r = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
  if (!r) return null;
  const a = POINT.exec(r.anchor ?? ''), f = POINT.exec(r.focus ?? r.anchor ?? '');
  if (!a || !f || !a[2] || !f[2]) return null;
  const pageId = decodeURIComponent(a[1]);
  if (decodeURIComponent(f[1]) !== pageId || !c.pages[pageId]) return null;
  const doc = nodeOf(c.pages[pageId].body);
  const index = blockIndex(doc);
  const end = (m, side) => {
    const id = decodeURIComponent(m[3]);
    const hit = index.get(id);
    if (!hit) return null;
    if (m[2] === 'c') return {pos: side < 0 ? hit.pos + 1 : hit.pos + hit.node.nodeSize - 1, kind: 'container'};
    if (m[2] === 'media') return {pos: side < 0 ? hit.pos : hit.pos + 1, kind: 'node'};
    if (hit.node.isTextblock) {
      if (m[4] === undefined) return {pos: side < 0 ? hit.pos + 1 : hit.pos + 1 + hit.node.content.size, kind: 'text'};
      const off = Number(side > 0 && m[5] !== undefined ? m[5] : m[4]);
      try { return {pos: pointToPos(doc, id, Math.min(off, hit.node.content.size)), kind: 'text'}; } catch { return null; }
    }
    return {pos: side < 0 ? hit.pos + 1 : hit.pos + hit.node.nodeSize - 1, kind: 'text'};
  };
  const pa = end(a, -1), pf = end(f, 1);
  if (!pa || !pf) return null;
  // A single address with a range (t:4-9) carries both ends.
  const from = Math.min(pa.pos, pf.pos), to = Math.max(pa.pos, pf.pos);
  const kind = pa.kind === 'container' || pf.kind === 'container' ? 'container' : pa.kind === 'node' && pf.kind === 'node' ? 'node' : 'text';
  return {pageId, doc, from, to, kind};
}

/** textRange or a `disabled` CommandError with OneNote's reason. */
export function needRange(ctx) {
  const r = textRange(ctx);
  if (!r) throw new CommandError('disabled', NO_TEXT);
  return r;
}

/** State helper: enabled when the selection is in note text. */
export const textState = ctx => (textRange(ctx) ? {enabled: true} : {enabled: false, reason: isNotebook(ctx.doc) ? NO_TEXT : 'No notebook is open'});

const WORD = /[\p{L}\p{N}_'’\-]/u;

/** The word around a caret ([from, to] document positions) or null between words. */
export function wordAt(doc, pos) {
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock) return null;
  const text = $p.parent.textBetween(0, $p.parent.content.size, null, '￼');
  const off = $p.parentOffset;
  let s = off, e = off;
  while (s > 0 && WORD.test(text[s - 1])) s--;
  while (e < text.length && WORD.test(text[e])) e++;
  // A caret at a word's edge (before its first or after its last letter) is outside it, as in OneNote.
  if (off === s || off === e) return null;
  const base = $p.start();
  return {from: base + s, to: base + e};
}

/** The range character formatting applies to: the selection, or the word at a caret. */
export function charRange(range) {
  if (range.from !== range.to) return {from: range.from, to: range.to, word: false};
  const w = wordAt(range.doc, range.from);
  return w ? {...w, word: true} : null;
}

/** Textblocks the range touches (a caret: the one holding it): [{node, pos}]. */
export function textblocksIn(doc, from, to) {
  const out = [];
  if (from === to) {
    const $p = doc.resolve(from);
    if ($p.parent.isTextblock) return [{node: $p.parent, pos: $p.before()}];
  }
  doc.nodesBetween(from, Math.max(to, from + 1), (node, pos) => {
    if (node.isTextblock) { out.push({node, pos}); return false; }
    return true;
  });
  return out;
}

/** A fresh block id (`b…`, containers `c…`), unique in the page. */
export const newBlockId = (ctx, type = 'paragraph') => `${type === 'container' ? 'c' : 'b'}${ctx.host.uid()}`;

/** Give id-less or repeated id nodes fresh ids (ProseMirror helpers create nodes without them). */
export function ensureIds(ctx, tr) {
  const seen = new Set();
  const fix = [];
  tr.doc.descendants((node, pos) => {
    if (!ID_NODES.has(node.type.name)) return true;
    const id = node.attrs.id;
    if (typeof id !== 'string' || !id || seen.has(id)) fix.push({pos, type: node.type.name});
    else seen.add(id);
    return true;
  });
  for (const {pos, type} of fix) tr.setNodeAttribute(pos, 'id', newBlockId(ctx, type));
  return tr;
}

/** Run `fn(tr)` on a Transform of the page and apply its steps. Returns the transform (or null when nothing changed). */
export function editPage(ctx, pageId, fn, doc = nodeOf(ctx.doc.pages[pageId].body)) {
  const tr = new Transform(doc);
  fn(tr);
  if (!tr.steps.length) return null;
  ensureIds(ctx, tr);
  applySteps(ctx, pageId, tr.steps.map(st => st.toJSON()));
  return tr;
}

/** Run a ProseMirror command (prosemirror-commands / schema-list) on the range. Returns true when it changed the page. */
export function runPmCommand(ctx, range, command) {
  const state = EditorState.create({schema, doc: range.doc, selection: TextSelection.create(range.doc, range.from, range.to)});
  let out = null;
  const ok = command(state, tr => { out = tr; });
  if (!ok || !out || !out.steps.length) return false;
  ensureIds(ctx, out);
  applySteps(ctx, range.pageId, out.steps.map(st => st.toJSON()));
  return true;
}

/** Is a mark on all text in [from, to] (true), some of it ('mixed') or none (false)? A caret reads the marks at it. */
export function markState(doc, from, to, type, test = () => true) {
  if (from === to) {
    const m = type.isInSet(doc.resolve(from).marks());
    return !!m && test(m);
  }
  let some = false, all = true, any = false;
  doc.nodesBetween(from, to, node => {
    if (!node.isInline) return true;
    any = true;
    const m = type.isInSet(node.marks);
    if (m && test(m)) some = true; else all = false;
    return false;
  });
  if (!any) return false;
  return all ? true : some ? 'mixed' : false;
}

/** The value of a mark attribute at the start of the range (a caret: at the caret), or null. */
export function markAttr(doc, from, to, type, attr) {
  const $p = doc.resolve(from);
  let marks = $p.marks();
  if (from !== to) {
    let first = null;
    doc.nodesBetween(from, to, node => { if (!first && node.isInline) first = node; return !first; });
    if (first) marks = first.marks;
  }
  return type.isInSet(marks)?.attrs?.[attr] ?? null;
}

/** Inline text segments in [from, to]: [{from, to, marks}]. */
export function inlineSegments(doc, from, to) {
  const out = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    const s = Math.max(from, pos), e = Math.min(to, pos + node.nodeSize);
    if (e > s) out.push({from: s, to: e, marks: node.marks, node});
    return false;
  });
  return out;
}

/** Set (or clear with null) one attribute of the textStyle mark over [from, to], keeping its other attributes. */
export function setTextStyle(tr, from, to, attrs) {
  const type = schema.marks.textStyle;
  for (const seg of inlineSegments(tr.doc, from, to)) {
    const cur = type.isInSet(seg.marks)?.attrs ?? {color: null, fontFamily: null, fontSize: null};
    const next = {...cur};
    for (const [k, v] of Object.entries(typeof attrs === 'function' ? attrs(cur) : attrs)) next[k] = v;
    tr.removeMark(seg.from, seg.to, type);
    if (next.color !== null || next.fontFamily !== null || next.fontSize !== null) tr.addMark(seg.from, seg.to, type.create(next));
  }
}
