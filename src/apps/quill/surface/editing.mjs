// Caret movement, selection and typing for the Quill page view: the semantics of the `caret.*`,
// `select.*` and `text.*` commands, over the schema-2 model (core/quill/model) and the layout
// (core/quill/layout). The ui-commands in src/apps/quill/ui-commands wrap these functions.
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd/caret.rs        every caret.* and select.* command
//   crates/engine/src/cmd/text.rs         the text.* command table
//   crates/engine/src/cmd/text/delete.rs  backspace, delete, delete word back/forward
//   crates/engine/src/cmd/text/enter_tab.rs  Enter, =rand()/=lorem() sample text, Tab, Shift+Tab
//   crates/engine/src/cmd/text/autoformat.rs `typing_options`, smart quotes (`autoformat`)
//   crates/engine/src/cmd/text/unicode.rs `ins_char`
//   crates/engine/src/cmd.rs              type_text / insert_text, delete_selection(_effect),
//                                         track_delete(_as), new_revision, split_para(_as),
//                                         leave_list, has_next_para, join_next_para
//   crates/engine/src/cmd/para/format.rs  indent / outdent (Tab and Backspace at a paragraph start)
//   crates/engine/src/session/query.rs    typing_props / caret_props
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `S` stands for upstream's Session: {d (a model Document over the content), sel {anchor, focus},
// view (live.mjs view state: goalX, pageHint, pending), prefs, author, now(), layout()}. Positions
// are {story, path, off} with UTF-16 offsets. Functions change `S.sel` and edit `S.d`; the caller
// commits `S.d`'s op and sets the kernel selection from `S.sel`.
//
// Not translated here (they belong to other wordcraft modules and families): AutoCorrect,
// AutoFormat as you type (lists from "1. ", border and table lines, headings, dashes, double-space
// period: cmd/tools.rs and text/autoformat.rs), content-control placeholders (cmd/controls.rs),
// IME outcome bookkeeping, column (Alt+drag) selection, whole-cell selection on triple-click,
// visual (bidi) Left/Right (layout visual_step).

import {cmpPositions} from '../../../../core/quill/address.mjs';
import * as P from '../../../../core/quill/model/para.mjs';
import {resolvePara, getStyle} from '../../../../core/quill/model/styles.mjs';
import {levelOf} from '../../../../core/quill/model/numbering.mjs';
import {insertRow} from '../../../../core/quill/model/table.mjs';
import {paraCancelCharIndents, charUnlinked, charWithoutSymbol} from '../../../../core/quill/model/props.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';

const OBJ = '\uFFFC';
export const MAX_TYPED_PARAGRAPHS = 10_000;

// ---- positions and selections -------------------------------------------------------------

export const cmpPos = cmpPositions;
export const samePos = (a, b) => cmpPos(a, b) === 0;
export const caret = p => ({anchor: p, focus: p});
export const isCollapsed = sel => samePos(sel.anchor, sel.focus);
export const ordered = sel => (cmpPos(sel.anchor, sel.focus) <= 0 ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor]);
const at = (p, off) => ({story: p.story, path: [...p.path], off});
const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const withLast = (path, v) => [...path.slice(0, -1), v];

/** Defaults of the File › Options settings typing reads (upstream Prefs::default). */
export function typingPrefs(prefs) {
  const p = prefs ?? {};
  const ac = p.autocorrect ?? {};
  return {
    typingReplacesSelection: p.typingReplacesSelection ?? true,
    overtype: !!p.overtype,
    autocorrect: {enabled: ac.enabled ?? true, smartQuotes: ac.smartQuotes ?? true, tabIndent: ac.tabIndent ?? true},
  };
}

const paraAt = (S, p) => S.d.paraAt(p);
const paraLen = para => para.text.length;
const rp = (S, para) => resolvePara(S.d.c.styles, para.props);

/** Does the caret's paragraph read right to left? (rtl_para) */
function rtlPara(S) {
  const p = paraAt(S, S.sel.focus);
  return !!p && !!rp(S, p).bidi;
}

