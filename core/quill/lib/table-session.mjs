// The upstream Session, as the Insert and Table commands use it: the selection (with whole table
// cells), typing formatting, deleting the selection and typing text with Track Changes, splitting a
// paragraph as Enter does, content-control delete checks, and the standard selection result.
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd.rs               sel_result, selected_paths, delete_selection(_effect),
//                                          new_revision, has_next_para, join_next_para,
//                                          track_delete_as, type_text / insert_text, leave_list,
//                                          split_para(_as)
//   crates/engine/src/session/query.rs     typing_props, caret_props
//   crates/engine/src/doc_state.rs         CellRange (+ `cells`)
//   crates/engine/src/cmd/controls.rs      check_delete / check_deletions
//   crates/engine/src/cmd/table/cells.rs   cell, selected_cells, grid_cols, cell_text, cell_at, row_ends
//   crates/engine/src/cmd/table/select.rs  select_cells, select_range (the selection a block of whole
//                                          cells makes)
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `S` stands for upstream's Session: {ctx, d (a model Document over ctx.doc), sel {anchor, focus},
// cells (a CellRange or null), segments (the cells' paragraphs when they are not one run of the
// text), pending (typing formatting), author, now()}. Commands open it, edit `S.d`, and `finish`
// commits the one Quill op, sets the kernel selection and returns upstream's `sel_result`.
//
// Whole cells in the kernel selection: a block of cells that is one run of the text (one row, or
// whole rows) is one range from the first cell's start to the last cell's end, as upstream keeps
// it; any other block (part of a column) is one range per cell paragraph (upstream's column
// segments), the primary one ending in the last cell. Both read back as a CellRange.
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {isQuill2} from '../model/content.mjs';
import {cmpPos, samePath, pathCell} from '../model/document.mjs';
import * as P from '../model/para.mjs';
import {getStyle, resolveChar, resolvePara} from '../model/styles.mjs';
import {charUnlinked, charWithoutSymbol} from '../model/props.mjs';
import {cellSpan, gridCol, rowFirstGrid, tableCols} from '../model/table.mjs';
import {lockCanDelete, lockCanEdit} from '../model/ranges.mjs';
import {textWidth} from '../model/section.mjs';
import {pendingProps, setPending} from './format-target.mjs';

export const OBJ = P.OBJ;
export const caret = p => ({anchor: clonePos(p), focus: clonePos(p)});
export const clonePos = p => ({story: p.story, path: [...p.path], off: p.off});
export const isCollapsed = sel => cmpPos(sel.anchor, sel.focus) === 0;
export const ordered = sel => (cmpPos(sel.anchor, sel.focus) <= 0 ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor]);
const withLast = (path, v) => [...path.slice(0, -1), v];
const err = (code, msg, data) => new CommandError(code, msg, data);
export const failed = msg => err('failed', msg);
export const params = msg => err('invalid_params', msg);
export const disabled = msg => err('disabled', msg);

/** Revision dates are whole seconds, as Word writes them (now_iso). */
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The author tracked changes are recorded under (File › Options › User name). */
export function authorOf(prefs) {
  const p = prefs ?? {};
  const name = p.userName ?? p.user?.name ?? p.author;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Author';
}

/** state(): enabled on a schema-2 document. */
export function ready(ctx) {
  if (!ctx?.doc) return {enabled: false, reason: 'No document is open'};
  if (!isQuill2(ctx.doc)) return {enabled: false, reason: 'This document has not been converted to the new Quill format yet'};
  return {enabled: true};
}

// ---- opening and finishing ------------------------------------------------------------------

/** The Session-like `S` over a command context. */
export function open(ctx) {
  const st = ready(ctx);
  if (!st.enabled) throw disabled(st.reason);
  const d = ctx.model.open(ctx);
  const all = ctx.model.selection(ctx).map(r => ({anchor: d.clamp(r.anchor), focus: d.clamp(r.focus)}));
  const primary = Math.min(ctx.selection?.primary ?? 0, all.length - 1);
  const S = {ctx, d, sel: all[primary] ?? all[0], cells: null, segments: null, pending: pendingProps(ctx, d), nextPending: undefined, author: authorOf(ctx.prefs),
    now: () => iso(ctx.host?.now?.() ?? Date.now()), view: ctx.view ?? {}, status: ''};
  readCells(S, all, primary);
  return S;
}

