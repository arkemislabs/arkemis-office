// Resizing a table with the mouse, like Word: drag a border between columns (or the table's left
// or right edge), a row's bottom border, or the small handle just outside the table's bottom-right
// corner to scale the whole table. With cells selected, a border of theirs moves only in their
// rows. The geometry comes from the layout (what is on the page, in page points), so the result is
// what the drag showed even when AutoFit or a percentage width made the drawn columns differ from
// the stored grid. The page view sends each finished drag here, so every drag is one undo step.
//
// Translated from wordcraft crates/engine/src/cmd/table_resize.rs (REACH, HANDLE, MIN_COL,
// MIN_ROW, MAX_LEN, Edge, Share, DrawnRow, ResizeTarget {left, right, top, bottom, widths, handle,
// plan, planned_x, limit_to_selection, selected_block}, share_out, cell_in, cell_boxes, geometry,
// tables_on, on_handle, table_under, resize_target, resize_drag, move_left_edge, regrid,
// drawn_left, set_widths, drawn_heights, touch) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The geometry helpers are exported for the page view (cursor shapes, the live drag outline, the
// resize handle) and for table_mouse / table_draw. Upstream's `touch` (re-lay the table out) has no
// counterpart: the layout cache follows the content itself.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {MAX_COLS, cellAtGrid, cellSpan, gridCol, rowFirstGrid, tableCols, vmergeOf} from '../model/table.mjs';
import * as T from '../lib/table-session.mjs';
import {layoutFor} from '../lib/caret-session.mjs';
import {syncCellWidths} from './table.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/table_resize.rs']};
const {failed, params: badParams} = T;

/** How near (points) a border has to be to the pointer, by default. */
export const REACH = 3.0;
/** The corner handle's side (points); it sits just outside the table's bottom-right corner. */
export const HANDLE = 6.0;
/** The narrowest column a drag leaves (points). */
export const MIN_COL = 6.0;
/** The lowest row a drag leaves (points). */
export const MIN_ROW = 4.0;
/** The largest column width or row height a drag sets (points; Word's 22 inches). */
const MAX_LEN = 1584.0;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fin = Number.isFinite;
const right = r => r.x + r.w;
const bottom = r => r.y + r.h;
const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const startsWith = (p, pre) => p.length >= pre.length && pre.every((v, i) => p[i] === v);

/**
 * What a press would grab: {kind: 'column', line} (the vertical border at grid line `line`, 0 = the
 * table's left edge), {kind: 'row', row} (the bottom border of `row`) or {kind: 'corner'} (the
 * resize handle).
 */
export const Edge = Object.freeze({column: line => ({kind: 'column', line}), row: row => ({kind: 'row', row}), corner: Object.freeze({kind: 'corner'})});
export const sameEdge = (a, b) => a?.kind === b?.kind && a.line === b.line && a.row === b.row;

/** Who makes up the difference when a column border moves: 'neighbour' (no key), 'leftOnly' (Shift), 'proportional' (Ctrl). */
export const shareOf = shift => (shift ? 'leftOnly' : 'neighbour');

/**
 * A table border (or the handle) under the pointer, with the table's drawn geometry (ResizeTarget):
 * {edge, story, table (path), cols (drawn grid lines, page x, columns + 1), rows ([{row, top, bottom,
 * edges}] drawn on this page), endsHere, only ([[row, gridLines]] when the border moves in selected
 * rows only)}.
 */
export class ResizeTarget {
  constructor(f) { Object.assign(this, f); }
  left() { return this.cols[0] ?? 0; }
  right() { return this.cols[this.cols.length - 1] ?? 0; }
  top() { return this.rows[0]?.top ?? 0; }
  bottom() { return this.rows[this.rows.length - 1]?.bottom ?? 0; }
  /** The drawn column widths. */
  widths() { const w = []; for (let i = 1; i < this.cols.length; i++) w.push(Math.max(this.cols[i] - this.cols[i - 1], 0)); return w; }
  /** The resize handle's square (page points). */
  handle() { return {x: this.right() + 1, y: this.bottom() + 1, w: HANDLE, h: HANDLE}; }
  clone() { return new ResizeTarget({...this, cols: [...this.cols], rows: this.rows.map(r => ({...r, edges: [...r.edges]})), table: [...this.table], only: this.only.map(([r, l]) => [r, [...l]])}); }

