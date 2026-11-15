// Table Layout › Draw: Draw Table and Eraser. A pen stroke on a page either draws a new one-cell
// table (a rectangle outside any table) or splits the cells a straight line crosses; the eraser
// removes the border nearest a point by merging the two cells beside it. Coordinates are page
// points, like the layout's; the page view turns the pen and eraser on as canvas modes and sends
// each finished stroke or click here, so every stroke is one undo step.
//
// Translated from wordcraft crates/engine/src/cmd/table_draw.rs (MIN_RECT, ERASER_REACH, SNAP,
// MIN_LINE, Stroke, cell_boxes, inside, table_at, stroke, page_param, draw, draw_table, crossed,
// offsets, vgroup, Logical, logical, aligned_rows, hide_edge, split_columns, split_rows, finish,
// EraseTarget, erase_target, eraser; the module tests are ported in
// tests/quill/upstream/table_draw_tests.test.mjs) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {border} from '../model/props.mjs';
import * as P from '../model/para.mjs';
import {MAX_COLS, MAX_ROWS, cellAtGrid, cellSpan, emptyCell, gridCol, mergeRight, newTable, vmergeOf} from '../model/table.mjs';
import * as T from '../lib/table-session.mjs';
import {storyParam} from '../lib/caret-session.mjs';
import {syncCellWidths} from './table.mjs';
import {cellBoxes, layoutOfS} from './table_resize.mjs';
import {cellMargins} from './table_mouse.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/table_draw.rs']};
const {failed, params: badParams} = T;

/** A drag shorter than this (points) both ways isn't a rectangle. */
export const MIN_RECT = 12.0;
/** How near (points) the eraser has to be to a border. */
export const ERASER_REACH = 4.0;
/** A line closer than this (points) to an existing border lands on it. */
const SNAP = 3.0;
/** The shortest stroke (points) that counts as a line. */
const MIN_LINE = 6.0;

const fin = Number.isFinite;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const right = r => r.x + r.w;
const bottom = r => r.y + r.h;
const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const inside = (r, x, y) => x >= r.x && x <= right(r) && y >= r.y && y <= bottom(r);

/** The innermost table with a cell under the point: [story, tablePath] or null (table_at). */
function tableAt(boxes, x, y) {
  let best = null;
  for (const b of boxes) if (inside(b.rect, x, y) && (!best || b.table.length >= best.table.length)) best = b;
  return best ? [best.story, best.table] : null;
}

/**
 * Classify a pen stroke (also the page view's live preview): {kind: 'rect', rect} outside a table,
 * {kind: 'vertical', x, y0, y1} or {kind: 'horizontal', y, x0, x1} inside one, else null (stroke).
 */
export function stroke(l, page, x0, y0, x1, y1) {
  if (![x0, y0, x1, y1].every(fin)) return null;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const boxes = cellBoxes(l, page);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  if (tableAt(boxes, x0, y0) || tableAt(boxes, mx, my)) {
    if (dy >= dx && dy >= MIN_LINE && dx <= Math.max(MIN_RECT, dy * 0.2)) return {kind: 'vertical', x: mx, y0: Math.min(y0, y1), y1: Math.max(y0, y1)};
    if (dx > dy && dx >= MIN_LINE && dy <= Math.max(MIN_RECT, dx * 0.2)) return {kind: 'horizontal', y: my, x0: Math.min(x0, x1), x1: Math.max(x0, x1)};
    return null;
  }
  return dx >= MIN_RECT && dy >= MIN_RECT ? {kind: 'rect', rect: {x: Math.min(x0, x1), y: Math.min(y0, y1), w: dx, h: dy}} : null;
}

function pageParam(p) {
  if (typeof p.page !== 'number' || !fin(p.page) || p.page < 0) throw badParams('`page` (number) is required');
  return Math.floor(p.page);
}
const reqNum = (p, k) => { if (typeof p[k] !== 'number') throw badParams(`\`${k}\` (number) is required`); return p[k]; };

