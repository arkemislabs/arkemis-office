// In-place text editing: entering and leaving text (shapes, table cells, speaker notes), typing
// with AutoCorrect and smart quotes, input-method commits, deleting by character and word, caret
// movement and text selection, setting and reading a shape's text, AutoCorrect options, and the
// fonts used in the presentation with Replace Fonts.
// Translated from deckcraft crates/engine/src/cmd/text.rs (`specs`, `body_of`, `edit_text`),
// crates/engine/src/cmd/text/editing.rs (`edit`, `exit`, `insert_text`, `inherited_aligns`,
// `promote_rtl_if_needed`, `unlinked_at_link_end`, `paste_body`), crates/engine/src/cmd/text/caret.rs
// (`insert`, `delete_dir`, `delete`, `para_rtl`, `move_caret`, `select`, `select_all`,
// `select_word`, `select_para`, `apply_leading_tabs`, `set`, `get`), crates/engine/src/cmd/text/ime.rs
// (`ime_text`, `commit`), crates/engine/src/cmd/text/formatting.rs (`fonts_used`, `replace_font`) and
// crates/engine/src/fonts.rs (`used_fonts`, `body_fonts`, `replace_font`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2, textSelection, slideById, shapeJsonPath} from '../model/doc.mjs';
import {findShape, walk} from '../model/presentation.mjs';
import {paraText, paraLen, bodyFromText, bodyText, promoteLeadingTabs} from '../model/text.mjs';
import {remove, insert, insertBody, propsAt, charMove, wordMove, wordAt, paraUp, paraDown, end as bodyEnd, deleteWord} from '../model/edit.mjs';
import {firstStrongIsRtl} from '../model/bidi.mjs';
import {ctxForSlide, para as resolvePara, run as resolveRun, fontFamily} from '../model/resolve.mjs';
import {themeFont} from '../model/theme.mjs';
import {
  bad, hasDoc, hasSlide, hasText, always, NO_TEXT_POINT, idParam, posParam, cellParam, selectionOf, bodyOf, bodyPath, textPositions,
  setTextSelection, editText, layoutFor, fitTextBox, ordered, samePos, selectShapeIds, selectSlideList, UPSTREAM_COMMIT,
} from '../lib/text-session.mjs';
import {typed, autocorrect, undoAutoList, autocorrectOptions} from '../lib/text-autocorrect.mjs';
import {
  imeText, activeRange, countParam, compositionFits, committedBody, modelPos, walkBackward, walkForward, remapAfterDelete,
} from '../lib/text-ime.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/text.rs', 'crates/engine/src/lib.rs', 'crates/engine/src/cmd/text/editing.rs',
  'crates/engine/src/cmd/text/caret.rs', 'crates/engine/src/cmd/text/ime.rs', 'crates/engine/src/cmd/text/autocorrect.rs',
  'crates/engine/src/cmd/text/formatting.rs', 'crates/engine/src/cmd/text/layout.rs', 'crates/engine/src/fonts.rs']};

const pos = s.array(s.integer({min: 0}), {min: 2, max: 2, description: '[paragraph, character] (UTF-16 offset in the paragraph)'});
const shapeId = s.union([s.string({min: 1, max: 64}), s.integer({min: 0, max: 4294967295})], {description: 'Shape id'});
const MOVES = ['left', 'right', 'up', 'down', 'wordLeft', 'wordRight', 'lineStart', 'lineEnd', 'paraStart', 'paraEnd', 'paraUp', 'paraDown', 'start', 'end'];

// ---------------------------------------------------------------------------------------------
// Typing (editing.rs)

/** deckcraft `inherited_aligns`: per level, whether the shape already resolves an alignment. */
function inheritedAligns(c, t) {
  const out = new Array(9).fill(false);
  if (!t || t.notes) return out;
  const sl = slideById(c, t.slide);
  const sh = sl && findShape(sl.shapes, t.shape);
  const rctx = sl && ctxForSlide(c, sl);
  if (!sh || !rctx) return out;
  for (let lvl = 0; lvl < 9; lvl++) out[lvl] = resolvePara(rctx, sh, {level: lvl, runs: []}).align != null;
  return out;
}

/** deckcraft `promote_rtl_if_needed`: a paragraph whose first strong character is right-to-left becomes RTL (and right-aligned unless an alignment is set or inherited). */
export function promoteRtl(p, inherited) {
  const pr = p.props ?? {};
  if (pr.rtl != null || !firstStrongIsRtl(paraText(p))) return p;
  const props = {...pr, rtl: true};
  if (pr.align == null && !inherited[p.level ?? 0]) props.align = 'right';
  return {...p, props};
}
const promoteRange = (body, from, to, inherited) => ({...body, paragraphs: body.paragraphs.map((p, i) => (i >= from && i <= to ? promoteRtl(p, inherited) : p))});

