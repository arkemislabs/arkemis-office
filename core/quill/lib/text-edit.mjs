// The editing primitives every typing, deleting and pasting command shares: the formatting typed
// text gets, tracked insertions and deletions, deleting the selection, inserting typed or pasted
// text, splitting a paragraph as Enter does, leaving a list, joining paragraphs; the content
// control rules for typing and deleting; and where typing goes in a protected document.
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd.rs            delete_selection(_effect), new_revision, has_next_para,
//                                       join_next_para, remove_empty_para, track_delete_would_change,
//                                       track_delete(_as), type_text, paste_text, insert_text,
//                                       direction_unset, leave_list, split_para(_as), selected_paths
//   crates/engine/src/session/query.rs  typing_props, caret_props
//   crates/engine/src/cmd/controls.rs   prepare_edit, refuses_paragraph, check_delete(s),
//                                       check_edit, restore_placeholder (and the placeholder style)
//   crates/engine/src/cmd/protect.rs    enforced, typing_pos
//   crates/engine/src/cmd/para/format.rs indent, outdent (Tab, Shift+Tab, Backspace at a start)
//   crates/engine/src/prefs.rs          the typing options (Typing replaces selected text, overtype)
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `S` is the Session from caret-session.mjs. Positions are {story, path, off} (UTF-16 offsets).

import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {resolvePara, getStyle, style as makeStyle, upsertStyle} from '../model/styles.mjs';
import {charUnlinked, charWithoutSymbol, paraCancelCharIndents} from '../model/props.mjs';
import {firstStrongIsRtl} from '../model/text.mjs';
import {lockCanEdit, lockCanDelete, controlTakesTyping, placeholderShown, controlContentStart, controlIsEmpty} from '../model/ranges.mjs';
import {caret, isCollapsed, ordered, samePos, samePath, at, withLast, cmpPos} from './caret-session.mjs';
import {defaultAutoCorrect} from './text-autocorrect.mjs';

const OBJ = P.OBJ;

// ---- preferences -------------------------------------------------------------------------------

/** File › Options settings typing reads (upstream Prefs::default). */
export function typingPrefs(prefs) {
  const p = prefs ?? {};
  return {
    typingReplacesSelection: p.typingReplacesSelection ?? true,
    overtype: !!p.overtype,
    autocorrect: {...defaultAutoCorrect(), ...(p.autocorrect && typeof p.autocorrect === 'object' ? p.autocorrect : {})},
    trackFormatting: p.markup?.trackFormatting ?? true,
  };
}

export const paraAt = (S, p) => S.d.paraAt(p);
export const rp = (S, para) => resolvePara(S.d.c.styles, para.props);
/** Whether this person's changes are tracked: the document's Track Changes, or Track Changes › Just Mine (U:quill/review). */
export const trackChanges = S => !!S.d.c.settings?.trackChanges || !!S.ctx?.view?.trackMine;

// ---- formatting at the caret (session/query.rs) ---------------------------------------------------

const noteRefStyle = s => s === 'FootnoteReference' || s === 'EndnoteReference';

/** The caret's formatting, as Reveal Formatting shows it (caret_props). */
export function caretProps(S) {
  if (S.view.pending) return {...S.view.pending};
  const f = S.sel.focus;
  const p = paraAt(S, f);
  if (!p) return {};
  const props = P.propsAt(p, f.off) ?? {};
  const insideLink = !!props.link && f.off > 0 && f.off < p.text.length && P.propsOfChar(p, f.off)?.link === props.link;
  const out = charWithoutSymbol(props.link && !insideLink ? charUnlinked(props) : {...props});
  if (noteRefStyle(out.style)) delete out.style;
  return out;
}

/** The formatting typed text gets: over a selection, its first character's (typing_props). */
export function typingProps(S) {
  const [a] = ordered(S.sel);
  const p = paraAt(S, a);
  let c;
  if (p && !S.view.pending && !isCollapsed(S.sel) && a.off < p.text.length) {
    const props = P.propsOfChar(p, a.off) ?? {};
    c = props.link ? charUnlinked(props) : {...props};
    if (noteRefStyle(c.style)) delete c.style;
  } else c = caretProps(S);
  delete c.rtl;
  return c;
}

// ---- revisions (cmd.rs) ------------------------------------------------------------------------