  /**
   * The new widths and heights a drag that moved the pointer by (dx, dy) points gives: {widths
   * (or null), heights [[row, h]], indentBy (or null), cells [[row, widths]]}. `share` says who
   * makes up a column border's move (a boolean: Shift is held).
   */
  plan(dx, dy, share) {
    if (typeof share === 'boolean') share = shareOf(share);
    share ??= 'neighbour';
    dx = fin(dx) ? clamp(dx, -MAX_LEN, MAX_LEN) : 0;
    dy = fin(dy) ? clamp(dy, -MAX_LEN, MAX_LEN) : 0;
    const none = () => ({widths: null, heights: [], indentBy: null, cells: []});
    const w = this.widths();
    const e = this.edge;
    if (e.kind === 'column' && e.line === 0) {
      // The table's left edge: the table moves in or out and the first column makes up the
      // difference, so the other borders stay.
      if (!w.length) return none();
      const first = w[0];
      const d = clamp(dx, first - MAX_LEN, Math.max(first - MIN_COL, first - MAX_LEN));
      w[0] = first - d;
      return {...none(), widths: w, indentBy: d};
    }
    if (e.kind === 'column' && this.only.length) {
      // A border of selected cells: it moves in their rows only, as far as all of them let it,
      // each row sharing the move out among its own cells.
      const rows = [];
      for (const [r, lines] of this.only) {
        const k = lines.indexOf(e.line);
        if (k < 1) continue;
        const xs = lines.map(g => this.cols[g]);
        if (xs.some(x => x === undefined)) continue;
        const cw = [];
        for (let i = 1; i < xs.length; i++) cw.push(Math.max(xs[i] - xs[i - 1], 0));
        rows.push([r, cw, k - 1]);
      }
      let d = null;
      for (const [, cw, i] of rows) {
        const got = shareOut(cw.slice(), i, dx, share);
        if (got !== null && (d === null || Math.abs(got) < Math.abs(d))) d = got;
      }
      if (d === null) return none();
      return {...none(), cells: rows.map(([r, cw, i]) => { shareOut(cw, i, d, share); return [r, cw]; })};
    }
    if (e.kind === 'column') {
      return e.line >= 1 && shareOut(w, e.line - 1, dx, share) !== null ? {...none(), widths: w} : none();
    }
    if (e.kind === 'row') {
      const r = this.rows.find(x => x.row === e.row);
      if (!r) return none();
      return {...none(), heights: [[e.row, clamp(r.bottom - r.top + dy, MIN_ROW, MAX_LEN)]]};
    }
    // The corner handle.
    const width = this.right() - this.left(), height = this.bottom() - this.top();
    const kx = width > 1 ? clamp((width + dx) / width, 0.01, 100) : 1;
    const ky = height > 1 ? clamp((height + dy) / height, 0.01, 100) : 1;
    const widths = Math.abs(kx - 1) > 0.001 ? w.map(x => clamp(x * kx, MIN_COL, MAX_LEN)) : null;
    const heights = Math.abs(ky - 1) > 0.001 ? this.rows.map(r => [r.row, clamp((r.bottom - r.top) * ky, MIN_ROW, MAX_LEN)]) : [];
    return {...none(), widths, heights};
  }

  /** Page x of grid line `line` once `plan` is applied: in row `row` when that row's border moves on its own, else in every row. */
  plannedX(plan, row, line) {
    const left = this.left() + (plan.indentBy ?? 0);
    if (row !== null && row !== undefined) {
      const cw = plan.cells.find(([c]) => c === row)?.[1];
      const k = this.only.find(([o]) => o === row)?.[1].indexOf(line) ?? -1;
      if (cw && k >= 0) return left + cw.slice(0, k).reduce((a, x) => a + x, 0);
    }
    if (plan.widths) return left + plan.widths.slice(0, line).reduce((a, x) => a + x, 0);
    return this.cols[line] ?? left;
  }