/** deckcraft `unlinked_at_link_end`: typing right after a hyperlink doesn't extend it. */
function unlinkedAtLinkEnd(body, at) {
  const props = propsAt(body, at);
  if (!props.link) return undefined;
  const len = body.paragraphs?.[at[0]] ? paraLen(body.paragraphs[at[0]]) : 0;
  if (at[1] < len && JSON.stringify(propsAt(body, [at[0], at[1] + 1]).link) === JSON.stringify(props.link)) return undefined;
  delete props.link;
  return props;
}

/** deckcraft `insert_text`: replace the selection with `text` (`\n` paragraph, U+000B line break). */
export function insertText(ctx, cmd, textIn, {props: given, correct = true} = {}) {
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) throw bad(cmd, NO_TEXT_POINT);
  const inherited = inheritedAligns(ctx.doc, t);
  const body0 = bodyOf(ctx.doc, t) ?? {body: {}, paragraphs: []};
  const text = typed(ctx.prefs, body0, ordered(...Object.values(textPositions(body0, t)))[0], textIn);
  editText(ctx, cmd, (body, sel) => {
    const [a, b] = ordered(sel.anchor, sel.caret);
    const r = remove(body, a, b);
    const at = r.pos;
    const props = given ?? (!samePos(a, b) ? propsAt(r.body, at) : unlinkedAtLinkEnd(r.body, at));
    const ins = insert(r.body, at, text, props);
    sel.anchor = ins.pos;
    sel.caret = ins.pos;
    return {body: promoteRange(ins.body, at[0], ins.pos[0], inherited)};
  });
  if (correct) autocorrect(ctx, [...text].length === 1);
  const t2 = textSelection(ctx.doc, ctx.selection);
  const b2 = t2 && bodyOf(ctx.doc, t2);
  const caret = b2 ? textPositions(b2, t2).caret : [0, 0];
  // Typing a word is one undo step (consecutive characters merge until a space or a new paragraph).
  if (cmd === 'text.insert' && [...text].length === 1 && !/\s/u.test(text)) ctx.mergeUndo(`prism.type:${t.slide}/${t.notes ? 'notes' : t.shape}/${t.cell ?? ''}`);
  return {caret};
}

/** deckcraft `paste_body`: replace the selection with a formatted body (RTL promoted). */
export function pasteBody(ctx, cmd, src) {
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) throw bad(cmd, NO_TEXT_POINT);
  const inherited = inheritedAligns(ctx.doc, t);
  let caret = [0, 0];
  editText(ctx, cmd, (body, sel) => {
    const [a, b] = ordered(sel.anchor, sel.caret);
    const r = remove(body, a, b);
    const ins = insertBody(r.body, r.pos, src);
    sel.anchor = ins.pos;
    sel.caret = ins.pos;
    caret = ins.pos;
    return {body: promoteRange(ins.body, r.pos[0], ins.pos[0], inherited)};
  });
  return {caret};
}

// ---------------------------------------------------------------------------------------------
// Input methods (ime.rs; the composition is view state, see core/prism/lib/text-ime.mjs)

/** The pending composition, when it still stands for the selection of the text being edited. */
export function pendingComposition(ctx) {
  const c = ctx.view?.composition;
  if (!c) return null;
  const t = textSelection(ctx.doc, ctx.selection);
  const body = t && bodyOf(ctx.doc, t);
  return t && body && compositionFits(c, t, body, textPositions(body, t)) ? c : null;
}

/** Forget the composition; `settled` counts one the platform must interrupt (deckcraft `composition_settles`). */
function dropComposition(ctx, settled) {
  if (!ctx.view?.composition) return;
  ctx.setView(settled ? {composition: null, compositionSettles: (ctx.view.compositionSettles ?? 0) + 1} : {composition: null});
}

/**
 * Write `text` in place of the composition's range (or of the selection when there is none),
 * with the composition's text props (deckcraft `compose` + `end_composition`): no AutoCorrect,
 * no smart quotes, the caret after it.
 */
function writeComposed(ctx, cmd, text, c) {
  editText(ctx, cmd, (body, sel) => {
    const [a, b] = c ? [c.from, c.to] : ordered(sel.anchor, sel.caret);
    const r = remove(body, a, b);
    const props = c ? (c.props ?? undefined) : (!samePos(a, b) ? propsAt(r.body, r.pos) : unlinkedAtLinkEnd(r.body, r.pos));
    const ins = insert(r.body, r.pos, text, props);
    sel.anchor = ins.pos;
    sel.caret = ins.pos;
    return {body: ins.body};
  });
}

/**
 * deckcraft `settle_composition` before another edit: the pre-edit stays as typed text. A
 * composition that no longer fits (the text changed under it) is dropped; either way the
 * platform's own copy must be interrupted (`view.compositionSettles`).
 */
function settleComposition(ctx, cmd) {
  if (!ctx.view?.composition) return;
  const c = pendingComposition(ctx);
  if (c && c.text) writeComposed(ctx, cmd, c.text, c);
  dropComposition(ctx, true);
}