/** Move the focus (extend) or the whole selection to `to` (apply). */
function apply(S, to, ext) {
  if (ext) S.sel = {anchor: S.sel.anchor, focus: to};
  else S.sel = caret(to);
  S.view.pending = null;
}

function mv(S, ext, f) {
  S.view.goalX = null;
  const to = f(S, S.sel.focus);
  apply(S, to, ext);
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
  if (para && p.off < paraLen(para)) return at(p, P.nextBoundary(para, p.off));
  const q = S.d.nextPara(p.story, p.path);
  return q ? {story: p.story, path: q, off: 0} : p;
}

export function wordLeft(S, p) {
  const para = paraAt(S, p);
  return para && p.off > 0 ? at(p, P.wordStart(para, p.off)) : left(S, p);
}

export function wordRight(S, p) {
  const para = paraAt(S, p);
  return para && p.off < paraLen(para) ? at(p, P.wordEnd(para, p.off)) : right(S, p);
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
  const rtl = rtlPara(S);
  mv(S, ext, isLeft !== rtl ? wordLeft : wordRight);
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

/** caret.set: a position, or the text nearest a point on a page. */
export function setCaret(S, p) {
  let to;
  if (p.pos) to = p.pos;
  else if (Number.isInteger(p.page) && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    const l = S.layout();
    S.view.pageHint = p.page;
    to = l?.hit(p.page, p.x, p.y, p.story ?? S.sel.focus.story ?? 'body');
    if (!to) throw new CommandError('invalid_params', 'no text on that page');
  } else throw new CommandError('invalid_params', '`pos` or `page`/`x`/`y` required');
  to = S.d.clamp(to);
  S.view.goalX = null;
  apply(S, to, !!p.extend);
}

/** Select All: the whole story the caret is in (select_all). */
export function selectAll(S) {
  const st = S.sel.focus.story;
  S.sel = {anchor: S.d.startOf(st), focus: S.d.endOf(st)};
}

export function selectRange(S, a, b) {
  S.sel = {anchor: S.d.clamp(a), focus: S.d.clamp(b)};
}

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

/**
 * The word, sentence, line, paragraph or story around `p` (unit_range). A paragraph includes its
 * mark (it ends at the start of the next paragraph in the same container), and so does its last line.
 */
export function unitRange(S, p, unit) {
  const para = paraAt(S, p);
  if (!para) return [p, p];
  const len = paraLen(para);
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

/** A click in the selection bar: the whole line at `pos` (default the caret's) (select_line). */
export function selectLine(S, pos) {
  if (pos) S.sel = caret(S.d.clamp(pos));
  selectUnit(S, 'line');
}

/**
 * Drag after a double-click, triple-click or Ctrl+click (drag_unit): the selection keeps the unit
 * first selected (start..end) and grows by whole units to the one under `pos`.
 */
export function dragUnit(S, unit, start0, end0, pos0) {
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

/** Select the n-th occurrence of `text` in a story (select_text). */
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

export function collapse(S, toEnd) {
  const [a, b] = ordered(S.sel);
  S.sel = caret(toEnd ? b : a);
}

// ---- typing ---------------------------------------------------------------------------------

/** The caret's formatting, as Reveal Formatting shows it (caret_props). */
export function caretProps(S) {
  if (S.view.pending) return {...S.view.pending};
  const f = S.sel.focus;
  const p = paraAt(S, f);
  if (!p) return {};
  const props = P.propsAt(p, f.off) ?? {};
  const insideLink = !!props.link && f.off > 0 && f.off < paraLen(p) && P.propsOfChar(p, f.off)?.link === props.link;
  const out = charWithoutSymbol(props.link && !insideLink ? charUnlinked(props) : {...props});
  if (out.style === 'FootnoteReference' || out.style === 'EndnoteReference') delete out.style;
  return out;
}

/** The formatting typed text gets (typing_props). */
export function typingProps(S) {
  const [a] = ordered(S.sel);
  const p = paraAt(S, a);
  let c;
  if (p && !S.view.pending && !isCollapsed(S.sel) && a.off < paraLen(p)) {
    const props = P.propsOfChar(p, a.off) ?? {};
    c = props.link ? charUnlinked(props) : {...props};
    if (c.style === 'FootnoteReference' || c.style === 'EndnoteReference') delete c.style;
  } else c = caretProps(S);
  delete c.rtl;
  return c;
}

/** A revision record for the current author (new_revision): reuses one of the same kind and time. */
export function newRevision(S, kind) {
  const date = S.now();
  const list = S.d.c.revisions ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.kind === kind && r.author === S.author && r.date === date && !r.moveName) return i;
  }
  S.d.updateField('revisions', rs => [...(rs ?? []), {kind, author: S.author, date}]);
  return S.d.c.revisions.length - 1;
}

const trackChanges = S => !!S.d.c.settings?.trackChanges;

/** Is the paragraph at `path` followed by another paragraph in the same container? (has_next_para) */
export function hasNextPara(S, story, path) {
  return S.d.block(story, withLast(path, path[path.length - 1] + 1))?.kind === 'para';
}

function setMark(S, story, path, f) {
  const p = S.d.paraMut(story, path);
  const m = f({...(p.mark ?? {})});
  if (m && Object.keys(m).length) p.mark = m; else delete p.mark;
}

function setPara(S, story, path, f) {
  const p = S.d.paraMut(story, path);
  const props = f({...(p.props ?? {})});
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  if (Object.keys(props).length) p.props = props; else delete p.props;
  return p;
}

/** Join the next paragraph in the container into this one (join_next_para). */
export function joinNextPara(S, story, path) {
  if (!hasNextPara(S, story, path)) return false;
  const next = withLast(path, path[path.length - 1] + 1);
  const len = S.d.para(story, path)?.text.length ?? 0;
  const nm = S.d.para(story, next)?.mark ?? {};
  S.d.deleteRange({story, path, off: len}, {story, path: next, off: 0});
  setMark(S, story, path, m => { m.ins = nm.ins; m.del = nm.del; if (m.ins === undefined) delete m.ins; if (m.del === undefined) delete m.del; return m; });
  return true;
}

function trackDeleteWouldChange(S, a, b) {
  for (const path of S.d.pathsBetween(a, b)) {
    const p = S.d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0;
    const to = samePath(path, b.path) ? b.off : paraLen(p);
    if (P.runRanges(p).some(([s, e, c]) => e > from && s < to && (c?.del ?? null) === null)) return true;
    if (!samePath(path, b.path) && hasNextPara(S, a.story, path) && (p.mark?.del ?? null) === null) return true;
  }
  return false;
}

/** Tracked deletion marking with revision `rid` (track_delete_as): own insertions go, the rest is marked. */
function trackDeleteAs(S, a, b, rid) {
  let changed = false;
  const own = c => c != null && S.d.c.revisions?.[c]?.author === S.author;
  const paths = S.d.pathsBetween(a, b);
  for (const path of [...paths].reverse()) {
    const p = S.d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0;
    const to = samePath(path, b.path) ? b.off : paraLen(p);
    const ranges = P.runRanges(p).filter(([s, e, c]) => e > from && s < to && (c?.del ?? null) === null)
      .map(([s, e, c]) => [Math.max(s, from), Math.min(e, to), own(c?.ins)]);
    for (const [x, y, mine] of ranges.reverse()) {
      if (mine) S.d.deleteRange({story: a.story, path, off: x}, {story: a.story, path, off: y});
      else S.d.formatRange({story: a.story, path, off: x}, {story: a.story, path, off: y}, c => ({...c, del: rid}));
      changed = true;
    }
    if (!samePath(path, b.path) && hasNextPara(S, a.story, path)) {
      const m = S.d.para(a.story, path)?.mark ?? {};
      if ((m.del ?? null) === null) {
        if (own(m.ins)) joinNextPara(S, a.story, path);
        else setMark(S, a.story, path, mk => ({...mk, del: rid}));
        changed = true;
      }
    }
  }
  return {at: {...a, path: [...a.path]}, changed};
}

/** Delete the selection, respecting Track Changes (delete_selection_effect). */
export function deleteSelectionEffect(S) {
  const [a, b] = ordered(S.sel);
  if (samePos(a, b)) return {at: a, contentChanged: false};
  let eff;
  if (trackChanges(S)) {
    if (!trackDeleteWouldChange(S, a, b)) eff = {at: a, contentChanged: false};
    else { const r = trackDeleteAs(S, a, b, newRevision(S, 'delete')); eff = {at: r.at, contentChanged: r.changed}; }
  } else eff = {at: S.d.deleteRange(a, b), contentChanged: true};
  S.sel = caret(eff.at);
  return eff;
}

export const deleteSelection = S => deleteSelectionEffect(S).at;

/** Take a paragraph out of its list as Enter or Backspace does (leave_list). */
export function leaveList(S, story, path) {
  setPara(S, story, path, pr => {
    if (pr.style === 'ListParagraph') { delete pr.style; delete pr.numbering; }
    else pr.numbering = {num: 0, level: 0};
    delete pr.indentLeft; delete pr.indentFirst; delete pr.indentLeftChars; delete pr.indentFirstChars;
    return pr;
  });
}

/** Whether a paragraph has no letters yet and no direction set (direction_unset). */
function directionUnset(S, pos) {
  const p = paraAt(S, pos);
  if (!p) return false;
  if (p.props?.bidi !== undefined || /\p{L}/u.test(p.text) || S.d.c.styles?.defaultPara?.bidi !== undefined) return false;
  const style = p.props?.style ?? 'Normal';
  for (let id = style, n = 0; id && n < 64; n++) {
    const st = getStyle(S.d.c.styles, id);
    if (!st) break;
    if (st.para?.bidi !== undefined) return false;
    id = st.basedOn;
  }
  return true;
}

const RTL_STRONG = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
const firstStrongIsRtl = text => { for (const ch of text) { if (RTL_STRONG.test(ch)) return true; if (/\p{L}/u.test(ch)) return false; } return false; };

/** Split the paragraph at `pos` as Enter does (split_para_as). */
export function splitParaAs(S, pos, enter) {
  const p = paraAt(S, pos);
  if (!p) throw new CommandError('failed', 'no paragraph at caret');
  const atEnd = pos.off >= paraLen(p);
  const style = p.props?.style ?? null;
  const num = p.props?.numbering ?? rp(S, p).numbering ?? null;
  if (enter && num && num.num !== 0 && paraLen(p) === 0) {
    // Enter on an empty list item: a nested item moves up a level, a top-level one ends the list.
    if (num.level > 0) setPara(S, pos.story, pos.path, pr => ({...pr, numbering: {num: num.num, level: num.level - 1}}));
    else leaveList(S, pos.story, pos.path);
    return {...pos};
  }
  const nw = S.d.splitParagraph(pos);
  if (atEnd && style) {
    const next = getStyle(S.d.c.styles, style)?.next ?? null;
    if (next && next !== style) {
      setPara(S, nw.story, nw.path, pr => { pr.style = next; delete pr.numbering; return pr; });
      // A heading's character formatting doesn't carry into body text.
      setMark(S, nw.story, nw.path, () => ({}));
    }
  }
  if (trackChanges(S)) {
    // The new paragraph mark is an insertion (cmd.rs split_para_as under Track Changes).
    const rid = newRevision(S, 'insert');
    setMark(S, pos.story, pos.path, m => ({...m, ins: rid}));
  }
  return nw;
}

/** typing_options: "Typing replaces selected text" off leaves the selection; overtype selects what the text replaces. */
export function typingOptions(S, text) {
  const prefs = typingPrefs(S.prefs);
  if (!isCollapsed(S.sel)) {
    if (!prefs.typingReplacesSelection) S.sel = caret(ordered(S.sel)[0]);
    return;
  }
  if (!prefs.overtype || /[\r\n\u2029\u000B]/.test(text)) return;
  const f = S.sel.focus;
  const rest = paraAt(S, f)?.text.slice(f.off) ?? '';
  const n = [...text].length;
  let len = 0, k = 0;
  for (const ch of rest) { if (k >= n || ch === OBJ) break; len += ch.length; k++; }
  if (len > 0) S.sel = {anchor: at(f, f.off + len), focus: f};
}

/** Smart quotes as you type (autoformat): a typed " or ' becomes the opening or closing curly quote. */
export function smartQuote(S, text) {
  if ([...text].length !== 1) return null;
  const c = text;
  const prefs = typingPrefs(S.prefs);
  if (!prefs.autocorrect.enabled || !prefs.autocorrect.smartQuotes) return null;
  if (c !== '"' && c !== '\'') return null;
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return null;
  const before = [...para.text.slice(0, f.off)];
  const prev = before[before.length - 1];
  const opening = prev === undefined || /\s/u.test(prev) || '([{<—–«‹„‚'.includes(prev)
    || (c === '"' && prev === '‘') || (c === '\'' && prev === '“');
  if (c === '"') return opening ? '“' : '”';
  return opening ? '‘' : '’';
}

/** Insert typed or pasted text at the caret (insert_text). */
export function insertText(S, text, enter = true) {
  let props = typingProps(S);
  if (isCollapsed(S.sel)) S.sel = caret(S.d.typingPos(S.d.pastFieldEnds(S.sel.focus)));
  if (!enter) props = charWithoutSymbol(props);
  const deletion = deleteSelectionEffect(S);
  delete props.fmtChange;
  delete props.rtl;
  if (trackChanges(S) && text) { props.ins = newRevision(S, 'insert'); delete props.del; } else { delete props.ins; delete props.del; }
  let pos = S.sel.focus;
  let first = true, inserted = false;
  for (const part0 of text.split(/[\r\u2029]/)) {
    if (!first) { pos = splitParaAs(S, pos, enter); inserted = true; }
    first = false;
    const part = part0.replace(/\u000B/g, '\n');
    if (part) {
      inserted = true;
      const startsPara = directionUnset(S, pos);
      pos = S.d.insertText(pos, part, props);
      // Typing Arabic, Hebrew… as a paragraph's first letters makes it right to left.
      if (startsPara && firstStrongIsRtl(S.d.paraAt(pos).text)) setPara(S, pos.story, pos.path, pr => ({...pr, bidi: true}));
    }
  }
  S.sel = caret(pos);
  S.view.goalX = null;
  return {contentChanged: deletion.contentChanged || inserted};
}

/** text.insert (insert): typing options, smart quotes, then the text; `paragraphs` types line by line. */
export function typeText(S, text, {raw = false, paragraphs = false} = {}) {
  if (paragraphs) return insertParagraphs(S, text);
  typingOptions(S, text);
  const q = raw ? null : smartQuote(S, text);
  const r = insertText(S, q ?? text, true);
  S.view.pending = null;
  return r;
}

/** text.insert with `paragraphs` (insert_paragraphs): each line typed raw, Enter between. */
export function insertParagraphs(S, text0) {
  const text = text0.replace(/\r\n/g, '\n');
  const lines = text.split(/[\n\r\u2029]/);
  if (lines.length > MAX_TYPED_PARAGRAPHS) {
    throw new CommandError('invalid_params', `text.insert: \`text\` has ${lines.length} lines; type at most ${MAX_TYPED_PARAGRAPHS} paragraphs per call`);
  }
  typingOptions(S, text);
  lines.forEach((ln, i) => {
    if (i > 0) enter(S);
    if (ln) insertText(S, ln, true);
  });
  return {contentChanged: true};
}

/** A typed character (ins_char). */
export function insChar(S, ch) {
  return typeText(S, ch, {raw: true});
}

const SAMPLE = {
  '=rand(': ['A blank page leaves room for a new idea.', 'The morning light falls across a notebook on the desk.', 'Small changes in spacing can give a story a different rhythm.'],
  '=lorem(': ['Lorem ipsum dolor sit amet, consectetur adipiscing elit.', 'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.'],
};

/** =rand() and =lorem() sample text (sample_text): the text Enter types instead, or null. */
export function sampleText(S) {
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para || !isCollapsed(S.sel) || f.off !== paraLen(para)) return null;
  const prefix = Object.keys(SAMPLE).find(k => para.text.startsWith(k));
  if (!prefix) return null;
  const sentences = SAMPLE[prefix];
  if (!para.text.endsWith(')')) return null;
  const args = para.text.slice(prefix.length, -1);
  if (/[()]/.test(args)) return null;
  const count = a => { const t = a.trim(); if (!/^\d+$/.test(t)) return null; const n = Number(t); return n >= 1 && n <= 200 ? n : null; };
  let counts;
  if (!args) counts = [5, 3];
  else if (args.includes(',')) { const [p, q] = args.split(/,(.*)/s); const a = count(p), b = count(q); counts = a && b ? [a, b] : null; }
  else { const a = count(args); counts = a ? [a, 3] : null; }
  const [paragraphs, lines] = counts ?? [5, 3];
  let text = '';
  for (let i = 0; i < paragraphs; i++) {
    for (let k = 0; k < lines; k++) {
      if (text && !text.endsWith('\r')) text += ' ';
      text += sentences[k % sentences.length];
    }
    text += '\r';
  }
  return text;
}