function draw(S, p) {
  const page = pageParam(p);
  const x0 = reqNum(p, 'x0'), y0 = reqNum(p, 'y0'), x1 = reqNum(p, 'x1'), y1 = reqNum(p, 'y1');
  const l = layoutOfS(S);
  if (!l?.pages[page]) throw badParams(`no page ${page}`);
  const st = stroke(l, page, x0, y0, x1, y1);
  if (st?.kind === 'rect') return drawTable(S, p, l, page, [x0, y0], st.rect);
  if (st?.kind === 'vertical') return splitColumns(S, l, page, st.x, [st.y0, st.y1]);
  if (st?.kind === 'horizontal') return splitRows(S, l, page, st.y, [st.x0, st.x1]);
  throw failed('draw a rectangle (at least 12 pt each way) outside a table, or a straight horizontal or vertical line across table cells');
}

/** A one-cell table the size of `r`, at the paragraph under the stroke's start (draw_table). */
function drawTable(S, p, l, page, start, r) {
  const story = storyParam(S, p);
  const hit = l.hit(page, start[0], start[1], story);
  if (!hit) throw failed('there\'s no text to put a table at there');
  const pos = S.d.clamp(hit);
  if (T.cellOfPos(pos)) throw failed('draw new tables outside a table; inside one, draw a line to split cells');
  const para = S.d.para(pos.story, pos.path);
  if (!para) throw failed('there\'s no paragraph there');
  const len = para.text.length;
  const tw = Math.max(T.caretTextWidth(S), 18);
  const w = clamp(r.w, 18, tw);
  let t = newTable(1, 1, w, () => S.d.newId());
  const props = {...(t.props ?? {}), width: w};
  const bodyX = l.pages[page]?.body.x ?? 0;
  const indent = r.x - bodyX;
  if (indent > 1) props.indent = Math.min(indent, Math.max(tw - w, 0));
  t = {...t, props, rows: t.rows.map((row, i) => (i === 0 ? {...row, props: {...(row.props ?? {}), height: clamp(r.h, 4, 1584), heightRule: 'atLeast'}} : row))};
  // Before the paragraph when the stroke starts at its beginning (or it's empty), else after it.
  const at = pos.off === 0 || len === 0 ? pos.path : S.d.splitParagraph({...pos, off: len}).path;
  S.d.insertBlock(pos.story, at, t);
  T.setCaret(S, {story: pos.story, path: [...at, 0, 0, 0], off: 0});
  return T.finish(S);
}

/** The cells of one table a stroke crosses: [story, tablePath, [[row, cell, rect]]] or null (crossed). */
function crossed(boxes, at, hit) {
  let found = tableAt(boxes, at[0], at[1]);
  if (!found) {
    let best = null;
    for (const b of boxes) if (hit(b.rect) && (!best || b.table.length >= best.table.length)) best = b;
    found = best ? [best.story, best.table] : null;
  }
  if (!found) return null;
  const [story, table] = found;
  const cells = boxes.filter(b => b.story === story && samePath(b.table, table) && hit(b.rect)).map(b => [b.row, b.cell, b.rect]);
  cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = cells.filter((c, i) => i === 0 || c[0] !== cells[i - 1][0] || c[1] !== cells[i - 1][1]);
  return [story, table, out];
}

/** Grid column offsets: cum[i] is where grid column i starts (offsets). */
function offsets(t) {
  const cum = [0];
  let x = 0;
  for (const w of t.grid) { x += Math.max(w, 0); cum.push(x); }
  return cum;
}

/** The cell index of row `row` that starts at grid column `g`, or null. */
function startsAt(t, row, g) {
  const ci = cellAtGrid(t, row, g);
  if (ci === null || ci === undefined || gridCol(t, row, ci) !== g) return null;
  return t.rows[row]?.cells[ci] ?? null;
}

/** The rows [r0, r1] of the vertically merged group cell c of row r belongs to (vgroup). */
function vgroup(t, r, c) {
  const g = gridCol(t, r, c);
  const cell = startsAt(t, r, g);
  if (!cell || vmergeOf(cell) === 'none') return [r, r];
  let r0 = r;
  while (r0 > 0 && vmergeOf(startsAt(t, r0, g)) === 'continue') r0--;
  let r1 = r;
  while (startsAt(t, r1 + 1, g) && vmergeOf(startsAt(t, r1 + 1, g)) === 'continue') r1++;
  return [r0, r1];
}

/** A cell as the grid rectangle it covers: rows top..=bot, grid columns g0..g1 (logical). */
function logical(t, r, c) {
  const g0 = gridCol(t, r, c);
  const span = cellSpan(t.rows[r]?.cells[c]);
  const [top, bot] = vgroup(t, r, c);
  return {top, bot, g0, g1: g0 + span};
}