/** deckcraft `compose`. */
function compose(ctx, p) {
  const text = imeText(p.text);
  const active = activeRange(p.active, text);
  let cur = ctx.view?.composition ?? null;
  // A composition whose text was changed under it is settled; a new one starts.
  if (cur && !pendingComposition(ctx)) { dropComposition(ctx, true); cur = null; }
  const len = [...text].length;
  if (!cur) {
    if (!text) return {composing: false};
    const t = textSelection(ctx.doc, ctx.selection);
    if (!t) throw bad('text.compose', NO_TEXT_POINT);
    const body = bodyOf(ctx.doc, t) ?? {body: {}, paragraphs: []};
    const {anchor, caret} = textPositions(body, t);
    const [a, b] = ordered(anchor, caret);
    const r = remove(body, a, b);
    const props = !samePos(a, b) ? propsAt(r.body, r.pos) : unlinkedAtLinkEnd(r.body, r.pos);
    ctx.setView({composition: {slide: t.slide, shape: t.notes ? null : t.shape, cell: t.cell ?? null, notes: !!t.notes,
      from: a, to: b, text, active, props: props ?? null}});
    return {composing: true, start: a, len};
  }
  // An empty pre-edit cancels: the text and the selection it replaced are as they were.
  if (!text) { ctx.setView({composition: null}); return {composing: false}; }
  ctx.setView({composition: {...cur, text, active}});
  return {composing: true, start: cur.from, len};
}

/** deckcraft `commit`. */
function commitComposition(ctx, p) {
  const text = imeText(p.text);
  if (ctx.view?.composition && !pendingComposition(ctx)) dropComposition(ctx, true);
  const c = pendingComposition(ctx);
  if (c && !text) dropComposition(ctx, false);
  else if (c || text) {
    writeComposed(ctx, 'text.commit', text, c);
    if (c) ctx.setView({composition: null});
    ctx.setUndoLabel('Type Text');
  }
  const t = textSelection(ctx.doc, ctx.selection);
  const b = t && bodyOf(ctx.doc, t);
  return {caret: b ? textPositions(b, t).caret : [0, 0]};
}

/** A position of the committed body (the composition's range taken out) at or after `from`, in the body. */
const pastComposition = (q, from, to) => (q[0] === from[0] ? [to[0], to[1] + (q[1] - from[1])] : [q[0] + (to[0] - from[0]), q[1]]);

/** deckcraft `delete_surrounding` (caret.rs). */
function deleteSurrounding(ctx, p) {
  const cmd = 'text.deleteSurrounding';
  const before = countParam(p, 'before'), after = countParam(p, 'after'), bytes = !!p.bytes;
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) throw bad(cmd, 'not editing text');
  const body = bodyOf(ctx.doc, t);
  if (!body) throw bad(cmd, 'the text being edited is gone');
  const sel = textPositions(body, t);
  const a = modelPos(body, sel.anchor), b = modelPos(body, sel.caret);
  if (!a || !b) throw bad(cmd, 'the selection is not in the text');
  // The selection (or the pre-edit) stays where it is; only whole scalars fully inside the
  // requested ranges around it go, in the logical text input methods are given.
  const c = pendingComposition(ctx);
  const view = c ? committedBody(body, c) : body;
  const [start, end] = c ? [c.from, c.from] : ordered(a, b);
  const [from, beforeChars] = walkBackward(view, start, before, bytes);
  const [toView, afterChars] = walkForward(view, end, after, bytes);
  if (!beforeChars && !afterChars) return {deleted: 0};
  const endInBody = c ? c.to : end;
  const to = c ? pastComposition(toView, c.from, c.to) : toView;
  editText(ctx, cmd, (bd, s) => {
    // The after-range first, so the earlier positions stay valid; then the text before.
    let nb = bd;
    if (afterChars) nb = remove(nb, endInBody, to).body;
    if (beforeChars) nb = remove(nb, from, start).body;
    s.anchor = remapAfterDelete(s.anchor, start, from);
    s.caret = remapAfterDelete(s.caret, start, from);
    return {body: nb};
  });
  if (c) ctx.setView({composition: {...c, from: remapAfterDelete(c.from, start, from), to: remapAfterDelete(c.to, start, from)}});
  ctx.setUndoLabel('Delete Text');
  return {deleted: beforeChars + afterChars};
}

// ---------------------------------------------------------------------------------------------
// Deleting and moving (caret.rs)

/** deckcraft `delete_dir`. */
export function deleteDir(ctx, cmd, dir) {
  if (dir === 'backward' && undoAutoList(ctx)) return {};
  if (ctx.view?.autoList) ctx.setView({autoList: null});
  editText(ctx, cmd, (body, sel) => {
    const [a, b] = ordered(sel.anchor, sel.caret);
    let r;
    if (dir === 'wordBackward' || dir === 'wordForward') {
      // Ctrl+Backspace/Delete work from the start of a selection and leave the rest of it (PowerPoint for Windows).
      r = deleteWord(body, a, dir === 'wordForward');
    } else if (!samePos(a, b)) r = remove(body, a, b);
    else if (dir === 'forward') r = remove(body, a, charMove(body, a, true));
    else {
      // Backspace at the start of an indented/bulleted paragraph outdents first.
      const p = body.paragraphs?.[a[0]];
      if (a[1] === 0 && p && (p.level ?? 0) > 0) {
        const paragraphs = [...body.paragraphs];
        paragraphs[a[0]] = {...p, level: p.level - 1};
        sel.anchor = a;
        sel.caret = a;
        return {body: {...body, paragraphs}};
      }
      r = remove(body, a, charMove(body, a, false));
    }
    sel.anchor = r.pos;
    sel.caret = r.pos;
    return {body: r.body};
  });
  return {};
}