/** Commit what `S.d` changed (if anything), set the kernel selection, return upstream's sel_result. */
export function finish(S, result) {
  const {ctx} = S;
  // A table change (sorting rows, merging, deleting) can leave the caret's path on another, shorter
  // cell paragraph: keep both ends on real text (upstream Session::clamp_selection).
  if (S.sel?.anchor && S.sel?.focus) S.sel = {...S.sel, anchor: S.d.clamp(S.sel.anchor), focus: S.d.clamp(S.sel.focus)};
  ctx.model.commit(ctx, S.d);
  setKernelSelection(S);
  // What typing at the caret gets next (upstream `s.pending`), as the format family keeps it.
  if (S.nextPending && isCollapsed(S.sel)) setPending(ctx, S.d, S.sel.focus, S.nextPending);
  return result === undefined ? selResult(S) : result;
}

/** Upstream `sel_result`: the selection's ends as addresses. */
export function selResult(S) {
  return {anchor: S.ctx.model.addressOf(S.ctx, S.sel.anchor), focus: S.ctx.model.addressOf(S.ctx, S.sel.focus)};
}

function setKernelSelection(S) {
  const {ctx} = S;
  if (S.cells && !S.cells.stream && S.segments?.length) {
    // Upstream keeps the corners in `sel` and the cells' paragraphs as column segments.
    const focusAt = S.segments.findIndex(([, b]) => cmpPos(b, S.sel.focus) === 0);
    ctx.model.setSelection(ctx, S.segments.map(([a, b]) => ({anchor: a, focus: b})), focusAt < 0 ? S.segments.length - 1 : focusAt);
    return;
  }
  ctx.model.setSelection(ctx, [S.sel]);
}

/** Set the selection to a caret (clears whole-cell selection, as upstream's commands do). */
export function setCaret(S, pos) {
  S.sel = caret(pos);
  S.cells = null;
  S.segments = null;
}

// ---- whole cells -------------------------------------------------------------------------------

/** The cell of the table at index `i` of paragraph path `p`, if the paragraph is in one there (cell_at). */
export function cellAt(p, i) {
  if (p.length > i + 3) return [p.slice(0, i + 1), p[i + 1], p[i + 2]];
  return null;
}

/** The innermost cell a position is in: [tablePath, row, cell] (Path::cell). */
export const cellOfPos = pos => pathCell(pos.path);

/** The grid columns cell `c` of row `r` covers, [first, last] (grid_cols). */
export function gridCols(t, r, c) {
  const g = gridCol(t, r, c);
  const span = cellSpan(t.rows[r]?.cells[c]);
  return [g, g + span - 1];
}

/** The selected cells of table `t` for a CellRange (CellRange::cells), in document order. */
export function rangeCells(range, t) {
  const [r0, r1] = range.rows, [g0, g1] = range.cols;
  const out = [];
  for (let r = r0; r <= r1 && r < t.rows.length; r++) {
    const row = t.rows[r];
    let g = rowFirstGrid(row);
    row.cells.forEach((cell, c) => {
      const end = g + cellSpan(cell);
      if (g <= g1 && end > g0) out.push([r, c]);
      g = end;
    });
  }
  return out;
}

/** Every paragraph path of `story` in whole cells `picked` (a Set of "r,c") of the table at `tp`. */
function cellParagraphs(d, story, tp, picked) {
  const depth = tp.length;
  return d.paraPaths(story).filter(q => q.length > depth + 2 && samePath(q.slice(0, depth), tp) && picked.has(`${q[depth]},${q[depth + 1]}`));
}

