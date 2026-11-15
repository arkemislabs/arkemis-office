// The rest of Word's table mouse (resizing is table_resize): selection areas just above a column,
// left of a row and along a cell's left edge inside it select the column, row or cell, and a drag
// from one selects every one up to the pointer; insert buttons left of a row border and above a
// column border add a row or column there; the move handle just past the table's top-left corner
// selects the table or, dragged, moves it (the table then floats where it's dropped, the text
// wrapping around it, as in Word); a double-click on a column border fits the column left of it to
// its contents. The page view sends each click or finished drag here in page points, so each is
// one command (one undo step when it changes the document).
//
// Translated from wordcraft crates/engine/src/cmd/table_mouse.rs (COLUMN_ABOVE, COLUMN_BELOW,
// ROW_LEFT, CELL_EDGE, INSERT_REACH, INSERT_OUT, BUTTON_OUT, HANDLE, HANDLE_GAP, MAX_MOVE, Spot,
// Target, InsertMark, handle, starts_here, on_handle, clean_reach, nearest, column_at, row_at,
// spot_in, row_bar, target_at, handle_table, caret_handles, insert_mark, movable, moved_to,
// cell_rects, selection_rects, row_taken, outer_row_taken, point, target, select_at, anchor_row,
// beside_line, insert_at, corner, move_drag, fit_column, room_right) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The geometry helpers are exported for the page view (cursor shapes, the insert buttons, the
// move handle, cell shading).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {cellResolvedMargins} from '../model/props.mjs';
import {tableStyle} from '../model/styles.mjs';
import {cellSpan, rowFirstGrid, tableCols} from '../model/table.mjs';
import {pageLines} from '../layout/hit.mjs';
import {cmpPos} from '../model/document.mjs';
import * as T from '../lib/table-session.mjs';
import {measureTableColumns} from '../lib/table-measure.mjs';
import {REACH, cellBoxes, layoutOfS, pagePoint, resizeTarget, setWidths, tablesOn} from './table_resize.mjs';
import {insertColAt, insertRowAt} from './table.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/table_mouse.rs']};
const {failed, params: badParams} = T;

/** The column selection area: from this far above a table's top border (points) to this far below it. */
const COLUMN_ABOVE = 6.0;
const COLUMN_BELOW = 1.5;
/** How far left of a table (points) the row selection area and the row insert buttons reach. */
const ROW_LEFT = 24.0;
/** The cell selection area's width inside a cell's left edge (points), at the least. */
const CELL_EDGE = 5.5;
/** The insert buttons answer this near a border (points), and above the table this far out. */
const INSERT_REACH = 3.5;
const INSERT_OUT = 14.0;
/** An insert button's centre sits this far out from the table's edge (points). */
const BUTTON_OUT = 8.0;
/** The move handle's side and its gap from the table's top-left corner (points). */
const HANDLE = 8.0;
const HANDLE_GAP = 2.0;
/** The farthest a drag moves a table (points; Word's 22 inches). */
const MAX_MOVE = 1584.0;
/** Word's default cell margins (top, left, bottom, right) when neither the table nor its style sets them. */
const DEFAULT_MARGINS = [0, 5.4, 0, 5.4];

const fin = Number.isFinite;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const right = r => r.x + r.w;
const bottom = r => r.y + r.h;
const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const startsWith = (p, pre) => p.length >= pre.length && pre.every((v, i) => p[i] === v);

/**
 * What the pointer is over (Spot): {kind: 'handle'} | {kind: 'insertRow', line} (0 = the table's
 * top, n = the bottom of row n - 1) | {kind: 'insertColumn', line} (0 = the left edge) |
 * {kind: 'column', col} | {kind: 'row', row} | {kind: 'cell', row, cell}.
 */
export const Spot = Object.freeze({
  handle: Object.freeze({kind: 'handle'}),
  insertRow: line => ({kind: 'insertRow', line}), insertColumn: line => ({kind: 'insertColumn', line}),
  column: col => ({kind: 'column', col}), row: row => ({kind: 'row', row}), cell: (row, cell) => ({kind: 'cell', row, cell}),
});