/** Enter's paragraph break (enter): sample text, else a plain split. */
export function enter(S) {
  const sample = sampleText(S);
  if (sample !== null) {
    const end = S.sel.focus;
    S.sel = {anchor: at(end, 0), focus: end};
    insertText(S, sample, true);
    return;
  }
  const pos = deleteSelection(S);
  const nw = splitParaAs(S, pos, true);
  S.sel = caret(nw);
  S.view.goalX = null;
}

/** text.newParagraph. */
export function newParagraph(S) {
  enter(S);
  S.view.pending = null;
}

/** The first Backspace at a numbered paragraph's start removes the number, keeping its indent (remove_number). */
function removeNumber(S, f, n) {
  const textAt = levelOf(S.d.c.numbering, n.num, n.level)?.indent ?? null;
  setPara(S, f.story, f.path, pr => {
    if (pr.style === 'ListParagraph') {
      if (pr.indentLeft === undefined && !(pr.indentLeftChars > 0) && textAt !== null) pr.indentLeft = textAt;
      if (pr.indentFirst === undefined && !(pr.indentFirstChars > 0)) pr.indentFirst = 0;
    }
    pr.numbering = {num: 0, level: 0};
    return pr;
  });
}

/** Is "Set left- and first-indent with tabs and backspaces" on? (tab_indent_on) */
export function tabIndentOn(S) {
  const ac = typingPrefs(S.prefs).autocorrect;
  const enforced = !!S.d.c.settings?.protection?.enforced || !!S.d.c.settings?.protectionEnforced;
  return ac.enabled && ac.tabIndent && !(enforced && S.d.c.settings?.protectFormatting);
}