/** The rows two side-by-side cells share when erasing the border between them leaves one rectangle (aligned_rows). */
function alignedRows(t, a, b) {
  if (a.top !== b.top || a.bot !== b.bot || a.g1 !== b.g0) return null;
  for (let row = a.top; row <= a.bot; row++) {
    const ci = cellAtGrid(t, row, a.g0);
    if (ci === null || ci === undefined || gridCol(t, row, ci) !== a.g0) return null;
    const cells = t.rows[row]?.cells;
    const x = cells?.[ci], y = cells?.[ci + 1];
    if (!x || !y) return null;
    if (cellSpan(x) !== a.g1 - a.g0 || cellSpan(y) !== b.g1 - b.g0 || vmergeOf(x) !== vmergeOf(y)) return null;
  }
  return [a.top, a.bot];
}

/**
 * Hide the border line on both sides along an edge: no border on every cell beside it (hide_edge).
 * `vertical`: the line sits left of grid column `line`, over rows lo..=hi; otherwise above row
 * `line`, over grid columns lo..hi. `t` is a mutable copy.
 */
function hideEdge(t, vertical, line, [lo, hi]) {
  const nil = () => border('none', 0, null, 0);
  const bordersOf = cell => { cell.props = {...(cell.props ?? {})}; cell.props.borders = {...(cell.props.borders ?? {})}; return cell.props.borders; };
  const setV = (r, g, before) => {
    const ci = cellAtGrid(t, r, g);
    if (ci === null || ci === undefined) return;
    const start = gridCol(t, r, ci);
    const cell = t.rows[r]?.cells[ci];
    if (!cell) return;
    const end = start + cellSpan(cell);
    if (before && end === line) bordersOf(cell).right = nil();
    else if (!before && start === line) bordersOf(cell).left = nil();
  };
  const setH = (r, g, above) => {
    const ci = cellAtGrid(t, r, g);
    if (ci === null || ci === undefined) return;
    const cell = t.rows[r]?.cells[ci];
    if (!cell) return;
    if (above) bordersOf(cell).bottom = nil(); else bordersOf(cell).top = nil();
  };
  if (vertical) {
    for (let r = lo; r <= Math.min(hi, t.rows.length - 1); r++) {
      if (line >= 1) setV(r, line - 1, true);
      setV(r, line, false);
    }
  } else {
    const belowCont = g => { const ci = cellAtGrid(t, line, g); return ci !== null && ci !== undefined && vmergeOf(t.rows[line]?.cells[ci]) === 'continue'; };
    for (let g = lo; g < Math.min(hi, MAX_COLS); g++) {
      if (belowCont(g)) continue;
      if (line >= 1) setH(line - 1, g, true);
      setH(line, g, false);
    }
  }
}

/** A cell with the same formatting as `cell` and nothing in it. */
const blankLike = (S, cell, patch) => ({...emptyCell(() => S.d.newId()), props: {...structuredClone(cell.props ?? {}), ...patch}});