/** Recognize whole cells in the selection the kernel holds (see the header). */
function readCells(S, all, primary) {
  const {d} = S;
  const first = all[0];
  if (!first) return;
  const story = first.anchor.story;
  if (all.length > 1) {
    // Column segments: whole paragraphs, every one in cells of one table, covering whole cells.
    const segs = all.map(r => ordered(r));
    const tp = commonTable(segs.map(([a]) => a.path));
    if (!tp || segs.some(([a, b]) => a.story !== story || b.story !== story || a.off !== 0 || !samePath(a.path, b.path)
      || (d.para(story, a.path)?.text.length ?? -1) !== b.off)) return;
    const t = d.table(story, tp);
    if (!t) return;
    const picked = new Set(segs.map(([a]) => `${a.path[tp.length]},${a.path[tp.length + 1]}`));
    const rows = [...picked].map(k => Number(k.split(',')[0]));
    let g0 = Infinity, g1 = -Infinity;
    for (const k of picked) { const [r, c] = k.split(',').map(Number); const [x, y] = gridCols(t, r, c); g0 = Math.min(g0, x); g1 = Math.max(g1, y); }
    const range = {story, table: tp, rows: [Math.min(...rows), Math.max(...rows)], cols: [g0, g1], stream: false};
    const want = new Set(rangeCells(range, t).map(([r, c]) => `${r},${c}`));
    if (want.size !== picked.size || [...want].some(k => !picked.has(k))) return;
    const all2 = cellParagraphs(d, story, tp, picked);
    if (all2.length !== segs.length) return;
    S.cells = range;
    S.segments = segs.map(([a, b]) => [clonePos(a), clonePos(b)]);
    const pr = segs[primary] ?? segs[segs.length - 1];
    S.sel = {anchor: clonePos(segs[0][0]), focus: clonePos(pr[1])};
    return;
  }
  // One run of the text from one cell's start to another cell's end in the same table.
  const [a, b] = ordered(first);
  if (a.story !== b.story || a.off !== 0) return;
  const ca = cellOfPos(a), cb = cellOfPos(b);
  if (!ca || !cb || !samePath(ca[0], cb[0])) return;
  if (ca[1] === cb[1] && ca[2] === cb[2]) return;
  const t = d.table(a.story, ca[0]);
  if (!t) return;
  const paths = d.paraPaths(a.story);
  const inCell = (r, c) => paths.filter(q => q.length > ca[0].length + 2 && samePath(q.slice(0, ca[0].length + 2), [...ca[0], r, c]));
  const firstOfA = inCell(ca[1], ca[2])[0];
  const lastsB = inCell(cb[1], cb[2]);
  const lastOfB = lastsB[lastsB.length - 1];
  if (!firstOfA || !lastOfB || !samePath(firstOfA, a.path) || !samePath(lastOfB, b.path)) return;
  if ((d.para(b.story, b.path)?.text.length ?? -1) !== b.off) return;
  const lastCol = tableCols(t) - 1;
  const [ga] = gridCols(t, ca[1], ca[2]), [, gb] = gridCols(t, cb[1], cb[2]);
  const rows = [Math.min(ca[1], cb[1]), Math.max(ca[1], cb[1])];
  // A run of whole rows, or of cells of one row.
  if (rows[0] === rows[1] || (ga === 0 && gb >= lastCol)) {
    S.cells = {story: a.story, table: ca[0], rows, cols: rows[0] === rows[1] ? [ga, gb] : [0, lastCol], stream: true};
  }
}

/** The table path shared by every path at the same depth (all in cells of one table), or null. */
function commonTable(paths) {
  let best = null;
  const p0 = paths[0];
  for (let i = 0; cellAt(p0, i); i += 3) {
    const [tp] = cellAt(p0, i);
    if (paths.every(q => cellAt(q, i) && samePath(cellAt(q, i)[0], tp))) best = tp;
    else break;
  }
  return best;
}

/** The caret's cell or the `disabled` error upstream gives (table/cells.rs `cell`). */
export function cell(S) {
  const c = cellOfPos(S.sel.focus);
  if (!c) throw disabled('the cursor isn\'t in a table');
  return c;
}

/** Selected cells: (row, cell) pairs covered by the selection, at least the caret's (selected_cells). */
export function selectedCells(S) {
  const fc = cellOfPos(S.sel.focus);
  if (S.cells && fc && samePath(fc[0], S.cells.table)) {
    const t = S.d.table(S.cells.story, S.cells.table);
    if (t) return rangeCells(S.cells, t);
  }
  const [a, b] = ordered(S.sel);
  const ca = cellOfPos(a), cb = cellOfPos(b);
  if (!ca || !cb) return [];
  if (!samePath(ca[0], cb[0])) return [[cb[1], cb[2]]];
  const [r0, r1] = [Math.min(ca[1], cb[1]), Math.max(ca[1], cb[1])];
  const [c0, c1] = [Math.min(ca[2], cb[2]), Math.max(ca[2], cb[2])];
  const v = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) v.push([r, c]);
  return v;
}

/** A cell's text: its paragraphs' plain text, one line each (cell_text). */
export const cellText = c => c.blocks.filter(b => b.kind === 'para').map(p => P.plainText(p)).join('\n');

/** Where row `r` of table `tp` starts and ends: its first cell's start and its last cell's end (row_ends). */
export function rowEnds(d, story, tp, r) {
  const row = [...tp, r];
  const paths = d.paraPaths(story).filter(q => q.length > row.length && samePath(q.slice(0, row.length), row));
  if (!paths.length) return null;
  const last = paths[paths.length - 1];
  return [{story, path: paths[0], off: 0}, {story, path: last, off: d.para(story, last)?.text.length ?? 0}];
}