/** Increase indent (para/format.rs indent): list items go down a level, others to the next default tab stop. */
export function indent(S, dir) {
  const [a, b] = ordered(S.sel);
  const tab = Math.max(S.d.c.settings?.defaultTab ?? 36, 1);
  for (const path of S.d.paraPathsIn(a, b)) {
    const p = S.d.para(a.story, path);
    if (!p) continue;
    const num = p.props?.numbering && p.props.numbering.num !== 0 ? p.props.numbering : null;
    const left = rp(S, p).indentLeft ?? 0;
    setPara(S, a.story, path, pr => {
      if (num) pr.numbering = {num: num.num, level: dir > 0 ? Math.min(num.level + 1, 8) : Math.max(num.level - 1, 0)};
      else {
        pr.indentLeft = dir > 0 ? (Math.floor(left / tab) + 1) * tab : Math.max((Math.ceil(left / tab) - 1) * tab, 0);
        pr = paraCancelCharIndents(pr, true, false, false);
      }
      return pr;
    });
  }
}

/** Backspace (backspace_inner). */
export function backspace(S) {
  S.view.goalX = null;
  S.view.pending = null;
  if (!isCollapsed(S.sel)) { deleteSelectionEffect(S); return; }
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  if (f.off > 0) {
    S.sel = {anchor: at(f, P.backspaceFrom(para, f.off)), focus: f};
    deleteSelectionEffect(S);
    return;
  }
  const n = para.props?.numbering;
  if (n && n.num !== 0) { removeNumber(S, f, n); return; }
  if (para.props?.style === 'ListParagraph') { leaveList(S, f.story, f.path); return; }
  if ((para.props?.indentFirst ?? 0) > 0 || (para.props?.indentFirstChars ?? 0) > 0) {
    setPara(S, f.story, f.path, pr => paraCancelCharIndents({...pr, indentFirst: 0}, false, false, true));
    return;
  }
  if (tabIndentOn(S) && ((para.props?.indentLeft ?? 0) > 0 || (para.props?.indentLeftChars ?? 0) > 0)) { indent(S, -1); return; }
  const i = f.path[f.path.length - 1];
  if (i === 0) return; // start of a story or cell
  const prevPath = withLast(f.path, i - 1);
  const prev = S.d.block(f.story, prevPath);
  if (prev?.kind === 'para') {
    const a = {story: f.story, path: prevPath, off: prev.text.length};
    if (trackChanges(S)) { S.sel = {anchor: a, focus: f}; deleteSelection(S); return; }
    S.sel = caret(S.d.deleteRange(a, f));
  } else if (prev?.kind === 'table') {
    // Move into the table's last cell.
    const paths = S.d.paraPaths(f.story);
    let q = null;
    for (let k = paths.length - 1; k >= 0; k--) {
      const c = paths[k];
      if (c.length > prevPath.length && samePath(c.slice(0, prevPath.length), prevPath)) { q = c; break; }
    }
    if (q) {
      const off = S.d.para(f.story, q)?.text.length ?? 0;
      if (paraLen(para) === 0 && S.d.container(f.story, f.path)?.len() > i + 1) S.d.removeBlock(f.story, f.path);
      S.sel = caret({story: f.story, path: q, off});
    }
  }
}