/** The move handle's square (page points), just past the table's top-left corner. */
export function handle(geom) {
  return {x: geom.left() - HANDLE_GAP - HANDLE, y: geom.top() - HANDLE_GAP - HANDLE, w: HANDLE, h: HANDLE};
}
/** Whether the table's first row is on this page (its move handle is there). */
const startsHere = geom => geom.rows[0]?.row === 0;
function onHandle(geom, x, y, reach) {
  const h = handle(geom);
  return startsHere(geom) && x >= h.x - reach / 2 && x <= right(h) + reach / 2 && y >= h.y - reach / 2 && y <= bottom(h) + reach / 2;
}
const cleanReach = reach => (fin(reach) ? clamp(reach, 0.5, 24) : REACH);

/** Of `lines` ([index, position]), the one nearest `at` within `reach`. */
function nearest(lines, at, reach) {
  let best = null;
  for (const [i, v] of lines) { const d = Math.abs(at - v); if (d <= reach && (!best || d < best[1])) best = [i, d]; }
  return best ? best[0] : null;
}
/** The grid column at page x `x` (the first or the last beyond the table). */
function columnAt(geom, x) {
  const n = Math.max(geom.cols.length - 1, 0);
  let k = 0;
  for (const cx of geom.cols.slice(1)) { if (cx <= x) k++; else break; }
  return Math.min(k, Math.max(n - 1, 0));
}
/** The drawn row at page y `y` (the first or the last beyond the table). */
function rowAt(geom, y) {
  return (geom.rows.find(r => y < r.bottom) ?? geom.rows[geom.rows.length - 1])?.row ?? 0;
}

/** The spot of one table at (x, y): the handle, then the insert buttons, then the selection areas (spot_in). */
function spotIn(geom, cells, x, y, reach, bar) {
  if (onHandle(geom, x, y, reach)) return Spot.handle;
  const left = geom.left(), rgt = geom.right(), top = geom.top(), bot = geom.bottom();
  // Above the table: the insert buttons over its column borders, and the column areas.
  if (y >= top - INSERT_OUT && y <= top + COLUMN_BELOW && x >= left - INSERT_REACH && x <= rgt + INSERT_REACH) {
    const lines = geom.cols.map((v, i) => [i, v]).filter(([i]) => geom.rows.some(r => r.edges.includes(i)));
    if (y < top) { const line = nearest(lines, x, INSERT_REACH); if (line !== null) return Spot.insertColumn(line); }
    if (y >= top - COLUMN_ABOVE && x >= left && x <= rgt) return Spot.column(columnAt(geom, x));
  }
  // Left of the table: the insert buttons beside its row borders, and the row areas.
  if (x >= left - ROW_LEFT && x < left && y >= top - INSERT_REACH && y <= bot + INSERT_REACH) {
    const borders = geom.rows.flatMap(r => [[r.row, r.top], [r.row + 1, r.bottom]]);
    const line = nearest(borders, y, INSERT_REACH);
    if (line !== null) return Spot.insertRow(line);
    const r = geom.rows.find(r => y >= r.top && y <= r.bottom);
    if (r) return Spot.row(r.row);
  }
  // The page margin beside the table is the selection bar: a row's area too.
  if (bar && x >= bar[0] && x <= bar[1]) {
    const r = geom.rows.find(r => y >= r.top && y <= r.bottom);
    if (r) return Spot.row(r.row);
  }
  // Inside a cell, along its left edge.
  const edge = Math.max(CELL_EDGE, reach + 2.5);
  const b = cells.find(b => x >= b.rect.x && x <= b.rect.x + edge && y >= b.rect.y && y <= bottom(b.rect));
  return b ? Spot.cell(b.row, b.cell) : null;
}

/**
 * The x range of the selection bar beside the table's row at page height `y`: the page margin on
 * the table's leading side. Only a non-floating table of the main text has one, and only where no
 * line of the text lies between the two at that height (row_bar).
 */