/** The layout line holding `pos` with affinity (deckcraft `line_index`). */
function lineIndex(l, [pi, ch], upstream) {
  const lines = l.lines;
  if (upstream && ch > 0) {
    for (let i = 0; i + 1 < lines.length; i++) if (lines[i].para === pi && lines[i + 1].para === pi && lines[i + 1].offsetStart === ch) return i;
  }
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i];
    if (li.para !== pi) continue;
    if (ch >= li.offsetStart && (ch < li.offsetEnd || (ch === li.offsetEnd && (i + 1 >= lines.length || lines[i + 1].para !== pi || lines[i + 1].offsetStart !== ch)))) return i;
    found = i;
  }
  return found;
}
/** Caret x on a line for a paragraph offset. */
function caretXOn(li, ch) {
  const k = li.offsets.findIndex(o => o >= ch);
  return k < 0 ? li.caretX[li.caretX.length - 1] : li.caretX[k];
}
/** The offset on a line nearest x (deckcraft `hit` restricted to that line). */
function nearestOn(li, x) {
  let bi = 0, bd = Infinity;
  li.caretX.forEach((cx, k) => { const d = Math.abs(cx - x); if (d < bd) { bd = d; bi = k; } });
  return li.offsets[bi] ?? li.offsetStart;
}

/** deckcraft `move_caret`. */
function moveCaret(ctx, p) {
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) throw bad('text.move', 'not editing text');
  const body = bodyOf(ctx.doc, t) ?? {body: {}, paragraphs: []};
  const {anchor, caret} = textPositions(body, t);
  const extend = !!p.extend;
  const upstreamAff = Array.isArray(ctx.view?.textLineEnd) && samePos(ctx.view.textLineEnd, caret);
  const l = ['up', 'down', 'lineStart', 'lineEnd', 'left', 'right', 'wordLeft', 'wordRight'].includes(p.to) ? layoutFor(ctx.doc, t, ctx.host, body) : null;
  // Left and right are on screen: in a right-to-left paragraph left goes forward in the text.
  const line0 = l?.lines.find(x => x.para === caret[0]);
  const rtl = line0 ? !!line0.rtl : !!body.paragraphs?.[caret[0]]?.props?.rtl;
  let to = p.to ?? 'right';
  if (rtl) to = {left: 'right', right: 'left', wordLeft: 'wordRight', wordRight: 'wordLeft'}[to] ?? to;
  const range = !samePos(anchor, caret);
  const [first, last] = ordered(anchor, caret);
  let upstream = false;
  let next;
  switch (to) {
    case 'left': next = range && !extend ? first : charMove(body, caret, false); break;
    case 'right': next = range && !extend ? last : charMove(body, caret, true); break;
    // Ctrl+arrows with a selection go on from its start (left) or end (right).
    case 'wordLeft': next = wordMove(body, extend ? caret : first, false); break;
    case 'wordRight': next = wordMove(body, extend ? caret : last, true); break;
    case 'paraStart': next = [caret[0], 0]; break;
    case 'paraEnd': next = [caret[0], body.paragraphs?.[caret[0]] ? paraLen(body.paragraphs[caret[0]]) : 0]; break;
    case 'paraUp': next = paraUp(body, caret); break;
    case 'paraDown': next = paraDown(body, caret); break;
    case 'start': next = [0, 0]; break;
    case 'end': next = bodyEnd(body); break;
    case 'up': case 'down': case 'lineStart': case 'lineEnd': {
      const li = l ? lineIndex(l, caret, upstreamAff) : -1;
      if (l && li >= 0) {
        const line = l.lines[li];
        if (to === 'up' || to === 'down') {
          const target = l.lines[to === 'down' ? li + 1 : li - 1];
          if (!target) { next = caret; upstream = upstreamAff; break; }
          const x = caret[1] > line.offsetEnd ? line.caretX[line.caretX.length - 1] : caretXOn(line, caret[1]);
          next = [target.para, Math.min(Math.max(nearestOn(target, x), target.offsetStart), target.offsetEnd)];
        } else if (to === 'lineStart') next = [line.para, line.offsetStart];
        else {
          // End stays on its line: after a soft wrap the caret sits at the line's end.
          const n = l.lines[li + 1];
          if (n && n.para === line.para && n.offsetStart > line.offsetStart) { next = [line.para, n.offsetStart]; upstream = true; }
          else next = [line.para, line.offsetEnd];
        }
      } else {
        const n = body.paragraphs?.length ?? 0;
        if (to === 'up') next = [Math.max(caret[0] - 1, 0), caret[1]];
        else if (to === 'down') next = [Math.min(caret[0] + 1, Math.max(n - 1, 0)), caret[1]];
        else if (to === 'lineStart') next = [caret[0], 0];
        else next = [caret[0], body.paragraphs?.[caret[0]] ? paraLen(body.paragraphs[caret[0]]) : 0];
      }
      break;
    }
    default: throw bad('text.move', `unknown direction \`${to}\``, {path: '/to'});
  }
  const ps = body.paragraphs ?? [];
  const np = Math.min(next[0], Math.max(ps.length - 1, 0));
  next = [np, Math.min(next[1], ps[np] ? paraLen(ps[np]) : 0)];
  setTextSelection(ctx, t, body, extend ? anchor : next, next, {lineEnd: upstream});
  return {caret: next, lineEnd: upstream};
}