/** A vertical line at page `x`: split each crossed cell into two columns there (split_columns). */
function splitColumns(S, l, page, x, [ya, yb]) {
  const boxes = cellBoxes(l, page);
  const hit = r => { const overlap = Math.min(yb, bottom(r)) - Math.max(ya, r.y); return x > r.x + SNAP && x < right(r) - SNAP && overlap >= r.h * 0.5; };
  const c = crossed(boxes, [x, (ya + yb) / 2], hit);
  if (!c || !c[2].length) throw failed('the line doesn\'t cross a table cell');
  const [story, tp, cells] = c;
  const [r0, c0, rect0] = cells[0];
  const t0 = S.d.table(story, tp);
  if (!t0) throw failed('the table isn\'t there any more');
  // Where the line falls in the table's grid, measured in the first crossed cell.
  const cum = offsets(t0);
  const a0 = gridCol(t0, r0, c0);
  const span0 = cellSpan(t0.rows[r0]?.cells[c0]);
  const start = cum[a0] ?? 0, end = cum[a0 + span0] ?? cum[cum.length - 1] ?? 0;
  const g = start + (x - rect0.x) / Math.max(rect0.w, 1) * (end - start);
  if (!fin(g) || g <= 0) throw failed('the line doesn\'t cross a table cell');
  const crossedSet = new Set(cells.map(([r, ci]) => `${r},${ci}`));
  // A vertically merged cell splits only as a whole.
  for (const [r, ci] of cells) {
    const [g0, g1] = vgroup(t0, r, ci);
    const gc = gridCol(t0, r, ci);
    for (let rr = g0; rr <= g1; rr++) {
      const k = cellAtGrid(t0, rr, gc);
      if (!crossedSet.has(`${rr},${k ?? -1}`)) throw failed('the line crosses only part of a merged cell; draw it across the whole cell');
    }
  }
  // Snap to an existing grid line, else a new one inside grid column k.
  let existing = null;
  for (let j = 1; j < t0.grid.length; j++) if (cum[j] !== undefined && Math.abs(cum[j] - g) < SNAP) { existing = j; break; }
  let k = Math.max(t0.grid.length - 1, 0);
  for (let i = 0; i < t0.grid.length; i++) if (cum[i + 1] !== undefined && g < cum[i + 1]) { k = i; break; }
  if (existing === null && t0.grid.length >= MAX_COLS) throw failed(`a table can't have more than ${MAX_COLS} columns`);
  const t = structuredClone(t0);
  let changed = false;
  const sortedCrossed = [...cells.map(([r, ci]) => [r, ci])].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (existing !== null) {
    const j = existing;
    for (const [r, ci] of [...sortedCrossed].reverse()) {
      const a = gridCol(t, r, ci);
      const row = t.rows[r];
      const cell = row?.cells[ci];
      if (!cell) continue;
      const span = cellSpan(cell);
      if (a < j && j < a + span) {
        cell.props = {...(cell.props ?? {}), span: j - a};
        row.cells.splice(ci + 1, 0, blankLike(S, cell, {span: a + span - j}));
        changed = true;
      }
    }
  } else {
    const ks = cum[k] ?? 0, ke = cum[k + 1] ?? ks;
    const left = g - ks, rgt = ke - g;
    if (left < SNAP || rgt < SNAP) throw failed('there\'s already a border there');
    t.grid[k] = left;
    t.grid.splice(Math.min(k + 1, t.grid.length), 0, rgt);
    for (let r = 0; r < t.rows.length; r++) {
      // Grid positions are read before this row changes (the old grid had one column fewer).
      const ci = cellAtGrid(t0, r, k);
      if (ci === null || ci === undefined) continue;
      const a = gridCol(t0, r, ci);
      const row = t.rows[r];
      const cell = row.cells[ci];
      if (!cell) continue;
      if (crossedSet.has(`${r},${ci}`)) {
        const span = cellSpan(cell);
        cell.props = {...(cell.props ?? {}), span: k + 1 - a};
        row.cells.splice(ci + 1, 0, blankLike(S, cell, {span: a + span - k}));
      } else cell.props = {...(cell.props ?? {}), span: cellSpan(cell) + 1};
    }
    changed = true;
  }
  if (!changed) throw failed('there\'s already a border there');
  S.d.updateTable(story, tp, () => syncCellWidths(t));
  return finish(S, story, tp, r0, c0 + 1);
}