/** Delete (delete_inner). */
export function del(S) {
  S.view.goalX = null;
  S.view.pending = null;
  if (!isCollapsed(S.sel)) { deleteSelectionEffect(S); return; }
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  if (f.off < paraLen(para)) {
    S.sel = {anchor: f, focus: at(f, P.nextBoundary(para, f.off))};
    deleteSelectionEffect(S);
    return;
  }
  const next = withLast(f.path, f.path[f.path.length - 1] + 1);
  const nb = S.d.block(f.story, next);
  if (nb?.kind === 'para') {
    const b = {story: f.story, path: next, off: 0};
    if (trackChanges(S)) {
      const blocks = S.d.container(f.story, f.path)?.len();
      S.sel = {anchor: f, focus: b};
      deleteSelection(S);
      if (S.d.container(f.story, f.path)?.len() === blocks && S.d.paraAt(f)?.mark?.del != null) S.sel = caret(b);
      return;
    }
    S.sel = caret(S.d.deleteRange(f, b));
  } else if (nb?.kind === 'table') {
    if (paraLen(para) === 0 && f.path[f.path.length - 1] > 0) {
      S.d.removeBlock(f.story, f.path);
      const path = [...next];
      path[path.length - 1] -= 1;
      S.sel = caret({story: f.story, path: [...path, 0, 0, 0], off: 0});
    }
  } else if (f.story === 'body' && f.path.length === 1 && !trackChanges(S)) {
    // The last paragraph: a section break on its mark still goes (#2127).
    S.d.removeSectionBreak(f.path[0]);
  }
}