function rowBar(l, doc, page, geom, y) {
  const p = l.pages[page];
  if (!p || geom.story !== 'body' || geom.table.length !== 1) return null;
  const t = doc.table(geom.story, geom.table);
  const row = geom.rows.find(r => y >= r.top && y <= r.bottom);
  if (!t || !row || t.props?.float) return null;
  const rtl = !!t.props?.bidiVisual;
  const blocked = pageLines(p, 'body').some(ln => ln.path.length <= 1 && ln.top < row.bottom - 0.5 && ln.bottom > row.top + 0.5
    && (rtl ? ln.right > geom.right() : ln.left < geom.left()));
  if (blocked) return null;
  return rtl ? [Math.max(geom.right(), right(p.body)), p.w] : [0, Math.min(geom.left(), p.body.x)];
}

/**
 * The spot under page point (x, y) of a table in `story`, of nested tables the innermost's: {spot,
 * geom}. Null on a column or row border or the resize handle: those resize (target_at).
 */
export function targetAt(l, doc, story, page, x, y, reach = REACH) {
  if (!fin(x) || !fin(y)) return null;
  reach = cleanReach(reach);
  if (resizeTarget(l, doc, page, x, y, reach)) return null;
  const boxes = cellBoxes(l, page);
  let best = null;
  for (const geom of tablesOn(l, doc, page)) {
    if (geom.story !== story) continue;
    const cells = boxes.filter(b => b.story === geom.story && samePath(b.table, geom.table));
    const spot = spotIn(geom, cells, x, y, reach, rowBar(l, doc, page, geom, y));
    if (spot && (!best || geom.table.length >= best.geom.table.length)) best = {spot, geom};
  }
  return best;
}

/** The table whose move handle shows with the pointer at (x, y) (handle_table). */
export function handleTable(l, doc, story, page, x, y, reach = REACH) {
  if (!fin(x) || !fin(y)) return null;
  const pad = cleanReach(reach) / 2;
  let best = null;
  for (const g of tablesOn(l, doc, page)) {
    const h = handle(g);
    if (g.story === story && startsHere(g) && x >= h.x - pad && x <= g.right() && y >= h.y - pad && y <= g.bottom() && (!best || g.table.length >= best.table.length)) best = g;
  }
  return best;
}

/** The move and resize handles of a table on a page while the caret is in it: [move, resize] rects or null (caret_handles). */
export function caretHandles(l, doc, story, table, page) {
  const rows = doc.table(story, table)?.rows.length ?? 0;
  const hasRow = (p, r) => !!l.pages[p]?.items.some(it => it.kind === 'cell' && it.story === story && samePath(it.table, table) && it.row === r);
  // A repeated header row, or a row running on to the next page, is drawn on more than one page:
  // the handles go where the table starts and where it ends.
  const first = hasRow(page, 0) && !(page > 0 && hasRow(page - 1, 0));
  const last = rows > 0 && hasRow(page, rows - 1) && !hasRow(page + 1, rows - 1);
  if (!first && !last) return [null, null];
  const g = tablesOn(l, doc, page).find(g => g.story === story && samePath(g.table, table));
  if (!g) return [null, null];
  return [first ? handle(g) : null, last ? g.handle() : null];
}

/** The insert button a target is: {center, from, to} (page points) or null (insert_mark). */
export function insertMark(t) {
  const g = t.geom;
  if (t.spot.kind === 'insertRow') {
    const line = t.spot.line;
    const y = g.rows.find(r => r.row + 1 === line)?.bottom ?? g.rows.find(r => r.row === line)?.top;
    if (y === undefined) return null;
    return {center: [g.left() - BUTTON_OUT, y], from: [g.left(), y], to: [g.right(), y]};
  }
  if (t.spot.kind === 'insertColumn') {
    const x = g.cols[t.spot.line];
    if (x === undefined) return null;
    return {center: [x, g.top() - BUTTON_OUT], from: [x, g.top()], to: [x, g.bottom()]};
  }
  return null;
}

/** Whether dragging the move handle moves the table: tables in the main text, not nested ones. */
export const movable = geom => geom.story === 'body' && geom.table.length === 1;