  /**
   * When cells of this table are selected whole (or the selection runs across cells of it) and the
   * column border grabbed at page y `y` is one of theirs, in one of their rows, the drag moves it
   * only in those rows (`only`), as Word does. Not the table's left edge, nor a border of a cell
   * merged down into rows outside the selection. Text within one cell isn't a cell selection.
   */
  limitToSelection(S, y) {
    this.only = [];
    if (this.edge.kind !== 'column') return;
    const line = this.edge.line;
    if (line === 0) return;
    const t = S.d.table(this.story, this.table);
    if (!t) return;
    const block = this.selectedBlock(S, t);
    if (!block) return;
    const [[r0, r1], [lo, hi]] = block;
    const here = this.rows.find(r => y >= r.top && y <= r.bottom)?.row;
    if (line < lo || line > hi || here === undefined || here < r0 || here > r1) return;
    const only = [];
    for (let r = r0; r <= r1; r++) {
      const row = t.rows[r];
      if (!row) break;
      const lines = [0];
      for (const cell of row.cells) {
        const g = lines[lines.length - 1] ?? 0;
        const end = g + cellSpan(cell);
        // A merged cell that goes on above or below the selection keeps one width.
        const below = () => { const ci = cellAtGrid(t, r + 1, g); return ci !== null && ci !== undefined && vmergeOf(t.rows[r + 1]?.cells[ci]) === 'continue'; };
        const past = (r === r0 && vmergeOf(cell) === 'continue') || (r === r1 && vmergeOf(cell) !== 'none' && below());
        if (past && (g === line || end === line)) return;
        lines.push(end);
      }
      only.push([r, lines]);
    }
    this.only = only;
  }

  /** The selected cells of this table as [[firstRow, lastRow], [leftLine, rightLine]], or null. */
  selectedBlock(S, t) {
    const lines = cells => {
      if (!cells.length) return null;
      const lo = Math.min(...cells.map(([r, c]) => gridCol(t, r, c)));
      const hi = Math.max(...cells.map(([r, c]) => gridCol(t, r, c) + cellSpan(t.rows[r]?.cells[c])));
      return [lo, hi];
    };
    const range = S.cells;
    if (range && range.story === this.story && samePath(range.table, this.table)) {
      const l = lines(T.rangeCells(range, t));
      return l ? [[...range.rows], l] : null;
    }
    const [a, b] = T.ordered(S.sel);
    if (T.isCollapsed(S.sel) || a.story !== this.story || b.story !== this.story) return null;
    const ca = cellIn(this.table, a.path), cb = cellIn(this.table, b.path);
    if (!ca || !cb || (ca[0] === cb[0] && ca[1] === cb[1])) return null;
    const l = lines([ca, cb]);
    return l ? [[Math.min(ca[0], cb[0]), Math.max(ca[0], cb[0])], l] : null;
  }
}

/**
 * Moves the border right of column `i` of `w` (column widths, changed in place) by up to `dx`
 * points, `share` saying who makes up the difference, no column narrower than MIN_COL: how far it
 * moved, or null when there's no column `i` (share_out).
 */
export function shareOut(w, i, dx, share) {
  if (i < 0 || i >= w.length) return null;
  const left = w[i];
  const rest = w.slice(i + 1).reduce((a, x) => a + x, 0);
  const narrowest = w.slice(i + 1).reduce((a, x) => Math.min(a, x), Infinity);
  // On the table's right edge (or with no room on the right) only the left column changes.
  if (share === 'neighbour' && i + 1 < w.length) share = 'neighbour';
  else if (share === 'proportional' && rest > 0 && narrowest > 0) share = 'proportional';
  else share = 'leftOnly';
  const least = MIN_COL - left;
  let d;
  if (share === 'neighbour') d = clamp(dx, least, Math.max((w[i + 1] ?? 0) - MIN_COL, least));
  // As far as the narrowest column on the right, shrunk in proportion, stays MIN_COL.
  else if (share === 'proportional') d = clamp(dx, least, Math.max(rest * (1 - Math.min(MIN_COL / narrowest, 1)), least));
  else d = clamp(left + dx, MIN_COL, MAX_LEN) - left;
  w[i] = left + d;
  if (share === 'neighbour') w[i + 1] -= d;
  else if (share === 'proportional') for (let k = i + 1; k < w.length; k++) w[k] *= (rest - d) / rest;
  return d;
}