export function deleteWordBack(S) {
  if (!isCollapsed(S.sel)) return backspace(S);
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  if (f.off === 0) return backspace(S);
  S.sel = {anchor: at(f, P.wordStart(para, f.off)), focus: f};
  deleteSelection(S);
}

export function deleteWordForward(S) {
  if (!isCollapsed(S.sel)) return del(S);
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  if (f.off >= paraLen(para)) return del(S);
  S.sel = {anchor: f, focus: at(f, P.wordEnd(para, f.off))};
  deleteSelection(S);
}

/** The table path, row and cell of a position inside a table cell (Path::cell). */
export function cellOf(path) {
  const n = path.length;
  if (n < 4) return null;
  return [path.slice(0, n - 3), path[n - 3], path[n - 2]];
}

/** Does Tab at `f` indent instead of typing a tab? (tab_indents) */
function tabIndents(S, f) {
  const para = paraAt(S, f);
  if (!para || paraLen(para) === 0) return false;
  if (f.off === 0) { const n = rp(S, para).numbering; return !n || n.num === 0; }
  const b = S.layout()?.lineBounds(f, S.view.pageHint);
  return !!b && samePos(b[0], f);
}

/** Tab at a line start with the option on (indent_by_tab). */
function indentByTab(S, f) {
  const para = paraAt(S, f);
  if (!para) return;
  const r = rp(S, para);
  if (f.off > 0 && !para.props?.numbering && r.numbering && r.numbering.num !== 0) {
    setPara(S, f.story, f.path, pr => ({...pr, numbering: {num: r.numbering.num, level: Math.min(r.numbering.level + 1, 8)}}));
    return;
  }
  if (f.off === 0 && (r.indentFirst ?? 0) === 0 && (r.indentChars?.[2] ?? 0) === 0) {
    const tab = Math.max(S.d.c.settings?.defaultTab ?? 36, 1);
    setPara(S, f.story, f.path, pr => paraCancelCharIndents({...pr, indentFirst: tab}, false, false, true));
    return;
  }
  indent(S, 1);
}