/** A revision record for the current author: reuses one of the same kind and second (new_revision). */
export function newRevision(S, kind) {
  const date = S.now();
  const held = S.view.pendingMove?.rev ?? null;
  const list = S.d.c.revisions ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.kind === kind && r.author === S.author && r.date === date && !r.moveName && held !== i) return i;
  }
  S.d.updateField('revisions', rs => [...(rs ?? []), {kind, author: S.author, date}]);
  return S.d.c.revisions.length - 1;
}

/** Is the paragraph at `path` followed by another paragraph in its container? (has_next_para) */
export function hasNextPara(S, story, path) {
  return S.d.block(story, withLast(path, path[path.length - 1] + 1))?.kind === 'para';
}

export function setMark(S, story, path, f) {
  const p = S.d.paraMut(story, path);
  const m = f({...(p.mark ?? {})}) ?? {};
  for (const k of Object.keys(m)) if (m[k] === undefined || m[k] === null) delete m[k];
  if (Object.keys(m).length) p.mark = m; else delete p.mark;
}

export function setPara(S, story, path, f) {
  const p = S.d.paraMut(story, path);
  const props = f({...(p.props ?? {})}) ?? {};
  for (const k of Object.keys(props)) if (props[k] === undefined || props[k] === null) delete props[k];
  if (Object.keys(props).length) p.props = props; else delete p.props;
  return p;
}

/** Remove the paragraph mark at `path`: the next paragraph joins it, keeping its mark's revisions (join_next_para). */
export function joinNextPara(S, story, path) {
  if (!hasNextPara(S, story, path)) return false;
  const next = withLast(path, path[path.length - 1] + 1);
  const len = S.d.para(story, path)?.text.length ?? 0;
  const nm = S.d.para(story, next)?.mark ?? {};
  S.d.deleteRange({story, path, off: len}, {story, path: next, off: 0});
  setMark(S, story, path, m => ({...m, ins: nm.ins, del: nm.del}));
  return true;
}

/** Remove an empty paragraph without a section break when another follows (remove_empty_para). */
export function removeEmptyPara(S, story, path) {
  const p = S.d.para(story, path);
  if (!p || p.text.length || p.section || !hasNextPara(S, story, path)) return false;
  S.d.removeBlock(story, path);
  return true;
}

const ownRevision = (S, i) => i !== undefined && i !== null && S.d.c.revisions?.[i]?.author === S.author;

/** Would a tracked deletion of a..b change anything? (track_delete_would_change) */
export function trackDeleteWouldChange(S, a, b) {
  for (const path of S.d.pathsBetween(a, b)) {
    const p = S.d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0;
    const to = samePath(path, b.path) ? b.off : p.text.length;
    if (P.runRanges(p).some(([s, e, c]) => e > from && s < to && (c?.del ?? null) === null)) return true;
    if (!samePath(path, b.path) && hasNextPara(S, a.story, path) && (p.mark?.del ?? null) === null) return true;
  }
  return false;
}

/** Tracked deletion marking with revision `rid`: own insertions go, the rest is marked (track_delete_as). */
export function trackDeleteAs(S, a, b, rid) {
  let changed = false;
  const paths = S.d.pathsBetween(a, b);
  for (const path of [...paths].reverse()) {
    const p = S.d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0;
    const to = samePath(path, b.path) ? b.off : p.text.length;
    const ranges = P.runRanges(p).filter(([s, e, c]) => e > from && s < to && (c?.del ?? null) === null)
      .map(([s, e, c]) => [Math.max(s, from), Math.min(e, to), ownRevision(S, c?.ins)]);
    for (const [x, y, mine] of ranges.reverse()) {
      if (mine) S.d.deleteRange({story: a.story, path, off: x}, {story: a.story, path, off: y});
      else S.d.formatRange({story: a.story, path, off: x}, {story: a.story, path, off: y}, c => ({...c, del: rid}));
      changed = true;
    }
    if (!samePath(path, b.path) && hasNextPara(S, a.story, path)) {
      const m = S.d.para(a.story, path)?.mark ?? {};
      if ((m.del ?? null) === null) {
        if (ownRevision(S, m.ins)) joinNextPara(S, a.story, path);
        else setMark(S, a.story, path, mk => ({...mk, del: rid}));
        changed = true;
      }
    }
  }
  return {at: at(a, a.off), changed};
}