/** Where a move-handle drag by (dx, dy) puts the table's top-left corner on `page` (moved_to). */
export function movedTo(l, page, geom, dx, dy) {
  const clean = d => (fin(d) ? clamp(d, -MAX_MOVE, MAX_MOVE) : 0);
  const w = geom.right() - geom.left(), h = geom.bottom() - geom.top();
  const pg = l.pages[page];
  const pageW = pg?.w ?? 0, bodyBottom = pg ? bottom(pg.body) : 0;
  return [clamp(geom.left() + clean(dx), 0, Math.max(pageW - w, 0)), clamp(geom.top() + clean(dy), 0, Math.max(bodyBottom - h, 0))];
}

/** Where the selected cells (a CellRange) are drawn: [[page, rect]] (cell_rects). */
export function cellRects(l, doc, range) {
  const t = doc.table(range.story, range.table);
  if (!t) return [];
  const picked = new Set(T.rangeCells(range, t).map(([r, c]) => `${r},${c}`));
  const out = [];
  l.pages.forEach((pg, pi) => {
    // A vertically merged cell's box spans its rows; its continuation rows' covered boxes would shade it twice.
    for (const it of pg.items) if (it.kind === 'cell' && !it.covered && it.story === range.story && samePath(it.table, range.table) && picked.has(`${it.row},${it.cell}`)) out.push([pi, it.rect]);
  });
  return out;
}

/** The [start, end] positions of row `r` of the table at `tp` (row_ends). */
const rowEnds = (doc, story, tp, r) => T.rowEnds(doc, story, tp, r);
const cmpPath = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
const samePos = (a, b) => a && b && a.story === b.story && a.off === b.off && samePath(a.path, b.path);

/** Whether the selection a..b (in order, one story) takes row `r` of table `tp` whole (row_taken). */
function rowTaken(doc, a, b, tp, r, seen) {
  const key = `${tp.join('.')}#${r}`;
  if (seen.has(key)) return seen.get(key);
  const inside = p => p.path.length > tp.length && startsWith(p.path, tp);
  let taken;
  if (inside(a) && inside(b)) taken = false;
  else {
    const row = [...tp, r];
    const aIn = startsWith(a.path, row), bIn = startsWith(b.path, row);
    const ends = aIn || bIn ? rowEnds(doc, a.story, tp, r) : null;
    const from = aIn ? !!ends && samePos(ends[0], a) : cmpPath(a.path, row) < 0;
    const to = bIn ? !!ends && samePos(ends[1], b) : cmpPath(b.path, row) > 0;
    taken = from && to;
  }
  seen.set(key, taken);
  return taken;
}
/** Whether a row of a table that table `tp` is nested in is taken whole (outer_row_taken). */
function outerRowTaken(doc, a, b, tp, seen) {
  let p = tp;
  while (p.length >= 4) {
    const outer = p.slice(0, p.length - 3), r = p[p.length - 3];
    if (rowTaken(doc, a, b, outer, r, seen)) return true;
    p = outer;
  }
  return false;
}

/**
 * What a stream selection from `a` to `b` shades, as in Word: its text, except that each row of a
 * table it takes from start to end shades all its cells instead (selection_rects).
 */
export function selectionRects(l, doc, a, b, pageHint = 0) {
  const text = l.rectsForRange(a, b, pageHint);
  if (cmpPos(a, b) > 0) [a, b] = [b, a];
  if (a.story !== b.story) return text;
  const seen = new Map();
  const cells = [];
  l.pages.forEach((pg, pi) => {
    for (const it of pg.items) {
      if (it.kind === 'cell' && !it.covered && it.story === a.story && rowTaken(doc, a, b, it.table, it.row, seen) && !outerRowTaken(doc, a, b, it.table, seen)) cells.push([pi, it.rect]);
    }
  });
  if (!cells.length) return text;
  const inRect = (r, x, y) => x >= r.x && x <= right(r) && y >= r.y && y <= bottom(r);
  const out = text.filter(([pi, r]) => !cells.some(([cp, c]) => cp === pi && inRect(c, r.x + r.w / 2, r.y + r.h / 2)));
  return [...out, ...cells];
}

/** The spot under the click, in the caret's story (target). */
function target(S, page, x, y, reach) {
  const l = layoutOfS(S);
  if (!l?.pages[page]) throw badParams(`no page ${page}`);
  const t = targetAt(l, S.d, S.sel.focus.story, page, x, y, reach);
  if (!t) throw failed('there\'s no table selection area or button there');
  return t;
}