/** The [row, cell] of the table at `tp` that a position at path `p` is in (cell_in). */
function cellIn(tp, p) {
  const n = tp.length;
  if (p.length < n + 3 || !startsWith(p, tp)) return null;
  return [p[n], p[n + 1]];
}

/** Every table cell's area on a page: [{rect, table, story, row, cell, covered}] (cell_boxes). */
export function cellBoxes(l, page) {
  const pg = l?.pages?.[page];
  if (!pg) return [];
  return pg.items.filter(it => it.kind === 'cell').map(it => ({rect: it.rect, table: it.table, story: it.story, row: it.row, cell: it.cell, covered: !!it.covered}));
}

/** The drawn geometry of one table on a page, from its cells' boxes: [cols, rows] or null (geometry). */
function geometry(t, boxes) {
  const n = tableCols(t);
  if (n === 0 || n > MAX_COLS || !boxes.length) return null;
  const lines = new Array(n + 1).fill(null);
  const rows = [];
  for (const b of boxes) {
    const g = gridCol(t, b.row, b.cell);
    const span = cellSpan(t.rows[b.row]?.cells[b.cell]);
    const end = Math.min(g + span, n);
    if (g <= n && lines[g] === null) lines[g] = b.rect.x;
    if (lines[end] === null) lines[end] = right(b.rect);
    // A vertically merged cell's box spans all its rows, so a row ends at its shortest box.
    const r = rows.find(x => x.row === b.row);
    if (r) { r.top = Math.min(r.top, b.rect.y); r.bottom = Math.min(r.bottom, bottom(b.rect)); r.edges.push(g, end); } else rows.push({row: b.row, top: b.rect.y, bottom: bottom(b.rect), edges: [g, end]});
  }
  // A line no cell on this page ends at: between its drawn neighbours, as the grid shares it.
  const first = lines[0], last = lines[n];
  if (first === null || last === null) return null;
  const weight = i => { const w = t.grid[i]; return t.grid.length === n && fin(w) && w > 0 ? w : 1; };
  const cols = [];
  let prev = [0, first];
  for (let i = 0; i <= n; i++) {
    let x = lines[i];
    if (x === null) {
      let next = [n, last];
      for (let j = i + 1; j <= n; j++) if (lines[j] !== null) { next = [j, lines[j]]; break; }
      let span = 0, part = 0;
      for (let k = prev[0]; k < next[0]; k++) span += weight(k);
      for (let k = prev[0]; k < i; k++) part += weight(k);
      x = prev[1] + (next[1] - prev[1]) * (span > 0 ? part / span : 0);
    }
    x = Math.max(x, cols.length ? cols[cols.length - 1] : x);
    if (lines[i] !== null) prev = [i, x];
    cols.push(x);
  }
  rows.sort((a, b) => a.row - b.row);
  // A row whose every cell starts a vertical merge has only boxes that span further: it ends where the next row starts.
  for (let i = 0; i + 1 < rows.length; i++) {
    const r = rows[i], next = rows[i + 1];
    if (next.row === r.row + 1 && next.top < r.bottom) r.bottom = Math.max(next.top, r.top);
  }
  return [cols, rows];
}

/** Every table drawn on a page, with its geometry there (`edge` is a placeholder) (tables_on). */
export function tablesOn(l, content, page) {
  const boxes = cellBoxes(l, page);
  const tables = [];
  for (const b of boxes) if (!tables.some(([st, p]) => st === b.story && samePath(p, b.table))) tables.push([b.story, b.table]);
  const out = [];
  for (const [story, path] of tables) {
    const t = tableOf(content, story, path);
    if (!t) continue;
    const g = geometry(t, boxes.filter(b => b.story === story && samePath(b.table, path)));
    if (!g) continue;
    const [cols, rows] = g;
    const endsHere = rows.length > 0 && rows[rows.length - 1].row + 1 === t.rows.length;
    out.push(new ResizeTarget({edge: Edge.corner, story, table: [...path], cols, rows, endsHere, only: []}));
  }
  return out;
}