/** Text-selection commands that only move the selection (deckcraft `s.select`). */
function selectIn(ctx, cmd, f) {
  const t = textSelection(ctx.doc, ctx.selection);
  if (!t) throw bad(cmd, 'not editing text');
  const body = bodyOf(ctx.doc, t) ?? {body: {}, paragraphs: []};
  const [a, c] = f(body, textPositions(body, t));
  setTextSelection(ctx, t, body, a, c);
  return {};
}

// ---------------------------------------------------------------------------------------------
// Fonts (fonts.rs)

/** deckcraft `used_fonts`: the families the slides' text runs and bullets are drawn in. */
export function usedFonts(c) {
  const out = [];
  const add = f => { const x = String(f ?? '').trim(); if (x && !out.some(o => o.toLowerCase() === x.toLowerCase())) out.push(x); };
  const bodyFonts = (rctx, sh, body) => {
    for (const para of body?.paragraphs ?? []) {
      const runs = (para.runs ?? []).filter(r => (r.text ?? '').trim());
      if (!runs.length) continue;
      for (const r of runs) add(fontFamily(rctx, resolveRun(rctx, sh, para, r.props ?? {})));
      const pp = resolvePara(rctx, sh, para);
      if (pp.bullet?.kind === 'char' && pp.bulletFont) add(themeFont(rctx.master.theme, pp.bulletFont));
    }
  };
  for (const sl of c.slides ?? []) {
    const rctx = ctxForSlide(c, sl);
    if (!rctx) continue;
    walk(sl.shapes, sh => {
      if (sh.text) bodyFonts(rctx, sh, sh.text);
      if (sh.kind?.type === 'table') for (const row of sh.kind.rows ?? []) for (const cell of row.cells ?? []) bodyFonts(rctx, sh, cell.text);
    });
  }
  return out.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
}

/**
 * deckcraft `replace_font`: replace family `from` with `to` wherever it is named explicitly (runs
 * and their east Asian, complex script and symbol faces, bullet fonts, end marks, list styles of
 * shapes, layouts and masters, master text styles, the deck default style, notes, tables and the
 * theme fonts). Returns {pres, n}.
 */
export function replaceFont(presIn, fromIn, toIn) {
  const from = String(fromIn).trim(), to = String(toIn).trim();
  if (!from || !to || from.startsWith('+') || from === to) return {pres: presIn, n: 0};
  const pres = structuredClone(presIn);
  let n = 0;
  const hit = v => typeof v === 'string' && v.trim().toLowerCase() === from.toLowerCase();
  const fixRun = r => { if (!r) return; for (const k of ['font', 'fontEa', 'fontCs', 'fontSym']) if (hit(r[k])) { r[k] = to; n++; } };
  const fixPara = pp => { if (pp && hit(pp.bulletFont)) { pp.bulletFont = to; n++; } };
  const fixList = ls => { for (const lvl of ls?.levels ?? []) if (lvl) { fixPara(lvl.para); fixRun(lvl.run); } };
  const fixBody = b => {
    if (!b) return;
    fixList(b.listStyle);
    for (const p of b.paragraphs ?? []) {
      fixPara(p.props);
      fixRun(p.endProps);
      fixRun(p.defProps);
      for (const r of p.runs ?? []) fixRun(r.props);
    }
  };
  const fixShapes = list => walk(list ?? [], sh => {
    fixBody(sh.text);
    if (sh.kind?.type === 'table') for (const row of sh.kind.rows ?? []) for (const cell of row.cells ?? []) fixBody(cell.text);
  });
  fixList(pres.defaultTextStyle);
  for (const sl of pres.slides ?? []) { fixShapes(sl.shapes); fixBody(sl.notes); }
  let theme = 0;
  for (const m of [...(pres.masters ?? []), pres.notesMaster, pres.handoutMaster].filter(Boolean)) {
    fixShapes(m.shapes);
    for (const ls of [m.titleStyle, m.bodyStyle, m.otherStyle]) fixList(ls);
    for (const lay of m.layouts ?? []) fixShapes(lay.shapes);
    for (const set of [m.theme?.fonts?.major, m.theme?.fonts?.minor]) {
      if (!set) continue;
      for (const k of ['latin', 'ea', 'cs']) if (hit(set[k])) { set[k] = to; theme++; }
      for (const sc of set.scripts ?? []) if (hit(sc.typeface)) { sc.typeface = to; theme++; }
    }
  }
  return {pres, n: n + theme};
}