/**
 * Select whole cells of table `tp`: rows `rows`, and of them every cell reaching into grid columns
 * `cols` (both inclusive, either order) (select_range).
 */
export function selectRange(S, story, tp, rows, cols) {
  const t = S.d.table(story, tp);
  if (!t) throw failed('there\'s no table there');
  const lastRow = Math.max(0, t.rows.length - 1), lastCol = Math.max(0, tableCols(t) - 1);
  rows = [Math.min(Math.min(rows[0], rows[1]), lastRow), Math.min(Math.max(rows[0], rows[1]), lastRow)];
  cols = [Math.min(Math.min(cols[0], cols[1]), lastCol), Math.min(Math.max(cols[0], cols[1]), lastCol)];
  const stream = rows[0] === rows[1] || (cols[0] === 0 && cols[1] === lastCol);
  const range = {story, table: [...tp], rows, cols, stream};
  const picked = new Set(rangeCells(range, t).map(([r, c]) => `${r},${c}`));
  const segments = cellParagraphs(S.d, story, tp, picked).map(q => [{story, path: q, off: 0}, {story, path: q, off: S.d.para(story, q)?.text.length ?? 0}]);
  if (!segments.length) throw failed('there are no cells to select there');
  const depth = tp.length;
  // The end corner is in the last cell's own last paragraph (not a nested table's), so it names the cell.
  const own = [...segments].reverse().find(([, b]) => b.path.length === depth + 3);
  const focus = (own ?? segments[segments.length - 1])[1];
  S.sel = {anchor: clonePos(segments[0][0]), focus: clonePos(focus)};
  S.cells = range;
  S.segments = segments;
  S.pending = null;
  return selResult(S);
}

/** select_cells: the whole table (which null), a row ([r, null]) or a cell ([r, c]). */
export function selectCells(S, tp, which) {
  const story = S.sel.focus.story;
  const t = S.d.table(story, tp);
  if (!t) return selResult(S);
  const lastRow = Math.max(0, t.rows.length - 1), lastCol = Math.max(0, tableCols(t) - 1);
  let rows, cols;
  if (!which) { rows = [0, lastRow]; cols = [0, lastCol]; }
  else if (which[1] === null) { rows = [which[0], which[0]]; cols = [0, lastCol]; }
  else { rows = [which[0], which[0]]; cols = gridCols(t, which[0], which[1]); }
  return selectRange(S, story, tp, rows, cols);
}

/** The paragraphs the selection covers (selected_paths): the cells' own for a block of column cells. */
export function selectedPaths(S) {
  if (S.cells && !S.cells.stream && S.segments) return S.segments.map(([a]) => a.path);
  const [a, b] = ordered(S.sel);
  return S.d.paraPathsIn ? S.d.paraPathsIn(a, b) : S.d.pathsBetween(a, b);
}

// ---- typing formatting --------------------------------------------------------------------------

/** The caret's formatting (caret_props). */
export function caretProps(S) {
  if (S.pending) return {...S.pending};
  const f = S.sel.focus;
  const p = S.d.paraAt(f);
  if (!p) return {};
  const props = P.propsAt(p, f.off) ?? {};
  // As in Word, text typed at either end of a hyperlink isn't part of it.
  const insideLink = !!props.link && f.off > 0 && f.off < p.text.length && P.propsOfChar(p, f.off)?.link === props.link;
  const out = charWithoutSymbol(props.link && !insideLink ? charUnlinked(props) : {...props});
  if (out.style === 'FootnoteReference' || out.style === 'EndnoteReference') delete out.style;
  return out;
}

/** The formatting typed text gets (typing_props). */
export function typingProps(S) {
  const [a] = ordered(S.sel);
  const p = S.d.paraAt(a);
  let c;
  if (p && !S.pending && !isCollapsed(S.sel) && a.off < p.text.length) {
    const props = P.propsOfChar(p, a.off) ?? {};
    c = props.link ? charUnlinked(props) : {...props};
    if (c.style === 'FootnoteReference' || c.style === 'EndnoteReference') delete c.style;
  } else c = caretProps(S);
  delete c.rtl;
  return c;
}

// ---- revisions, deletion, typing ----------------------------------------------------------------