/** Tracked deletion with a new revision (track_delete). */
export function trackDelete(S, a, b) {
  if (!trackDeleteWouldChange(S, a, b)) return at(a, a.off);
  return trackDeleteAs(S, a, b, newRevision(S, 'delete')).at;
}

/** Delete the selection, respecting Track Changes and content controls (delete_selection_effect). */
export function deleteSelectionEffect(S) {
  const [a, b] = ordered(S.sel);
  if (samePos(a, b)) return {at: a, contentChanged: false};
  checkDelete(S, a, b);
  let eff;
  if (trackChanges(S)) {
    if (!trackDeleteWouldChange(S, a, b)) eff = {at: a, contentChanged: false};
    else { const r = trackDeleteAs(S, a, b, newRevision(S, 'delete')); eff = {at: r.at, contentChanged: r.changed}; }
  } else eff = {at: S.d.deleteRange(a, b), contentChanged: true};
  S.sel = caret(eff.at);
  return eff;
}

export const deleteSelection = S => deleteSelectionEffect(S).at;

/** The paragraphs the selection covers (selected_paths). */
export function selectedPaths(S) {
  const [a, b] = ordered(S.sel);
  return S.d.paraPathsIn(a, b);
}

// ---- inserting text (cmd.rs insert_text) --------------------------------------------------------

/** Is the paragraph still without letters and without a direction anywhere? (direction_unset) */
function directionUnset(S, pos) {
  const p = paraAt(S, pos);
  if (!p) return false;
  if (p.props?.bidi !== undefined || /\p{L}/u.test(p.text) || S.d.c.styles?.defaultPara?.bidi !== undefined) return false;
  for (let id = p.props?.style ?? 'Normal', n = 0; id && n < 64; n++) {
    const st = getStyle(S.d.c.styles, id);
    if (!st) break;
    if (st.para?.bidi !== undefined) return false;
    id = st.basedOn;
  }
  return true;
}

/**
 * Typed (`enter`) or pasted text at the selection: field ends, protection and content controls,
 * the selection deleted, tracked insertion, a paragraph per \r / U+2029 (insert_text).
 */
export function insertText(S, text, enter = true) {
  let props = typingProps(S);
  if (isCollapsed(S.sel)) S.sel = caret(S.d.pastFieldEnds(S.sel.focus));
  const prepared = prepareEdit(S);
  if (prepared) props = prepared;
  if (!enter) props = charWithoutSymbol(props);
  const deletion = deleteSelectionEffect(S);
  delete props.fmtChange;
  delete props.rtl;
  if (trackChanges(S) && text) { props.ins = newRevision(S, 'insert'); delete props.del; } else { delete props.ins; delete props.del; }
  let pos = S.sel.focus;
  let first = true, inserted = false;
  const noBreaks = enter && refusesParagraph(S);
  for (const part0 of text.split(/[\r\u2029]/)) {
    if (!first && !noBreaks) { pos = splitParaAs(S, pos, enter); inserted = true; }
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
  return {contentChanged: deletion.contentChanged || inserted, stateChanged: deletion.contentChanged || inserted || !!prepared};
}

/** type_text: typed text (a \r is Enter). */
export const typeText = (S, text) => insertText(S, text, true);
/** paste_text: pasted plain text (its paragraph separators keep an empty list item). */
export const pasteText = (S, text) => insertText(S, text, false);

// ---- paragraphs (cmd.rs) -------------------------------------------------------------------------

/** Take a paragraph out of its list as Enter or Backspace ends a list (leave_list). */
export function leaveList(S, story, path) {
  setPara(S, story, path, pr => {
    if (pr.style === 'ListParagraph') { delete pr.style; delete pr.numbering; } else pr.numbering = {num: 0, level: 0};
    delete pr.indentLeft; delete pr.indentFirst; delete pr.indentLeftChars; delete pr.indentFirstChars;
    return pr;
  });
}

/** Split the paragraph at `pos` as Enter does (split_para). */
export const splitPara = (S, pos) => splitParaAs(S, pos, true);

/** split_para_as: without `enter` an empty list item splits like any other paragraph. */
export function splitParaAs(S, pos, enter) {
  const p = paraAt(S, pos);
  if (!p) throw new CommandError('failed', 'no paragraph at caret');
  const atEnd = pos.off >= p.text.length;
  const style = p.props?.style ?? null;
  const num = p.props?.numbering ?? rp(S, p).numbering ?? null;
  if (enter && num && num.num !== 0 && p.text.length === 0) {
    // Enter on an empty list item: a nested item moves up a level, a top-level one ends the list.
    if (num.level > 0) setPara(S, pos.story, pos.path, pr => ({...pr, numbering: {num: num.num, level: num.level - 1}}));
    else leaveList(S, pos.story, pos.path);
    return at(pos, pos.off);
  }
  const markRevs = {ins: p.mark?.ins, del: p.mark?.del};
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
    const rid = newRevision(S, 'insert');
    setMark(S, pos.story, pos.path, m => ({...m, ins: rid}));
    // The paragraph after the split ends with the original mark and keeps its revisions.
    setMark(S, nw.story, nw.path, m => ({...m, ins: markRevs.ins, del: markRevs.del}));
  }
  return nw;
}