/** Tab (tab): next table cell, list level down, indent, or a tab character. */
export function tab(S) {
  const cell = cellOf(S.sel.focus.path);
  if (cell) {
    const [tpath, r, c] = cell;
    const story = S.sel.focus.story;
    const t = S.d.table(story, tpath);
    if (!t) { insChar(S, '\t'); return; }
    const rowLen = t.rows[r]?.cells.length ?? 0;
    const [nr, nc] = c + 1 < rowLen ? [r, c + 1] : [r + 1, 0];
    if (nr >= t.rows.length) S.d.updateTable(story, tpath, tb => insertRow(tb, nr, r, () => S.d.newId()));
    const start = {story, path: [...tpath, nr, nc, 0], off: 0};
    const prefix = start.path.slice(0, -1);
    const paths = S.d.paraPaths(story);
    let endPath = null;
    for (let k = paths.length - 1; k >= 0; k--) if (samePath(paths[k].slice(0, prefix.length), prefix)) { endPath = paths[k]; break; }
    const end = endPath ? {story, path: endPath, off: S.d.para(story, endPath)?.text.length ?? 0} : start;
    S.sel = {anchor: start, focus: end};
    return;
  }
  const f = S.sel.focus;
  const n = paraAt(S, f)?.props?.numbering;
  if (isCollapsed(S.sel) && f.off === 0 && n && n.num !== 0) {
    setPara(S, f.story, f.path, pr => ({...pr, numbering: {num: n.num, level: Math.min(n.level + 1, 8)}}));
    return;
  }
  if (isCollapsed(S.sel) && tabIndentOn(S) && tabIndents(S, f)) { indentByTab(S, f); return; }
  const [a, b] = ordered(S.sel);
  const samePara = samePath(S.sel.anchor.path, S.sel.focus.path);
  const wholePara = !isCollapsed(S.sel) && samePara && a.off === 0 && paraAt(S, a)?.text.length === b.off;
  if (!isCollapsed(S.sel) && (!samePara || wholePara)) { indent(S, 1); return; }
  insChar(S, '\t');
}

/** Shift+Tab (back_tab): previous table cell, list level up, or outdent. */
export function backTab(S) {
  const cell = cellOf(S.sel.focus.path);
  if (cell) {
    const [tpath, r, c] = cell;
    const story = S.sel.focus.story;
    let nr, nc;
    if (c > 0) [nr, nc] = [r, c - 1];
    else if (r > 0) [nr, nc] = [r - 1, Math.max((S.d.table(story, tpath)?.rows[r - 1]?.cells.length ?? 1) - 1, 0)];
    else return;
    S.sel = caret({story, path: [...tpath, nr, nc, 0], off: 0});
    return;
  }
  const f = S.sel.focus;
  const n = paraAt(S, f)?.props?.numbering;
  if (n && n.num !== 0) {
    setPara(S, f.story, f.path, pr => ({...pr, numbering: {num: n.num, level: Math.max(n.level - 1, 0)}}));
    return;
  }
  indent(S, -1);
}