const trackChanges = S => !!S.d.c.settings?.trackChanges || !!(S.ctx ?? S.c)?.view?.trackMine;

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

/** Whether another paragraph follows `path` in its container (has_next_para). */
export const hasNextPara = (S, story, path) => S.d.block(story, withLast(path, path[path.length - 1] + 1))?.kind === 'para';

function setMark(S, story, path, f) {
  const p = S.d.paraMut(story, path);
  const m = f({...(p.mark ?? {})});
  for (const k of Object.keys(m)) if (m[k] === undefined || m[k] === null) delete m[k];
  if (Object.keys(m).length) p.mark = m; else delete p.mark;
}

function setParaProps(S, story, path, f) {
  const p = S.d.paraMut(story, path);
  const props = f({...(p.props ?? {})});
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  if (Object.keys(props).length) p.props = props; else delete p.props;
  return p;
}

/** Remove the paragraph mark at `path`: the next paragraph joins it (join_next_para). */
export function joinNextPara(S, story, path) {
  if (!hasNextPara(S, story, path)) return false;
  const next = withLast(path, path[path.length - 1] + 1);
  const len = S.d.para(story, path)?.text.length ?? 0;
  const nm = S.d.para(story, next)?.mark ?? {};
  S.d.deleteRange({story, path, off: len}, {story, path: next, off: 0});
  setMark(S, story, path, m => ({...m, ins: nm.ins, del: nm.del}));
  return true;
}