/** A horizontal line at page `y`: split the row it crosses there (split_rows). */
function splitRows(S, l, page, y, [xa, xb]) {
  const boxes = cellBoxes(l, page);
  const hit = r => { const overlap = Math.min(xb, right(r)) - Math.max(xa, r.x); return y > r.y + SNAP && y < bottom(r) - SNAP && overlap >= r.w * 0.5; };
  const c = crossed(boxes, [(xa + xb) / 2, y], hit);
  if (!c || !c[2].length) throw failed('the line doesn\'t cross a table cell');
  const [story, tp, cells] = c;
  const [r, c0] = cells[0];
  if (cells.some(x => x[0] !== r)) throw failed('draw the line within one row');
  // The row's extent on this page.
  const rowBoxes = boxes.filter(b => b.story === story && samePath(b.table, tp) && b.row === r).map(b => b.rect);
  const top = Math.min(...rowBoxes.map(b => b.y));
  const bot = Math.max(...rowBoxes.map(b => bottom(b)));
  const t0 = S.d.table(story, tp);
  if (!t0) throw failed('the table isn\'t there any more');
  if (t0.rows.length >= MAX_ROWS) throw failed('the table has too many rows');
  // An exact height leaves out the row's bottom margin (its cells' largest), which the layout adds
  // below it: take it off each half so the two rows draw where the line went.
  const row0 = t0.rows[r];
  const rowBottom = row0 ? row0.cells.reduce((m, _, ci) => Math.max(m, cellMargins(S.d.c, t0, r, ci)[2]), 0) : 0;
  const crossedSet = new Set(cells.map(x => x[1]));
  if ([...crossedSet].some(ci => vmergeOf(row0?.cells[ci]) !== 'none')) throw failed('splitting a vertically merged cell across rows isn\'t supported; erase its merge first');
  if (!row0) throw failed('the row isn\'t there any more');
  const t = structuredClone(t0);
  const row = t.rows[r];
  const newRow = {...row, id: S.d.newId(), props: {...structuredClone(row.props ?? {}), header: false}, cells: []};
  delete newRow.props.header;
  if (newRow.controls) delete newRow.controls;
  if (fin(top) && fin(bot) && bot > top) {
    const rule = row.props?.heightRule === 'exact' ? 'exact' : 'atLeast';
    const less = rule === 'exact' ? rowBottom : 0;
    row.props = {...(row.props ?? {}), height: clamp(y - top - less, 1, 1584), heightRule: rule};
    newRow.props.height = clamp(bot - y - less, 1, 1584);
    newRow.props.heightRule = rule;
  }
  row.cells.forEach((cell, ci) => {
    if (crossedSet.has(ci)) newRow.cells.push(blankLike(S, cell, {vmerge: 'none'}));
    else {
      if (vmergeOf(cell) === 'none') cell.props = {...(cell.props ?? {}), vmerge: 'restart'};
      newRow.cells.push(blankLike(S, cell, {vmerge: 'continue'}));
    }
  });
  for (const nc of newRow.cells) if (nc.props.vmerge === 'none') delete nc.props.vmerge;
  t.rows.splice(r + 1, 0, newRow);
  S.d.updateTable(story, tp, () => t);
  return finish(S, story, tp, r + 1, c0);
}

/** Put the caret in cell (r, c) of the table (clamped) (finish). */
function finish(S, story, tp, r, c) {
  const t = S.d.table(story, tp);
  if (!t) return T.finish(S);
  r = Math.min(r, Math.max(t.rows.length - 1, 0));
  c = Math.min(c, Math.max((t.rows[r]?.cells.length ?? 1) - 1, 0));
  T.setCaret(S, S.d.clamp({story, path: [...tp, r, c, 0], off: 0}));
  return T.finish(S);
}

/**
 * What the eraser would remove at a point: {from, to} (the border's ends, page points), plus the
 * table and the cells beside it (erase_target).
 */
export function eraseTarget(l, page, x, y) {
  if (!fin(x) || !fin(y)) return null;
  const boxes = cellBoxes(l, page);
  let best = null;
  const offer = (d, depth, e) => { if (d <= ERASER_REACH && (!best || d < best.d - 0.01 || (d <= best.d + 0.01 && depth > best.depth))) best = {d, depth, e}; };
  for (const a of boxes) {
    const ar = right(a.rect), ab = bottom(a.rect);
    const same = b => b.story === a.story && samePath(b.table, a.table);
    // The border on a's right, shared with the next cell of its row.
    if (Math.abs(x - ar) <= ERASER_REACH && y >= a.rect.y && y <= ab) {
      const b = boxes.filter(same).find(b => b.row === a.row && b.cell === a.cell + 1 && Math.abs(b.rect.x - ar) <= 1.5);
      if (b) offer(Math.abs(x - ar), a.table.length, {from: [ar, Math.max(a.rect.y, b.rect.y)], to: [ar, Math.min(ab, bottom(b.rect))], story: a.story, table: a.table, first: [a.row, a.cell], second: [b.row, b.cell], across: true});
    }
    // The border below a, shared with a cell of the next row.
    if (Math.abs(y - ab) <= ERASER_REACH && x >= a.rect.x && x <= ar) {
      const b = boxes.filter(same).find(b => b.row === a.row + 1 && Math.abs(b.rect.y - ab) <= 1.5 && x >= b.rect.x && x <= right(b.rect));
      if (b) offer(Math.abs(y - ab), a.table.length, {from: [Math.max(a.rect.x, b.rect.x), ab], to: [Math.min(ar, right(b.rect)), ab], story: a.story, table: a.table, first: [a.row, a.cell], second: [b.row, b.cell], across: false});
    }
  }
  return best ? best.e : null;
}