/**
 * The row a Shift+click on row `clicked` of table `tp` extends from: the end of the selected rows
 * farther from it, or the caret's row; the clicked row itself when nothing of the table is
 * selected (anchor_row).
 */
export function anchorRow(S, tp, clicked) {
  const range = S.cells;
  if (range && samePath(range.table, tp)) return clicked >= range.rows[0] ? range.rows[0] : range.rows[1];
  const ap = S.sel.anchor.path;
  if (ap.length >= 4) {
    const t = ap.slice(0, ap.length - 3);
    if (samePath(t, tp)) return ap[ap.length - 3];
  }
  return clicked;
}

function selectAt(S, p) {
  const [page, x, y, reach] = pagePoint(p);
  const {spot, geom} = target(S, page, x, y, reach);
  const to = typeof p.toX === 'number' && typeof p.toY === 'number' ? [p.toX, p.toY] : null;
  const story = geom.story;
  const t = S.d.table(story, geom.table);
  if (!t) throw failed('there\'s no table there');
  const lastRow = Math.max(t.rows.length - 1, 0), lastCol = Math.max(tableCols(t) - 1, 0);
  let rows, cols;
  switch (spot.kind) {
    case 'column': rows = [0, lastRow]; cols = [spot.col, to ? columnAt(geom, to[0]) : spot.col]; break;
    case 'row': {
      const r2 = to ? rowAt(geom, to[1]) : spot.row;
      // Shift+click: the rows from the selection's anchor row to the one clicked; a drag after it keeps the anchor the press had (anchorRow).
      const anchor = p.extend ? (typeof p.anchorRow === 'number' ? Math.min(Math.max(0, Math.floor(p.anchorRow)), lastRow) : anchorRow(S, geom.table, spot.row)) : spot.row;
      rows = [anchor, r2]; cols = [0, lastCol];
      break;
    }
    case 'cell': {
      const [g0, g1] = T.gridCols(t, spot.row, spot.cell);
      if (to) { const g = columnAt(geom, to[0]); rows = [spot.row, rowAt(geom, to[1])]; cols = [Math.min(g0, g), Math.max(g1, g)]; } else { rows = [spot.row, spot.row]; cols = [g0, g1]; }
      break;
    }
    case 'handle': rows = [0, lastRow]; cols = [0, lastCol]; break;
    default: throw failed('there\'s an insert button there, not a selection area');
  }
  T.selectRange(S, story, geom.table, rows, cols);
  return T.finish(S);
}

/** A cell to insert a column beside at grid line `line`: [row, cell, after] (beside_line). */
function besideLine(t, line) {
  for (let r = 0; r < t.rows.length; r++) {
    const row = t.rows[r];
    let g = rowFirstGrid(row);
    for (let c = 0; c < row.cells.length; c++) {
      if (g === line) return [r, c, false];
      g += cellSpan(row.cells[c]);
      if (g === line && c + 1 === row.cells.length) return [r, c, true];
    }
  }
  return null;
}

function insertAt(S, p) {
  const [page, x, y, reach] = pagePoint(p);
  const {spot, geom} = target(S, page, x, y, reach);
  const story = geom.story;
  // The row or column goes beside a cell at the border, as Insert Above / Below / Left / Right
  // would put it there; then, as in Word, it's selected.
  let r, c, after, rows, line;
  if (spot.kind === 'insertRow') {
    line = spot.line; rows = true; c = 0;
    if (line >= 1) { r = line - 1; after = true; } else { r = 0; after = false; }
  } else if (spot.kind === 'insertColumn') {
    const t = S.d.table(story, geom.table);
    if (!t) throw failed('there\'s no table there');
    const b = besideLine(t, spot.line);
    if (!b) throw failed('there\'s no column border there');
    [r, c, after] = b; rows = false; line = spot.line;
  } else throw failed('there\'s a selection area there, not an insert button');
  const size = () => { const t = S.d.table(story, geom.table); return t ? `${t.rows.length}x${tableCols(t)}` : null; };
  const before = size();
  T.setCaret(S, {story, path: [...geom.table, r, c, 0], off: 0});
  if (rows) insertRowAt(S, after); else insertColAt(S, after);
  if (size() === before) throw failed('the table can\'t take another row or column');
  const BIG = Number.MAX_SAFE_INTEGER;
  T.selectRange(S, story, geom.table, rows ? [line, line] : [0, BIG], rows ? [0, BIG] : [line, line]);
  return T.finish(S);
}

