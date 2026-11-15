// Formatting the text being edited or the selected shapes' text: run, paragraph and body
// (text box) edits, the word a bare caret formats, and the effective formatting at the selection.
// Translated from deckcraft crates/engine/src/cmd/text/formatting.rs (`format_run`,
// `format_range`, `format_para`, `format_body`) and crates/engine/src/cmd/format.rs
// (`current_run`, `current_para`, `on_param`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:prism/format owns this file; the
// format dialogs import it. No DOM, no Node built-ins.
//
// Table cells: with a table selected as a shape, deckcraft formats the selected cell range
// (`table::selected_range`), else every cell. Prism carries a cell range as a selection range
// whose endpoints are `/sl:<s>/sp:<tbl>/r:<i>/c:<j>` (no text offset); without one, every cell.

import {textSelection, slideById, selectedShapeIds, currentSlideId, parseSel} from '../model/doc.mjs';
import {findShape} from '../model/presentation.mjs';
import {format as formatRange, formatAll, propsAt, wordAt} from '../model/edit.mjs';
import {paraText} from '../model/text.mjs';
import {ctxForSlide, run as resolveRun, para as resolvePara, body as resolveBody, fontFamily} from '../model/resolve.mjs';
import {bad, bodyOf, textPositions, ordered, editText, fitTextBox, SELECT_TEXT_OR_SHAPE} from './text-session.mjs';
import {editShapes} from './shape-common.mjs';

const cmpPos = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

/** `on_param`: `on` when given, else the opposite of the current state. */
export const onParam = (p, current) => (typeof p?.on === 'boolean' ? p.on : !current);

/** The resolve context of the current slide (deckcraft `text::ctx_for`), or null. */
export function resolveCtx(ctx) {
  const sl = slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection));
  return sl ? ctxForSlide(ctx.doc, sl) : null;
}
const shapeOnCurrent = (ctx, id) => findShape(slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection))?.shapes, id);

/** The selected shapes as objects (deckcraft `selected_shapes`). */
export function selectedShapes(ctx) {
  const sl = slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection));
  return selectedShapeIds(ctx.doc, ctx.selection).map(id => findShape(sl?.shapes, id)).filter(Boolean);
}

/** `current_run`: the effective run props at the selection (the first selected run). */
export function currentRun(ctx) {
  let shape, para, run;
  const t = textSelection(ctx.doc, ctx.selection);
  if (t) {
    const body = bodyOf(ctx.doc, t);
    if (!body) return {};
    const {anchor, caret} = textPositions(body, t);
    const [a, b] = ordered(anchor, caret);
    run = cmpPos(a, b) !== 0 ? propsAt(body, [a[0], a[1] + 1]) : propsAt(body, a);
    para = body.paragraphs?.[a[0]] ?? {level: 0, runs: []};
    shape = t.notes ? null : shapeOnCurrent(ctx, t.shape);
  } else {
    shape = selectedShapes(ctx)[0];
    if (!shape) return {};
    para = shape.text?.paragraphs?.[0] ?? {level: 0, runs: []};
    run = {...(para.runs?.[0]?.props ?? {})};
  }
  const rc = resolveCtx(ctx);
  return rc && shape ? resolveRun(rc, shape, para, run) : run;
}

/** `current_para`: the effective paragraph props at the caret (or the first selected shape's first paragraph). */
export function currentPara(ctx) {
  let shape, para;
  const t = textSelection(ctx.doc, ctx.selection);
  if (t) {
    const body = bodyOf(ctx.doc, t);
    const caret = body ? textPositions(body, t).caret : [0, 0];
    para = body?.paragraphs?.[caret[0]] ?? {level: 0, runs: []};
    shape = t.notes ? null : shapeOnCurrent(ctx, t.shape);
  } else {
    shape = selectedShapes(ctx)[0];
    if (!shape) return {};
    para = shape.text?.paragraphs?.[0] ?? {level: 0, runs: []};
  }
  const rc = resolveCtx(ctx);
  return rc && shape ? resolvePara(rc, shape, para) : {...(para.props ?? {})};
}

/** The resolved font family name at the selection (deckcraft `resolve::font_family`). */
export function currentFamily(ctx, r = currentRun(ctx)) {
  const rc = resolveCtx(ctx);
  return rc ? fontFamily(rc, r) : r.font ?? '';
}

/** The effective body props of the edited or first selected shape (deckcraft `resolve::body`). */
export function currentBody(ctx) {
  const t = textSelection(ctx.doc, ctx.selection);
  const id = t && !t.notes ? t.shape : selectedShapeIds(ctx.doc, ctx.selection)[0];
  const sh = id ? shapeOnCurrent(ctx, id) : null;
  if (!sh) return null;
  const rc = resolveCtx(ctx);
  return rc ? resolveBody(rc, sh) : {...(sh.text?.body ?? {})};
}

/**
 * `format_range`: what run formatting changes while editing: the selection, or for a bare caret
 * inside a word that word without its trailing spaces; a caret at a word boundary is an empty range.
 */