/** The table at `path` of `story` in a model Document or in content. */
function tableOf(doc, story, path) {
  if (typeof doc?.table === 'function') return doc.table(story, path);
  return null;
}

function onHandle(t, x, y, reach) {
  const h = t.handle();
  return t.endsHere && x >= h.x - reach / 2 && x <= right(h) + reach / 2 && y >= h.y - reach / 2 && y <= bottom(h) + reach / 2;
}
const cleanReach = reach => (fin(reach) ? clamp(reach, 0.5, 24) : REACH);

/** The innermost table under page point (x, y) whose resize handle is on this page, or whose handle is under the point (table_under). */
export function tableUnder(l, doc, page, x, y, reach = REACH) {
  if (!fin(x) || !fin(y)) return null;
  reach = cleanReach(reach);
  let best = null;
  for (const t of tablesOn(l, doc, page)) {
    if (!(t.endsHere && ((x >= t.left() && x <= t.right() && y >= t.top() && y <= t.bottom()) || onHandle(t, x, y, reach)))) continue;
    if (!best || t.table.length >= best.table.length) best = t;
  }
  return best;
}

/** The table border or resize handle within `reach` points of page point (x, y): the nearest, and of nested tables the innermost (resize_target). */
export function resizeTarget(l, doc, page, x, y, reach = REACH) {
  if (!fin(x) || !fin(y)) return null;
  reach = cleanReach(reach);
  let best = null;
  for (const target of tablesOn(l, doc, page)) {
    const depth = target.table.length;
    const offer = (d, edge) => {
      if (d <= reach && (!best || d < best.d - 0.01 || (d <= best.d + 0.01 && depth > best.depth))) {
        const t = target.clone();
        t.edge = edge;
        best = {d, depth, t};
      }
    };
    if (onHandle(target, x, y, reach)) offer(0, Edge.corner);
    const left = target.left(), rgt = target.right(), top = target.top(), bot = target.bottom();
    if (x < left - reach || x > rgt + reach || y < top - reach || y > bot + reach) continue;
    // Column borders: in the row under the pointer, only lines that are cell borders there.
    const here = target.rows.find(r => y >= r.top && y <= r.bottom);
    if (here) {
      for (let line = 0; line < target.cols.length; line++) {
        // The table's left edge is grabbed from outside it (a point in, for the border's width): inside starts the first cell.
        if (here.edges.includes(line) && (line > 0 || x <= left + 1)) offer(Math.abs(x - target.cols[line]), Edge.column(line));
      }
    }
    // Row borders: the bottom of each drawn row.
    if (x >= left && x <= rgt) for (const r of target.rows) offer(Math.abs(y - r.bottom), Edge.row(r.row));
  }
  return best ? best.t : null;
}

/** Moves `t`'s left edge `by` points: its indent, or a floating table's offset; [table, moved] (move_left_edge). */
function moveLeftEdge(t, by) {
  const p = {...(t.props ?? {})};
  if (p.float) {
    const f = {...p.float};
    delete f.hAlign;
    f.x = clamp((f.x ?? 0) + by, -MAX_LEN, MAX_LEN);
    return [{...t, props: {...p, float: f}}, true];
  }
  // A centred or right-aligned table keeps its alignment, as in Word: only the first column changes.
  if (p.align === 'center' || p.align === 'right') return [t, false];
  p.indent = clamp((p.indent ?? 0) + by, -MAX_LEN, MAX_LEN);
  return [{...t, props: p}, true];
}

/**
 * Sets `t`'s grid when some rows' cells change width on their own: `rows` gives their new widths,
 * left to right; the other rows keep their cells' borders where they are drawn (grid lines `cols`)
 * (regrid).
 */