function eraser(S, p) {
  const page = pageParam(p);
  const x = reqNum(p, 'x'), y = reqNum(p, 'y');
  const l = layoutOfS(S);
  if (!l?.pages[page]) throw badParams(`no page ${page}`);
  const e = eraseTarget(l, page, x, y);
  if (!e) throw failed('there\'s no border between two cells there');
  const {story, table: tp} = e;
  const t0 = S.d.table(story, tp);
  if (!t0) throw failed('the cells aren\'t there any more');
  const [[r, c], [r2, c2]] = [e.first, e.second];
  const ca = t0.rows[r]?.cells[c], cb = t0.rows[r2]?.cells[c2];
  if (!ca || !cb) throw failed('the cells aren\'t there any more');
  const t = structuredClone(t0);
  const la = logical(t, r, c), lb = logical(t, r2, c2);
  const done = (tt, rr, cc) => { S.d.updateTable(story, tp, () => tt); return finish(S, story, tp, rr, cc); };
  if (e.across) {
    // Both sides merged down the same rows (or plain single cells): they become one cell.
    const rows = alignedRows(t, la, lb);
    if (rows) {
      const ci0 = cellAtGrid(t, rows[0], la.g0) ?? 0;
      let tt = t0;
      for (let row = rows[0]; row <= rows[1]; row++) {
        const ci = cellAtGrid(tt, row, la.g0);
        if (ci !== null && ci !== undefined) tt = mergeRight(tt, row, ci, ci + 1);
      }
      return done(syncCellWidths(tt), rows[0], ci0);
    }
    // Two sides that can't make one rectangle: the border is only hidden.
    hideEdge(t, true, la.g1, [Math.min(la.top, lb.top), Math.max(la.bot, lb.bot)]);
    return done(t, la.top, cellAtGrid(t, la.top, la.g0) ?? 0);
  }
  const ga = gridCol(t, r, c), gb = gridCol(t, r2, c2);
  if (ga !== gb || cellSpan(ca) !== cellSpan(cb)) {
    hideEdge(t, false, la.bot + 1, [Math.min(la.g0, lb.g0), Math.max(la.g1, lb.g1)]);
    return done(t, la.top, cellAtGrid(t, la.top, la.g0) ?? 0);
  }
  if (vmergeOf(cb) === 'continue') throw failed('those cells are already merged');
  const [top] = vgroup(t, r, c);
  const a = t.rows[r].cells[c];
  if (vmergeOf(a) === 'none') a.props = {...(a.props ?? {}), vmerge: 'restart'};
  const b = t.rows[r2].cells[c2];
  b.props = {...(b.props ?? {}), vmerge: 'continue'};
  const moved = b.blocks.filter(x => x.kind !== 'para' || !P.paraIsEmptyText(x));
  b.blocks = [P.newParagraph(S.d.newId())];
  const tc = cellAtGrid(t, top, ga) ?? 0;
  const dst = t.rows[top]?.cells[tc];
  if (moved.length && dst) {
    const only = dst.blocks.length === 1 && dst.blocks[0].kind === 'para' && P.paraIsEmptyText(dst.blocks[0]);
    dst.blocks = [...(only ? [] : dst.blocks), ...moved];
  }
  return done(t, top, tc);
}

const run = f => (ctx, p) => f(T.open(ctx), p ?? {});
const num = () => s.number();

export default defineCommands({
  family: 'table_draw',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'table.draw', label: 'Draw Table', risk: 'edit', state: T.ready,
      description: 'Draw Table (Insert › Tables; Table Layout › Draw): a pen stroke in page points; a rectangle at least 12 pt each way outside any table inserts a one-cell table of that size at the paragraph under its start; a straight vertical or horizontal line inside a table splits the cells it crosses there. In the app the button turns the pen on.',
      params: s.object({page: num(), x0: num(), y0: num(), x1: num(), y1: num(), story: s.optional(s.any())}),
      run: run(draw)},
    {id: 'table.eraser', label: 'Eraser', risk: 'edit', state: T.ready,
      description: 'Eraser (Table Layout › Draw): removes the border between two cells within 4 pt of the point; cells that make one rectangle merge, including cells merged down the same rows; otherwise the border is hidden along the whole edge. In the app the button turns the eraser on.',
      params: s.object({page: num(), x: num(), y: num()}),
      run: run(eraser)},
  ],
});