export function formatSpan(body, t) {
  const {anchor, caret} = textPositions(body, t);
  let [a, b] = ordered(anchor, caret);
  if (cmpPos(a, b) === 0) {
    const [wa, wb] = wordAt(body, a);
    if (wa[1] < a[1] && a[1] < wb[1]) {
      a = wa; b = [wb[0], wb[1]];
      const line = paraText(body.paragraphs?.[b[0]] ?? {runs: []});
      while (b[1] > a[1] && line[b[1] - 1] === ' ') b = [b[0], b[1] - 1];
    }
  }
  return [a, b];
}

/** The table cell range a selection range names on table `id`: [r0, c0, r1, c1] or null. */
function cellRange(ctx, id) {
  for (const r of ctx.selection?.ranges ?? []) {
    const a = parseSel(r.anchor), f = parseSel(r.focus ?? r.anchor);
    if (!a?.cell || !f?.cell || a.text !== null || a.chain[a.chain.length - 1] !== id) continue;
    return [Math.min(a.cell[0], f.cell[0]), Math.min(a.cell[1], f.cell[1]), Math.max(a.cell[0], f.cell[0]), Math.max(a.cell[1], f.cell[1])];
  }
  return null;
}
const inRange = (rg, r, c) => !rg || (r >= rg[0] && r <= rg[2] && c >= rg[1] && c <= rg[3]);

/** Apply `body => body` to the text of each selected shape (table cells: the selected range or all). */
function editShapeBodies(ctx, cmd, f) {
  const ids = selectedShapeIds(ctx.doc, ctx.selection);
  if (!ids.length) throw bad(cmd, SELECT_TEXT_OR_SHAPE);
  const slideId = currentSlideId(ctx.doc, ctx.selection);
  const ranges = new Map(ids.map(id => [id, cellRange(ctx, id)]));
  editShapes(ctx, {ids}, cmd, sh => {
    if (sh.kind?.type === 'table') {
      const rg = ranges.get(sh.id);
      sh.kind.rows = (sh.kind.rows ?? []).map((row, r) => ({...row, cells: (row.cells ?? []).map((cell, c) =>
        (inRange(rg, r, c) ? {...cell, text: f(cell.text ?? {body: {}, paragraphs: []})} : cell))}));
    } else {
      sh.text = f(sh.text ?? {body: {}, paragraphs: []});
    }
  }, ids);
  for (const id of ids) fitTextBox(ctx, slideId, id, ctx.host);
  return ids;
}

/**
 * `format_run`: `f(props) -> props` on the text selection (a bare caret: the word it is in, or the
 * empty paragraph's end mark / typing format), else on all the text of the selected shapes.
 */
export function formatRun(ctx, cmd, f) {
  const t = textSelection(ctx.doc, ctx.selection);
  if (t) {
    editText(ctx, cmd, body => {
      const [a, b] = formatSpan(body, t);
      return {body: formatRange(body, a, b, f)};
    });
    return {};
  }
  editShapeBodies(ctx, cmd, body => formatAll(body, f));
  return {};
}

/** `format_para`: `f(paragraph) -> paragraph` on the paragraphs the selection touches, else every paragraph of the selected shapes. */
export function formatPara(ctx, cmd, f) {
  const t = textSelection(ctx.doc, ctx.selection);
  if (t) {
    editText(ctx, cmd, (body, sel) => {
      const [a, b] = ordered(sel.anchor, sel.caret);
      const paragraphs = body.paragraphs?.length ? [...body.paragraphs] : [{level: 0, runs: []}];
      const last = paragraphs.length - 1;
      for (let pi = a[0]; pi <= Math.min(b[0], last); pi++) paragraphs[pi] = f(structuredClone(paragraphs[pi]));
      return {body: {...body, paragraphs}};
    });
    return {};
  }
  editShapeBodies(ctx, cmd, body => {
    const paragraphs = body.paragraphs?.length ? body.paragraphs : [{level: 0, runs: []}];
    return {...body, paragraphs: paragraphs.map(p => f(structuredClone(p)))};
  });
  return {};
}

/** `format_body`: `f(bodyProps) -> bodyProps` on the edited shape (not notes) or the selected shapes. */
export function formatBody(ctx, cmd, f) {
  const t = textSelection(ctx.doc, ctx.selection);
  const ids = t && !t.notes ? [t.shape] : selectedShapeIds(ctx.doc, ctx.selection);
  if (!ids.length) throw bad(cmd, 'select a shape');
  const slideId = t && !t.notes ? t.slide : currentSlideId(ctx.doc, ctx.selection);
  editShapes(ctx, {ids}, cmd, sh => {
    const text = sh.text ?? {body: {}, paragraphs: []};
    sh.text = {...text, body: f({...(text.body ?? {})})};
  }, ids);
  for (const id of ids) fitTextBox(ctx, slideId, id, ctx.host);
  return {};
}

/** The paragraph props object of a paragraph (created when absent). */
export const props = p => (p.props ??= {});