// ---- indent (para/format.rs) ----------------------------------------------------------------------

/** Increase (dir > 0) or decrease indent of the selected paragraphs (indent / outdent). */
export function indent(S, dir) {
  const [a] = ordered(S.sel);
  const tab = Math.max(S.d.c.settings?.defaultTab ?? 36, 1);
  for (const path of selectedPaths(S)) {
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

// ---- protection (protect.rs) -----------------------------------------------------------------------

/** Is the document protected? (enforced) */
export const enforced = S => !!S.d.c.settings?.protection;

const editableBy = (r, author) => String(r.group ?? '').toLowerCase() === 'everyone' || (!!r.editor && String(r.editor).toLowerCase() === author.trim().toLowerCase());

/** Typing in a read-only or comments-only document goes inside the editable range the caret touches (typing_pos). */
export function protectTypingPos(S, p) {
  const mode = S.d.c.settings?.protection;
  if (mode !== 'readOnly' && mode !== 'comments') return p;
  const para = paraAt(S, p);
  if (!para || !para.objects?.length) return p;
  const editable = new Set(S.d.permRanges().filter(r => editableBy(r, S.author)).map(r => r.id));
  const objAt = off => (para.text[off] === OBJ ? P.objectAt(para, off) : null);
  const isStart = off => { const o = objAt(off); return o?.type === 'permStart' && editable.has(o.id); };
  const isEnd = off => { const o = objAt(off); return o?.type === 'permEnd' && editable.has(o.id); };
  let off = p.off;
  if (isStart(off)) { while (isStart(off)) off += 1; return at(p, off); }
  while (off >= 1 && isEnd(off - 1)) off -= 1;
  return at(p, off);
}

// ---- content controls (controls.rs) ---------------------------------------------------------------

export const CANT_DELETE = "This content control can't be deleted.";
export const CANT_EDIT = "The contents of this content control can't be edited.";
const PLACEHOLDER_STYLE = 'PlaceholderText';
const PLACEHOLDER_STYLE_NAME = 'Placeholder Text';

function locked(S, msg) {
  S.view.status = msg;
  return new CommandError('failed', msg);
}

function placeholderStyleId(S) {
  const st = (S.d.c.styles?.styles ?? []).find(x => x.kind === 'character' && String(x.name ?? '').toLowerCase() === PLACEHOLDER_STYLE_NAME.toLowerCase());
  return st?.id ?? PLACEHOLDER_STYLE;
}

function ensurePlaceholderStyle(S) {
  const id = placeholderStyleId(S);
  if (getStyle(S.d.c.styles, id)) return id;
  S.d.updateField('styles', sh => upsertStyle(sh, makeStyle({id: PLACEHOLDER_STYLE, name: PLACEHOLDER_STYLE_NAME, kind: 'character',
    basedOn: 'DefaultParagraphFont', chr: {color: {Rgb: [0x66, 0x66, 0x66]}}, priority: 99, builtin: true})));
  return PLACEHOLDER_STYLE;
}

function contentProps(S, base) {
  const p = {...(base ?? {})};
  if (p.style === PLACEHOLDER_STYLE || p.style === placeholderStyleId(S)) delete p.style;
  return p;
}

function contentBase(S, r) {
  const a = controlContentStart(r);
  const para = paraAt(S, a);
  const props = para ? (controlIsEmpty(r, samePath) ? P.propsOfChar(para, r.start.off) : P.propsOfChar(para, a.off)) ?? {} : {};
  return contentProps(S, props);
}

const containsPos = (r, p) => cmpPos(controlContentStart(r), p) <= 0 && cmpPos(p, r.end) <= 0;

/**
 * Before text goes in: refuse what a locked or list-only control doesn't take; a control showing
 * its placeholder gets the placeholder selected and stops showing it. Returns the formatting the
 * text should get, when it changes (prepare_edit).
 */
export function prepareEdit(S) {
  if (isCollapsed(S.sel)) {
    const p = protectTypingPos(S, S.d.typingPos(S.sel.focus));
    if (!samePos(p, S.sel.focus)) S.sel = caret(p);
  }
  for (let i = 0; i < 16 && isCollapsed(S.sel); i++) {
    const f = S.sel.focus;
    const r = S.d.controlAt(f);
    if (!r) break;
    if (lockCanEdit(r.control.lock) && controlTakesTyping(r.control.kind)) break;
    if (samePos(f, r.end)) S.sel = caret(at(r.end, r.end.off + 1));
    else if (samePos(f, controlContentStart(r))) S.sel = caret(at(r.start, r.start.off));
    else break;
  }
  const [a, b] = ordered(S.sel);
  const r = S.d.controlAt(a);
  if (!r) return null;
  if (!lockCanEdit(r.control.lock)) throw locked(S, CANT_EDIT);
  if (!controlTakesTyping(r.control.kind)) {
    const t = r.control.kind?.type;
    throw locked(S, t === 'checkBox' ? 'Click the check box (or use Toggle Check Box) to change it.' : t === 'dropDown' ? 'Choose an entry from the list.' : 'This content control holds a picture.');
  }
  if (!r.control.showingPlaceholder || !containsPos(r, b)) return null;
  const props = r.control.runProps ? contentProps(S, r.control.runProps) : (() => { const c = contentBase(S, r); delete c.style; return c; })();
  S.sel = {anchor: controlContentStart(r), focus: at(r.end, r.end.off)};
  S.d.updateControl(r.start, c => { c.showingPlaceholder = false; });
  return props;
}

/** Enter in a one-line plain text control, a check box or a list does nothing (refuses_paragraph). */
export function refusesParagraph(S) {
  const r = S.d.controlAt(S.sel.focus);
  const k = r?.control?.kind;
  return !!k && ((k.type === 'text' && !(k.multiLine ?? k.multi_line)) || k.type === 'checkBox' || k.type === 'dropDown');
}

/** Before deletions in `story`: refuse deleting a locked control or editing locked content (check_deletions). */
export function checkDeletions(S, story, list) {
  const controls = S.d.controlRanges(story);
  if (!controls.length) return;
  for (const [a, b] of list) {
    if (a.story !== story || b.story !== story) continue;
    for (const r of controls) {
      const whole = cmpPos(a, r.start) <= 0 && cmpPos(at(r.end, r.end.off + 1), b) <= 0;
      const cs = controlContentStart(r);
      const touches = cmpPos(a, r.end) < 0 && cmpPos(b, cs) > 0;
      if (whole && !lockCanDelete(r.control.lock)) throw locked(S, CANT_DELETE);
      if (!whole && touches && !lockCanEdit(r.control.lock)) throw locked(S, CANT_EDIT);
    }
  }
}

/** check_delete */
export const checkDelete = (S, a, b) => checkDeletions(S, a.story, [[a, b]]);

/** Before rewriting a..b in place: refuse touching content a control locks (check_edit). */
export function checkEdit(S, a, b) {
  if (a.story !== b.story) return;
  const refused = S.d.controlRanges(a.story).some(r => {
    const cs = controlContentStart(r);
    return !lockCanEdit(r.control.lock) && cmpPos(a, r.end) < 0 && cmpPos(b, cs) > 0;
  });
  if (refused) throw locked(S, CANT_EDIT);
}

/** After a deletion: a control left empty shows its placeholder again (restore_placeholder). */
export function restorePlaceholder(S) {
  const r = S.d.controlAt(S.sel.focus);
  if (!r || !controlIsEmpty(r, samePath) || r.control.showingPlaceholder) return;
  const text = placeholderShown(r.control);
  if (!text) return;
  const base = contentBase(S, r);
  const style = ensurePlaceholderStyle(S);
  const props = {...base, style};
  delete props.link;
  S.d.insertText(controlContentStart(r), text, props);
  S.d.updateControl(r.start, c => { c.showingPlaceholder = true; });
  S.sel = caret(controlContentStart(r));
}

export {OBJ, ensurePlaceholderStyle, contentProps, contentBase};