function regrid(t, cols, rows) {
  const left = cols[0] ?? 0;
  const last = Math.max(cols.length - 1, 0);
  const borders = t.rows.map((row, r) => {
    const mine = rows.find(([i, w]) => i === r && w.length === row.cells.length);
    const out = [0];
    if (mine) { let x = 0; for (const cw of mine[1]) { x += cw; out.push(x); } } else {
      let g = 0;
      for (const c of row.cells) { g += cellSpan(c); out.push((cols[Math.min(g, last)] ?? left) - left); }
    }
    return out;
  });
  const lines = borders.flat().sort((a, b) => a - b);
  // dedup_by: a line within 0.01 of the last kept one is the same line.
  const kept = [];
  for (const x of lines) if (!kept.length || Math.abs(x - kept[kept.length - 1]) >= 0.01) kept.push(x);
  if (kept.length > MAX_COLS + 1) throw failed(`a table can't have more than ${MAX_COLS} columns`);
  const lineAt = x => { let bi = 0, bd = Infinity; kept.forEach((v, i) => { const d = Math.abs(v - x); if (d < bd) { bd = d; bi = i; } }); return bi; };
  const spans = borders.map(b => {
    const at = b.map(lineAt);
    const row = [];
    for (let i = 1; i < at.length; i++) row.push(Math.max(at[i] - at[i - 1], 0));
    if (row.includes(0)) throw failed('the cells there are too narrow to move that border');
    return row;
  });
  const grid = [];
  for (let i = 1; i < kept.length; i++) grid.push(kept[i] - kept[i - 1]);
  const out = {...t, grid, rows: t.rows.map((row, r) => ({...row, cells: row.cells.map((c, ci) => (spans[r][ci] === undefined ? c : {...c, props: {...(c.props ?? {}), span: spans[r][ci]}}))}))};
  return syncCellWidths(withoutWidth(out));
}

const withoutWidth = t => { const p = {...(t.props ?? {})}; delete p.width; delete p.widthPct; return {...t, props: p}; };

/** Make `widths` (one per grid column) the table's column widths, as drawn: no preferred table width scales them again (set_widths). */
export function setWidths(t, widths) {
  if (widths.length !== tableCols(t)) return t;
  return syncCellWidths(withoutWidth({...t, grid: [...widths]}));
}

/** The page x of the target table's left edge on `page`, as drawn (drawn_left). */
function drawnLeft(l, page, target) {
  const xs = cellBoxes(l, page).filter(b => b.story === target.story && samePath(b.table, target.table)).map(b => b.rect.x);
  return xs.length ? Math.min(...xs) : null;
}

/** The drawn height of each of the target table's rows on `page` (drawn_heights). */
function drawnHeights(l, doc, page, target) {
  const t = tablesOn(l, doc, page).find(x => x.story === target.story && samePath(x.table, target.table));
  return t ? t.rows.map(r => [r.row, r.bottom - r.top]) : [];
}

const setRowHeight = (t, r, h, rule) => ({...t, rows: t.rows.map((row, i) => (i === r ? {...row, props: {...(row.props ?? {}), height: h, ...(rule ? {heightRule: rule} : {})}} : row))});

/** The layout of the command's current (possibly uncommitted) content. */
export const layoutOfS = S => {
  // The model Document edits its own copy of the content in place once it owns it, so a content
  // changed during this command is handed over as a new object: the layout is redone for it
  // (upstream's `touch` + `layout()`), not served from the cache of the content it started from.
  const c = S.d.c;
  return layoutFor(S.ctx, c === S.ctx.doc ? c : {...c});
};

/** `page`, `x`, `y` and the resize `reach` of a click (point). */
export function pagePoint(p) {
  if (typeof p.page !== 'number' || !Number.isFinite(p.page) || p.page < 0) throw badParams('`page` (number) is required');
  for (const k of ['x', 'y']) if (typeof p[k] !== 'number') throw badParams(`\`${k}\` (number) is required`);
  return [Math.floor(p.page), p.x, p.y, typeof p.reach === 'number' ? p.reach : REACH];
}