// ---------------------------------------------------------------------------------------------

export default defineCommands({
  family: 'text',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'font.used', label: 'Fonts in Presentation', risk: 'read',
      description: 'The font families the slides\' text and bullets are drawn in (theme fonts resolved), sorted.',
      params: s.object({}), state: hasDoc,
      run(ctx) { return usedFonts(ctx.doc); },
    },
    {
      id: 'font.replace', label: 'Replace Fonts', risk: 'edit', dialog: 'dialog.replaceFonts',
      description: 'Replace Fonts (Home â€º Editing â€º Replace): every explicit use of family `from` (theme fonts included) becomes `to`; returns how many names changed (0: nothing to replace, no undo step).',
      params: s.object({from: s.string({max: 256}), to: s.string({max: 1000})}),
      state: hasDoc,
      run(ctx, p) {
        const from = String(p.from ?? '').trim(), to = String(p.to ?? '').trim();
        if (!from) throw bad('font.replace', 'missing `from`', {path: '/from'});
        if (!to) throw bad('font.replace', 'missing `to`', {path: '/to'});
        // eslint-disable-next-line no-control-regex
        if (to.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(to)) throw bad('font.replace', '`to` is not a font name', {path: '/to'});
        const {pres, n} = replaceFont(ctx.doc, from, to);
        if (!n) return {replaced: 0};
        for (const k of ['defaultTextStyle', 'slides', 'masters', 'notesMaster', 'handoutMaster']) {
          if (JSON.stringify(pres[k]) !== JSON.stringify(ctx.doc[k])) ctx.change.set([k], pres[k]);
        }
        return {replaced: n};
      },
    },
    {
      id: 'text.edit', label: 'Edit Text', risk: 'edit', shortcut: 'Enter', shortcutContext: 'prism.shape',
      description: 'Start editing text: a shape\'s (`id`, default the selected shape; a shape without text gets an empty body), a table `cell` [row, col], or the speaker `notes`; the caret goes to `at` [paragraph, char] (default the end).',
      params: s.object({id: s.optional(shapeId), at: s.optional(pos), end: s.optional(s.boolean()), cell: s.optional(pos), notes: s.optional(s.boolean())}),
      state: hasSlide,
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('text.edit', 'needs a presentation (schema 2)');
        settleComposition(ctx, 'text.edit');
        const sel = selectionOf(ctx);
        if (!sel.slide) throw bad('text.edit', 'no slides');
        if (p.notes) {
          const notes = sel.slide.notes ?? {body: {}, paragraphs: []};
          const at = bodyEnd(notes);
          setTextSelection(ctx, {slide: sel.slideId, notes: true}, notes, at, at);
          return {};
        }
        const id = idParam(p, 'id', 'text.edit') ?? sel.shapes[0];
        if (!id) throw bad('text.edit', 'select a shape with text');
        const sh = findShape(sel.slide.shapes, id);
        if (!sh) throw bad('text.edit', 'no such shape', {path: '/id'});
        const cell = cellParam(p);
        const k = sh.kind?.type ?? 'shape';
        let body;
        if (k === 'table') {
          if (!cell) throw bad('text.edit', 'say which `cell` of the table', {path: '/cell'});
          const c = sh.kind.rows?.[cell[0]]?.cells?.[cell[1]];
          if (!c) throw bad('text.edit', 'no such cell', {path: '/cell'});
          body = c.text ?? {body: {}, paragraphs: []};
        } else if (k === 'shape' || k === 'connector') body = sh.text ?? {body: {}, paragraphs: []};
        else throw bad('text.edit', 'this object doesn\'t hold text', {path: '/id'});
        const at = posParam(p, 'at') ?? bodyEnd(body);
        // A shape without a text body gets one on first edit.
        if (!sh.text && !(k === 'table' && cell)) ctx.change.set([...shapeJsonPath(ctx.doc, sel.slideId, id), 'text'], {body: {}, paragraphs: []});
        const t = {slide: sel.slideId, shape: id, cell: k === 'table' ? cell : null, notes: false};
        const cur = bodyOf(ctx.doc, t) ?? body;
        setTextSelection(ctx, t, cur, at, at);
        return {id, at};
      },
    },
    {
      id: 'text.exit', label: 'Stop Editing Text', risk: 'read', effect: 'view',
      description: 'Stop editing text (Escape): the shape whose text was edited stays selected.',
      params: s.object({}), state: hasDoc,
      run(ctx) {
        const t = textSelection(ctx.doc, ctx.selection);
        if (!t) return {};
        if (!t.notes) selectShapeIds(ctx, t.slide, [t.shape]);
        else selectSlideList(ctx, [t.slide], t.slide);
        if (ctx.view?.textLineEnd || ctx.view?.autoList) ctx.setView({textLineEnd: null, autoList: null});
        return {};
      },
    },
    {
      id: 'text.autocorrect', label: 'AutoCorrect Options', risk: 'read', effect: 'prefs', dialog: 'dialog.autocorrect',
      description: 'AutoCorrect options (Tools): turn the rules on or off, `add` a [from, to] replacement or `remove` one; returns the options and the replacement list.',
      params: s.object({
        on: s.optional(s.boolean()), twoInitials: s.optional(s.boolean()), sentenceCaps: s.optional(s.boolean()), days: s.optional(s.boolean()),
        capsLock: s.optional(s.boolean()), fractions: s.optional(s.boolean()), ordinals: s.optional(s.boolean()), lists: s.optional(s.boolean()),
        smartQuotes: s.optional(s.boolean()),
        add: s.optional(s.array(s.string({max: 1000}), {min: 2, max: 2})), remove: s.optional(s.string({max: 1000})),
      }),
      state: always,
      run(ctx, p) { return autocorrectOptions(ctx, p); },
    },
    {
      id: 'text.insert', label: 'Type Text', risk: 'edit',
      description: 'Type text at the insertion point, replacing the selected text (\\n = new paragraph, \\u000b = line break); AutoCorrect and smart quotes apply to one typed character.',
      params: s.object({text: s.string({max: 1000000})}),
      state: hasText,
      run(ctx, p) { settleComposition(ctx, 'text.insert'); return insertText(ctx, 'text.insert', p.text); },
    },
    {
      id: 'text.compose', label: 'Compose Text', risk: 'read', effect: 'view',
      description: 'An input method\'s composition (pre-edit) at the insertion point, replacing the selection while it lasts; `active` [start, end] (characters of `text`) is the part being converted. Empty text cancels it: the text and selection are as they were. Nothing is an undo step until text.commit.',
      params: s.object({text: s.string({max: 1000000}), active: s.optional(s.array(s.integer({min: 0}), {min: 2, max: 2}))}),
      state: hasText,
      run(ctx, p) { return compose(ctx, p); },
    },
    {
      id: 'text.commit', label: 'Commit Composition', risk: 'edit',
      description: 'An input method\'s result replaces its composition (or is typed at the insertion point when there is none), as one undo step.',
      params: s.object({text: s.string({max: 1000000})}),
      state: hasText,
      run(ctx, p) { return commitComposition(ctx, p); },
    },
    {
      id: 'text.delete', label: 'Delete Text', risk: 'edit', shortcut: 'Backspace', shortcutContext: 'prism.text',
      description: 'Delete the selected text, or one character backward (Backspace; at the start of an indented paragraph it outdents) or forward (Delete); wordBackward/wordForward (Ctrl+Backspace/Delete) delete a word from the start of a selection.',
      params: s.object({dir: s.optional(s.enum(['backward', 'forward', 'wordBackward', 'wordForward']))}),
      state: hasText,
      run(ctx, p) { settleComposition(ctx, 'text.delete'); return deleteDir(ctx, 'text.delete', p.dir ?? 'backward'); },
    },
    {
      id: 'text.deleteSurrounding', label: 'Delete Surrounding Text', risk: 'edit',
      description: 'An input method removes text around the selection or its composition (press-and-hold accents, dictation): `before` and `after` count characters, or UTF-8 bytes with `bytes`, of the logical text (a paragraph mark or line break is one); only whole characters go, the selection and composition stay.',
      params: s.object({before: s.optional(s.number({min: 0})), after: s.optional(s.number({min: 0})), bytes: s.optional(s.boolean())}),
      state: hasText,
      run(ctx, p) { return deleteSurrounding(ctx, p); },
    },
    {
      id: 'text.move', label: 'Move Insertion Point', risk: 'read', effect: 'view',
      description: 'Move the insertion point (extend: grow the selection): left/right (on screen: in a right-to-left paragraph left goes forward), up/down, word, line, paragraph, start/end of the text.',
      params: s.object({to: s.enum(MOVES), extend: s.optional(s.boolean())}),
      state: hasText,
      run(ctx, p) { return moveCaret(ctx, p); },
    },
    {
      id: 'text.select', label: 'Select Text', risk: 'read', effect: 'view',
      description: 'Select text in the text being edited, from `anchor` to `caret` ([paragraph, char]).',
      params: s.object({anchor: pos, caret: s.optional(pos)}),
      state: hasText,
      run(ctx, p) {
        const a = posParam(p, 'anchor');
        if (!a) throw bad('text.select', 'missing `anchor`', {path: '/anchor'});
        const c = posParam(p, 'caret') ?? a;
        return selectIn(ctx, 'text.select', () => [a, c]);
      },
    },
    {id: 'text.selectAll', label: 'Select All Text', risk: 'read', effect: 'view', description: 'Select all of the text being edited.',
      params: s.object({}), state: hasText, run: ctx => selectIn(ctx, 'text.selectAll', body => [[0, 0], bodyEnd(body)])},
    {id: 'text.selectWord', label: 'Select Word', risk: 'read', effect: 'view', description: 'Select the word at `at` (default the insertion point), as a double-click does.',
      params: s.object({at: s.optional(pos)}), state: hasText,
      run: (ctx, p) => selectIn(ctx, 'text.selectWord', (body, cur) => wordAt(body, posParam(p, 'at') ?? cur.caret))},
    {
      id: 'text.selectParagraph', label: 'Select Paragraph', risk: 'read', effect: 'view',
      description: 'Select the paragraph at `at` (default the insertion point) with its paragraph mark, as a triple-click does.',
      params: s.object({at: s.optional(pos)}), state: hasText,
      run: (ctx, p) => selectIn(ctx, 'text.selectParagraph', (body, cur) => {
        const at0 = posParam(p, 'at') ?? cur.caret;
        const n = body.paragraphs?.length ?? 0;
        // Clamp to the last paragraph so a huge index can neither overflow nor select past the body.
        const pi = Math.min(at0[0], Math.max(n - 1, 0));
        // The paragraph mark is part of the paragraph (PowerPoint's triple-click selects it too).
        const end = pi + 1 < n ? [pi + 1, 0] : [pi, body.paragraphs?.[pi] ? paraLen(body.paragraphs[pi]) : 0];
        return [[pi, 0], end];
      }),
    },
    {
      id: 'text.set', label: 'Set Text', risk: 'edit',
      description: 'Replace a shape\'s whole text (or a table cell\'s), keeping the first run\'s formatting and each paragraph\'s level and formatting; leading tabs set the level.',
      params: s.object({id: s.optional(shapeId), text: s.string({max: 1000000}), cell: s.optional(pos)}),
      state: hasSlide,
      run(ctx, p) {
        settleComposition(ctx, 'text.set');
        const sel = selectionOf(ctx);
        const id = idParam(p, 'id', 'text.set') ?? sel.shapes[0];
        if (!id) throw bad('text.set', 'missing `id` (or select a shape)', {path: '/id'});
        const sh = sel.slide && findShape(sel.slide.shapes, id);
        if (!sh) throw bad('text.set', `no shape ${id}`, {path: '/id'});
        const cell = cellParam(p);
        const inherited = inheritedAligns(ctx.doc, {slide: sel.slideId, shape: id});
        const base = shapeJsonPath(ctx.doc, sel.slideId, id);
        let path, body;
        if (sh.kind?.type === 'table') {
          const c = cell && sh.kind.rows?.[cell[0]]?.cells?.[cell[1]];
          if (!c) throw bad('text.set', 'no text here (tables need `cell`)', {path: '/cell'});
          path = [...base, 'kind', 'rows', cell[0], 'cells', cell[1], 'text'];
          body = c.text ?? {body: {}, paragraphs: []};
        } else {
          path = [...base, 'text'];
          body = sh.text ?? {body: {}, paragraphs: []};
        }
        const keep = body.paragraphs?.[0]?.runs?.[0]?.props;
        const levels = (body.paragraphs ?? []).map(q => [q.level ?? 0, q.props]);
        const nb = bodyFromText(p.text);
        const paragraphs = nb.paragraphs.map((q0, i) => {
          let [q, tabs] = promoteLeadingTabs(q0);
          if (!tabs && levels[i]) {
            q = {...q, level: levels[i][0]};
            if (levels[i][1]) q.props = structuredClone(levels[i][1]);
          }
          q = promoteRtl(q, inherited);
          return {...q, runs: (q.runs ?? []).map(r => (keep && Object.keys(keep).length ? {...r, props: structuredClone(keep)} : r))};
        });
        ctx.change.set(path, {...body, paragraphs});
        if (!(sh.kind?.type === 'table')) fitTextBox(ctx, sel.slideId, id, ctx.host);
        return {};
      },
    },
    {
      id: 'text.get', label: 'Get Text', risk: 'read',
      description: 'A shape\'s text (default: the text being edited, else the selected shape): {text, paragraphs: [{level, text}]}.',
      params: s.object({id: s.optional(shapeId)}),
      state: hasSlide,
      run(ctx, p) {
        const sel = selectionOf(ctx);
        const id = idParam(p, 'id', 'text.get') ?? (sel.text && !sel.text.notes ? sel.text.shape : sel.shapes[0]);
        if (!id) throw bad('text.get', 'missing `id`', {path: '/id'});
        const sh = sel.slide && findShape(sel.slide.shapes, id);
        if (!sh) throw bad('text.get', 'no such shape', {path: '/id'});
        const t = sh.text ?? {body: {}, paragraphs: []};
        return {text: bodyText(t), paragraphs: (t.paragraphs ?? []).map(q => ({level: q.level ?? 0, text: paraText(q)}))};
      },
    },
  ],
});