/** Where table `table` of `story` is first drawn: [page, x, y] of its top-left corner (corner). */
export function corner(l, story, table) {
  for (let pi = 0; pi < l.pages.length; pi++) {
    let acc = null;
    for (const it of l.pages[pi].items) {
      if (it.kind !== 'cell' || it.story !== story || !samePath(it.table, table)) continue;
      acc = acc ? [Math.min(acc[0], it.rect.x), Math.min(acc[1], it.rect.y)] : [it.rect.x, it.rect.y];
    }
    if (acc) return [pi, acc[0], acc[1]];
  }
  return null;
}

function moveDrag(S, p) {
  const [page, x, y, reach] = pagePoint(p);
  for (const k of ['toX', 'toY']) if (typeof p[k] !== 'number') throw badParams(`\`${k}\` (number) is required`);
  const {spot, geom} = target(S, page, x, y, reach);
  if (spot.kind !== 'handle') throw failed('there\'s no table move handle there');
  if (!movable(geom)) throw failed('only a table in the main text can be moved');
  const [gx, gy] = movedTo(layoutOfS(S), page, geom, p.toX - x, p.toY - y);
  if (Math.abs(gx - geom.left()) < 0.01 && Math.abs(gy - geom.top()) < 0.01) return T.finish(S);
  // Dragged, a table floats where it's dropped, the text wrapping around it (Word): placed from its
  // column and the text where it stands, 0.125" from the text at its sides.
  S.d.updateTable(geom.story, geom.table, t => {
    const f = {...(t.props?.float ?? {hRel: 'column', vRel: 'paragraph', x: 0, y: 0, dist: [9, 0, 9, 0], overlap: true})};
    delete f.hAlign; delete f.vAlign;
    return {...t, props: {...(t.props ?? {}), float: f}};
  });
  // Placed by offsets, the table moves as much as they do: one correction from where it landed puts it where it was dropped.
  const c = corner(layoutOfS(S), geom.story, geom.table);
  if (c && c[0] === page) {
    const fix = v => (fin(v) ? clamp(v, -MAX_MOVE, MAX_MOVE) : 0);
    S.d.updateTable(geom.story, geom.table, t => {
      const f = t.props?.float;
      return f ? {...t, props: {...t.props, float: {...f, x: fix((f.x ?? 0) + gx - c[1]), y: fix((f.y ?? 0) + gy - c[2])}}} : t;
    });
  }
  return T.finish(S);
}

/** A cell's resolved margins [top, left, bottom, right] (layout cell_margins). */
export function cellMargins(content, t, r, c) {
  const style = t.props?.style ? tableStyle(content.styles, t.props.style) : null;
  const defaults = t.props?.cellMargins ?? style?.parts?.cellMargins ?? DEFAULT_MARGINS;
  const cell = t.rows[r]?.cells[c];
  return cell ? cellResolvedMargins(cell.props ?? {}, defaults) : [...defaults];
}

/** Where the room right of the table ends on `page` (page x): the right margin, or a nested table's cell's text edge (room_right). */
function roomRight(l, S, page, target) {
  const pg = l.pages[page];
  const margin = pg ? right(pg.body) : target.right();
  const tp = target.table;
  if (tp.length < 4) return margin;
  const outer = tp.slice(0, tp.length - 3), row = tp[tp.length - 3], cell = tp[tp.length - 2];
  const t = S.d.table(target.story, outer);
  if (!t) return margin;
  const b = cellBoxes(l, page).find(b => b.story === target.story && samePath(b.table, outer) && b.row === row && b.cell === cell);
  if (!b) return margin;
  // A right-to-left table has its cells' start (left) margin on their right.
  const m = cellMargins(S.d.c, t, row, cell);
  const inset = t.props?.bidiVisual ? m[1] : m[3];
  return Math.min(right(b.rect) - inset, margin);
}