function resizeDrag(S, p) {
  const [page, x, y, reach] = pagePoint(p);
  for (const k of ['toX', 'toY']) if (typeof p[k] !== 'number') throw badParams(`\`${k}\` (number) is required`);
  // Ctrl wins over Shift, as in Word.
  const share = p.ctrl ? 'proportional' : shareOf(!!p.shift);
  const l = layoutOfS(S);
  if (!l?.pages[page]) throw badParams(`no page ${page}`);
  const target = resizeTarget(l, S.d, page, x, y, reach);
  if (!target) throw failed('there\'s no table border or resize handle there');
  target.limitToSelection(S, y);
  const plan = target.plan(p.toX - x, p.toY - y, share);
  if (!plan.widths && !plan.heights.length && !plan.cells.length) return T.finish(S);
  const {story, table: tp} = target;
  let moved = false;
  S.d.updateTable(story, tp, t => {
    if (plan.widths) t = setWidths(t, plan.widths);
    for (const [r, h] of plan.heights) {
      const row = t.rows[r];
      if (row) t = setRowHeight(t, r, h, row.props?.heightRule === 'exact' ? null : 'atLeast');
    }
    if (plan.indentBy !== null) [t, moved] = moveLeftEdge(t, plan.indentBy);
    if (plan.cells.length) t = regrid(t, target.cols, plan.cells);
    return t;
  });
  // Where a moved left edge lands isn't always its indent or offset alone (a floating table's
  // anchor): measure where it came to and put it right once.
  if (moved && plan.indentBy !== null) {
    const got = drawnLeft(layoutOfS(S), page, target);
    const want = target.left() + plan.indentBy;
    if (got !== null && Math.abs(got - want) > 0.05) S.d.updateTable(story, tp, t => moveLeftEdge(t, want - got)[0]);
  }
  if (!plan.heights.length) return T.finish(S);
  // An "at least" height leaves out the cells' margins and border bands, which the layout adds, and
  // an exact one the bottom margin: measure what the rows came to and take the extra off once. A
  // row its text holds taller keeps the dragged height.
  const drawn = drawnHeights(layoutOfS(S), S.d, page, target);
  const fixed = [];
  S.d.updateTable(story, tp, t => {
    for (const [r, want] of plan.heights) {
      const got = drawn.find(([i]) => i === r)?.[1];
      if (got === undefined) continue;
      const row = t.rows[r];
      const rule = row?.props?.heightRule;
      if (row && (rule === 'atLeast' || rule === 'exact') && got > want + 0.05) {
        t = setRowHeight(t, r, Math.max(want - (got - want), 1));
        fixed.push([r, want, got]);
      }
    }
    return t;
  });
  if (!fixed.length) return T.finish(S);
  const again = drawnHeights(layoutOfS(S), S.d, page, target);
  S.d.updateTable(story, tp, t => {
    for (const [r, want, got] of fixed) {
      const now = again.find(([i]) => i === r)?.[1] ?? got;
      if (now >= got - 0.05 && t.rows[r]) t = setRowHeight(t, r, want);
    }
    return t;
  });
  return T.finish(S);
}

const run = f => (ctx, p) => f(T.open(ctx), p ?? {});
const num = () => s.number();
const optNum = () => s.optional(s.number());

export default defineCommands({
  family: 'table_resize',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'table.resizeDrag', label: 'Resize Table by Dragging', risk: 'edit', state: T.ready,
      description: 'Resize Table by Dragging (Table Layout › Cell Size): a mouse drag in page points from a table border or the resize handle. A column border moves (the column to its right makes up the difference; Ctrl shares it among the columns right of it; Shift, or the right edge, changes only the column left of it); the left edge moves a left-aligned table\'s indent; with cells selected a border of theirs moves only in their rows; a row\'s bottom border sets its height; the handle past the bottom-right corner scales the table.',
      params: s.object({page: num(), x: num(), y: num(), toX: num(), toY: num(), shift: s.optional(s.boolean()), ctrl: s.optional(s.boolean()), reach: optNum()}),
      run: run(resizeDrag)},
  ],
});