function trackDeleteWouldChange(S, a, b) {
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

/** Tracked deletion with revision `rid` (track_delete_as): own insertions go, the rest is marked. */
export function trackDeleteAs(S, a, b, rid) {
  let changed = false;
  const own = i => i !== undefined && i !== null && S.d.c.revisions?.[i]?.author === S.author;
  for (const path of [...S.d.pathsBetween(a, b)].reverse()) {
    const p = S.d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0;
    const to = samePath(path, b.path) ? b.off : p.text.length;
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
  return {at: clonePos(a), changed};
}

const CANT_DELETE = 'This content control can\'t be deleted.';
const CANT_EDIT = 'The contents of this content control can\'t be edited.';

/** Refuse deleting `a..b` when that removes a control locked against deletion or edits locked content (check_deletions). */
export function checkDelete(S, a, b) {
  if (a.story !== b.story) return;
  const ranges = S.d.controlRanges(a.story);
  if (!ranges.length) return;
  const le = (x, xo, y, yo) => (cmpPathOff(x, xo, y, yo) <= 0);
  for (const r of ranges) {
    const whole = le(a.path, a.off, r.start.path, r.start.off) && le(r.end.path, r.end.off + 1, b.path, b.off);
    const touches = cmpPathOff(a.path, a.off, r.end.path, r.end.off) < 0 && cmpPathOff(b.path, b.off, r.start.path, r.start.off + 1) > 0;
    if (whole && !lockCanDelete(r.control.lock)) { S.status = CANT_DELETE; throw failed(CANT_DELETE); }
    if (!whole && touches && !lockCanEdit(r.control.lock)) { S.status = CANT_EDIT; throw failed(CANT_EDIT); }
  }
}
const cmpPathOff = (p, po, q, qo) => cmpPos({story: 0, path: p, off: po}, {story: 0, path: q, off: qo});

/** Delete the selection, respecting Track Changes (delete_selection_effect). */
export function deleteSelectionEffect(S) {
  const [a, b] = ordered(S.sel);
  if (cmpPos(a, b) === 0) return {at: clonePos(a), contentChanged: false};
  checkDelete(S, a, b);
  let eff;
  if (trackChanges(S)) {
    if (!trackDeleteWouldChange(S, a, b)) eff = {at: clonePos(a), contentChanged: false};
    else { const r = trackDeleteAs(S, a, b, newRevision(S, 'delete')); eff = {at: r.at, contentChanged: r.changed}; }
  } else eff = {at: S.d.deleteRange(a, b), contentChanged: true};
  setCaret(S, eff.at);
  return eff;
}

/** Delete the selection (respecting Track Changes); returns the collapsed position (delete_selection). */
export const deleteSelection = S => deleteSelectionEffect(S).at;

/** Take a paragraph out of its list as Enter does (leave_list). */
function leaveList(S, story, path) {
  setParaProps(S, story, path, pr => {
    if (pr.style === 'ListParagraph') { delete pr.style; delete pr.numbering; } else pr.numbering = {num: 0, level: 0};
    delete pr.indentLeft; delete pr.indentFirst; delete pr.indentLeftChars; delete pr.indentFirstChars;
    return pr;
  });
}

/** Split the paragraph at `pos` as Enter does (split_para / split_para_as). */
export function splitPara(S, pos, enter = true) {
  const p = S.d.paraAt(pos);
  if (!p) throw failed('no paragraph at caret');
  const atEnd = pos.off >= p.text.length;
  const style = p.props?.style ?? null;
  const num = p.props?.numbering ?? resolvePara(S.d.c.styles, p.props ?? {}).numbering ?? null;
  if (enter && num && num.num !== 0 && p.text.length === 0) {
    if (num.level > 0) setParaProps(S, pos.story, pos.path, pr => ({...pr, numbering: {num: num.num, level: num.level - 1}}));
    else leaveList(S, pos.story, pos.path);
    return clonePos(pos);
  }
  const markRevs = {ins: p.mark?.ins, del: p.mark?.del};
  const nw = S.d.splitParagraph(pos);
  if (atEnd && style) {
    const next = getStyle(S.d.c.styles, style)?.next ?? null;
    if (next && next !== style) {
      setParaProps(S, nw.story, nw.path, pr => { pr.style = next; delete pr.numbering; return pr; });
      setMark(S, nw.story, nw.path, () => ({}));
    }
  }
  if (trackChanges(S)) {
    const rid = newRevision(S, 'insert');
    setMark(S, pos.story, pos.path, m => ({...m, ins: rid}));
    setMark(S, nw.story, nw.path, m => ({...m, ins: markRevs.ins, del: markRevs.del}));
  }
  return nw;
}

const RTL_STRONG = new RegExp("[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF]", 'u');
const firstStrongIsRtl = text => { for (const ch of text) { if (RTL_STRONG.test(ch)) return true; if (/\p{L}/u.test(ch)) return false; } return false; };

function directionUnset(S, pos) {
  const p = S.d.paraAt(pos);
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

/** Insert typed text at the caret, replacing the selection, with Track Changes (type_text / insert_text). */
export function typeText(S, text, enter = true) {
  let props = typingProps(S);
  if (isCollapsed(S.sel)) S.sel = caret(S.d.typingPos(S.d.pastFieldEnds(S.sel.focus)));
  if (!enter) props = charWithoutSymbol(props);
  const deletion = deleteSelectionEffect(S);
  delete props.fmtChange;
  delete props.rtl;
  if (trackChanges(S) && text) { props.ins = newRevision(S, 'insert'); delete props.del; } else { delete props.ins; delete props.del; }
  let pos = S.sel.focus;
  let first = true, inserted = false;
  for (const part0 of String(text).split(/[\r\u2029]/)) {
    if (!first) { pos = splitPara(S, pos, enter); inserted = true; }
    first = false;
    const part = part0.replace(/\u000B/g, '\n');
    if (part) {
      inserted = true;
      const startsPara = directionUnset(S, pos);
      pos = S.d.insertText(pos, part, props);
      if (startsPara && firstStrongIsRtl(S.d.paraAt(pos).text)) setParaProps(S, pos.story, pos.path, pr => ({...pr, bidi: true}));
    }
  }
  setCaret(S, pos);
  return {contentChanged: deletion.contentChanged || inserted};
}

// ---- sections ----------------------------------------------------------------------------------

/** The section the caret is in (cmd/page `sect`): its body block's section, or the last section in a part. */
export function caretSection(S) {
  const f = S.sel.focus;
  if (f.story === 'body') return S.d.sectionOfBlock(f.path[0] ?? 0);
  return S.d.c.lastSection;
}

/** The caret section's text width, points. */
export const caretTextWidth = S => textWidth(caretSection(S));

/** The first section's text width (`sections().first().text_width()`, 468 pt by default). */
export function firstTextWidth(S) {
  const s = S.d.sections()[0];
  return s ? textWidth(s[1]) : 468;
}

/** The language of a paragraph's text: its first run with text (else the mark), through styles (para_lang). */
export function paraLang(d, p) {
  const run = (p.runs ?? []).find(r => r.len > 0);
  const props = run ? (run.props ?? {}) : (p.mark ?? {});
  return resolveChar(d.c.styles, p.props?.style ?? null, props).lang ?? null;
}

/** The document's default text language (doc_lang / default_lang). */
export function defaultLang(S) {
  return resolveChar(S.d.c.styles, null, {}).lang ?? S.ctx?.prefs?.editingLang ?? null;
}