function fitColumn(S, p) {
  const [page, x, y, reach] = pagePoint(p);
  const l = layoutOfS(S);
  if (!l?.pages[page]) throw badParams(`no page ${page}`);
  const target = resizeTarget(l, S.d, page, x, y, reach);
  if (!target || target.edge.kind !== 'column') throw failed('there\'s no column border there');
  const line = target.edge.line;
  const t = S.d.table(target.story, target.table);
  if (!t) throw failed('there\'s no table there');
  if (line < 1) throw failed('there\'s no column left of that border');
  const g = line - 1;
  const m = measureTableColumns(S.d.c, t)[g];
  if (!m) throw failed('there\'s no such column');
  const [narrowest, widest] = m;
  const current = target.widths()[g] ?? 0;
  // As in Word, the columns right of it keep their widths and move with the border, so the table
  // narrows or widens: up to the right margin, never below the column's narrowest content.
  const room = current + Math.max(roomRight(l, S, page, target) - target.right(), 0);
  const want = Math.min(widest, Math.max(room, narrowest));
  const w = target.plan(want - current, 0, true).widths;
  if (w) S.d.updateTable(target.story, target.table, t0 => setWidths(t0, w));
  return T.finish(S);
}

const run = f => (ctx, p) => f(T.open(ctx), p ?? {});
const num = () => s.number();
const optNum = () => s.optional(s.number());

/**
 * Whether the layout places floating tables. The translated layout lays a floating table out in
 * the text flow (core/quill/layout/table-flow.mjs header), so a dragged table would not be drawn
 * where it was dropped: Move Table stays off until it does (behaviour fidelity: never shown doing
 * something else).
 */
export const FLOATING_TABLES_LAID_OUT = false;
function moveState(ctx) {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  return FLOATING_TABLES_LAID_OUT ? st : {enabled: false, reason: 'Moving a table needs floating tables in the page layout, which is not translated yet'};
}

export default defineCommands({
  family: 'table_mouse',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'table.selectAt', label: 'Select Table Cells by Clicking', risk: 'read', effect: 'view', state: T.ready,
      description: 'Select Table Cells by Clicking (Table Layout › Table › Select): a click in page points on a selection area of a table in the caret\'s story (above a column, left of a row or in the page margin beside it, along a cell\'s left edge, the move handle); with toX/toY (a drag) every column, row or cell up to that point; extend (Shift+click) takes the rows from the selection\'s anchor row, or from anchorRow.',
      params: s.object({page: num(), x: num(), y: num(), toX: optNum(), toY: optNum(), reach: optNum(), extend: s.optional(s.boolean()), anchorRow: optNum()}),
      run: run(selectAt)},
    {id: 'table.insertAt', label: 'Insert Row or Column by Clicking', risk: 'edit', state: T.ready,
      description: 'Insert Row or Column by Clicking (Table Layout › Rows & Columns): a click on a table\'s insert button; left of a row border adds a row there, above a column border a column; the new row or column is selected, as in Word.',
      params: s.object({page: num(), x: num(), y: num(), reach: optNum()}),
      run: run(insertAt)},
    {id: 'table.moveDrag', label: 'Move Table by Dragging', risk: 'edit', state: moveState,
      description: 'Move Table by Dragging (Table Layout › Table): a drag from the move handle past a table\'s top-left corner; the table floats where it\'s dropped, the text wrapping around it; tables in the main text only.',
      params: s.object({page: num(), x: num(), y: num(), toX: num(), toY: num(), reach: optNum()}),
      run: run(moveDrag)},
    {id: 'table.fitColumn', label: 'AutoFit Column by Double-Clicking', risk: 'edit', state: T.ready,
      description: 'AutoFit Column by Double-Clicking (Table Layout › Cell Size): a double-click on a column border; the column left of it fits its contents and the columns right of it keep their widths, so the table narrows or widens (up to the right margin), as in Word.',
      params: s.object({page: num(), x: num(), y: num(), reach: optNum()}),
      run: run(fitColumn)},
  ],
});
