// Table Design and Table Layout tabs (and Insert › Tables › Convert Text to Table / Quick Tables):
// rows and columns, delete, merge and split, styles and style options, shading and borders, cell
// alignment and text direction, AutoFit, distribute, column width and row height, repeat header
// rows, alt text, sort, convert to text, formula, select, right-to-left, Table Properties.
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd/table.rs              the command table (ids, labels, params, `in_table`)
//   crates/engine/src/cmd/table/structure.rs    row, col, del_row, del_col, del_table, merge,
//                                               split_targets, split, split_table
//   crates/engine/src/cmd/table/layout.rs       autofit, sync_cell_widths, set_column_widths,
//                                               properties, text_direction, fix_caret, borders
//   crates/engine/src/cmd/table/clear.rs        cell_prefix, text_spans, guard_delete, has_text
//   crates/engine/src/cmd/table/convert.rs      sort_table, to_text, row_to_text, formula,
//                                               text_table_lines, text_table_cells, text_table_paras,
//                                               from_text, quick_table
//   crates/engine/src/cmd/table/cells.rs        with_table, with_cells, cell_lang
//   crates/engine/src/cmd/table/select.rs       select_column (+ select_cells via lib/table-session)
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Every command works on the schema-2 model through lib/table-session.mjs (upstream's Session).
// Structural edits go through core/quill/model/table.mjs (wordcraft crates/doc/src/table.rs).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import * as P from '../model/para.mjs';
import {BODY, samePath} from '../model/document.mjs';
import {bordersAll, border as mkBorder, parseRgb, tableLook, textDirectionNext} from '../model/props.mjs';
import {findStyle, getStyle, resolvePara} from '../model/styles.mjs';
import {sortKey, cmpSortKeys} from '../model/collate.mjs';
import {MAX_COLS, MAX_ROWS, cellAtGrid, cellSpan, deleteCol, deleteRow, gridCol, insertCol, insertRow, mergeCells, newTable,
  rowFirstGrid, splitCellGrid, splitTable as splitTableAt, tableCols, verticalExtent} from '../model/table.mjs';
import * as T from '../lib/table-session.mjs';
import {autoFormulaInstr, evaluateFieldWith, parseNumber} from '../lib/table-formula.mjs';
import {autofitWidths, measureTableColumns} from '../lib/table-measure.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/table.rs',
  'crates/engine/src/cmd/table/structure.rs', 'crates/engine/src/cmd/table/layout.rs', 'crates/engine/src/cmd/table/clear.rs',
  'crates/engine/src/cmd/table/convert.rs', 'crates/engine/src/cmd/table/cells.rs', 'crates/engine/src/cmd/table/select.rs']};

const NOT_IN_TABLE = 'the cursor isn\'t in a table';
const {failed, params: badParams} = T;

// ---- state helpers ------------------------------------------------------------------------------

/** The caret's focus position, read cheaply for state(). */
function focusOf(ctx) {
  try {
    const all = ctx.model.selection(ctx);
    const r = all[ctx.selection?.primary ?? 0] ?? all[0];
    return r?.focus ?? null;
  } catch { return null; }
}
/** [table, row, cell, story, tablePath] at the caret, or null. */
function caretTable(ctx) {
  const f = focusOf(ctx);
  if (!f || f.path.length < 4) return null;
  const n = f.path.length;
  const tp = f.path.slice(0, n - 3);
  try {
    const d = ctx.model.open(ctx);
    const t = d.table(f.story, tp);
    return t ? {t, r: f.path[n - 3], c: f.path[n - 2], story: f.story, tp, d} : null;
  } catch { return null; }
}
/** `.when(in_table)`. */
function inTable(ctx) {
  const st = T.ready(ctx);
  if (!st.enabled) return st;
  return caretTable(ctx) ? {enabled: true} : {enabled: false, reason: NOT_IN_TABLE};
}
const t_ = (spec) => ({risk: 'edit', state: inTable, ...spec});

// ---- shared edits -------------------------------------------------------------------------------

/** with_table: change the caret's table with `f(t) -> t`, keep the selection. */
function withTable(S, f) {
  const [tp] = T.cell(S);
  S.d.updateTable(S.sel.focus.story, tp, t => f(t) ?? t);
  return T.finish(S);
}
/** with_cells: change every selected cell with `f(cell) -> cell`. */
function withCells(S, f) {
  const [tp] = T.cell(S);
  const cells = T.selectedCells(S);
  S.d.updateTable(S.sel.focus.story, tp, t => {
    const rows = t.rows.slice();
    for (const [r, c] of cells) {
      const row = rows[r];
      if (!row?.cells[c]) continue;
      const cs = row.cells.slice();
      cs[c] = f(cs[c]);
      rows[r] = {...row, cells: cs};
    }
    return {...t, rows};
  });
  return T.finish(S);
}
const cellProps = (c, patch) => {
  const props = {...(c.props ?? {}), ...patch};
  for (const k of Object.keys(props)) if (props[k] === undefined || props[k] === null) delete props[k];
  return {...c, props};
};
const tableProps = (t, patch) => {
  const props = {...(t.props ?? {}), ...patch};
  for (const k of Object.keys(props)) if (props[k] === undefined || props[k] === null) delete props[k];
  return {...t, props};
};
const rowProps = (row, patch) => {
  const props = {...(row.props ?? {}), ...patch};
  for (const k of Object.keys(props)) if (props[k] === undefined || props[k] === null) delete props[k];
  return {...row, props};
};
const setRow = (t, r, f) => { const rows = t.rows.slice(); rows[r] = f(rows[r]); return {...t, rows}; };
const setCell = (t, r, c, f) => setRow(t, r, row => { const cells = row.cells.slice(); cells[c] = f(cells[c]); return {...row, cells}; });

/** Give every cell the width of the grid columns it spans (sync_cell_widths). */
export function syncCellWidths(t) {
  const grid = t.grid;
  return {...t, rows: t.rows.map(row => {
    let g = rowFirstGrid(row);
    return {...row, cells: row.cells.map(c => {
      const span = cellSpan(c);
      const w = grid.slice(g, Math.min(g + span, grid.length)).reduce((a, x) => a + x, 0);
      g += span;
      return w > 0 ? cellProps(c, {width: w}) : c;
    })};
  })};
}

/** Give every grid column the (row, cell) pairs touch width `w` (set_column_widths). */
function setColumnWidths(t, cells, w) {
  const cols = [...new Set(cells.map(([r, c]) => gridCol(t, r, c)))].sort((a, b) => a - b);
  const grid = t.grid.slice();
  let any = false;
  for (const g of cols) if (g < grid.length) { grid[g] = w; any = true; }
  if (!any) return t;
  return syncCellWidths(tableProps({...t, grid}, {width: null, widthPct: null}));
}
function setColumnWidth(t, r, c, w) {
  const g = gridCol(t, r, c);
  if (g >= t.grid.length) return t;
  const grid = t.grid.slice();
  grid[g] = w;
  return syncCellWidths(tableProps({...t, grid}, {width: null, widthPct: null}));
}

/** The caret into cell (r, c) of the table at `tp`, clamped (fix_caret). */
function fixCaret(S, tp, r, c) {
  const story = S.sel.focus.story;
  const t = S.d.table(story, tp);
  if (!t) { T.setCaret(S, S.d.clamp({story, path: tp, off: 0})); return T.finish(S); }
  r = Math.min(r, Math.max(0, t.rows.length - 1));
  c = Math.min(c, Math.max(0, (t.rows[r]?.cells.length ?? 1) - 1));
  T.setCaret(S, {story, path: [...tp, r, c, 0], off: 0});
  return T.finish(S);
}

/** The path prefix of cell (r, c) of the table at `tp` (cell_prefix). */
const cellPrefix = (tp, r, c) => [...tp, r, c];

/** The text under each path prefix: from its first paragraph's start to its last's end (text_spans). */
function textSpans(S, story, prefixes) {
  const paths = S.d.paraPaths(story);
  const out = [];
  for (const pre of prefixes) {
    const inside = paths.filter(p => p.length >= pre.length && samePath(p.slice(0, pre.length), pre));
    if (!inside.length) continue;
    const last = inside[inside.length - 1];
    out.push([{story, path: inside[0], off: 0}, {story, path: last, off: S.d.para(story, last)?.text.length ?? 0}]);
  }
  return out;
}

/** Whether a..b holds text: any text, or (`live`) text that isn't a tracked deletion (has_text). */
function hasText(S, a, b, live) {
  return S.d.pathsBetween(a, b).some(path => {
    const p = S.d.para(a.story, path);
    if (!p) return false;
    const from = samePath(path, a.path) ? a.off : 0;
    const to = samePath(path, b.path) ? b.off : p.text.length;
    return P.runRanges(p).some(([x, y, c]) => (!live || (c?.del ?? null) === null) && y > from && x < to && y > x);
  });
}

/**
 * Before a table deletion removes `spans`: content-control locks refuse it; with Track Changes the
 * text is marked deleted and the structure stays (guard_delete). Returns a result when it handled it.
 */
function guardDelete(S, spans) {
  for (const [a, b] of spans) T.checkDelete(S, a, b);
  if (!S.d.c.settings?.trackChanges && !S.ctx?.view?.trackMine) return null;
  if (!spans.some(([a, b]) => hasText(S, a, b, true))) {
    if (spans.some(([a, b]) => hasText(S, a, b, false))) {
      const msg = 'The table\'s text is already marked deleted; accept or reject the change first.';
      S.status = msg;
      throw failed(msg);
    }
    return null;
  }
  const rid = T.newRevision(S, 'delete');
  for (const [a, b] of [...spans].reverse()) T.trackDeleteAs(S, a, b, rid);
  if (spans.length) T.setCaret(S, S.d.clamp(spans[0][0]));
  return T.finish(S);
}

// ---- structure (table/structure.rs) ---------------------------------------------------------------

function row(S, below) {
  const [tp, r, c] = T.cell(S);
  const n = Math.max(1, new Set(T.selectedCells(S).map(x => x[0])).size);
  const mk = () => S.d.newId();
  S.d.updateTable(S.sel.focus.story, tp, t => { for (let i = 0; i < n; i++) t = insertRow(t, below ? r + 1 : r, r, mk); return t; });
  return fixCaret(S, tp, below ? r + 1 : r, c);
}

function col(S, right) {
  const [tp, r, c] = T.cell(S);
  const mk = () => S.d.newId();
  S.d.updateTable(S.sel.focus.story, tp, t0 => {
    const g = gridCol(t0, r, c);
    const span = cellSpan(t0.rows[r]?.cells[c]);
    const at = right ? g + span : g;
    let t = insertCol(t0, at, mk);
    // Keep the table within its width: shrink all columns proportionally.
    const total = t.grid.reduce((a, x) => a + x, 0);
    const before = total - (t.grid[at] ?? 0);
    if (before > 0) { const k = before / total; t = {...t, grid: t.grid.map(w => w * k)}; }
    return syncCellWidths(t);
  });
  return fixCaret(S, tp, r, right ? c + 1 : c);
}

function delRow(S) {
  const [tp, r] = T.cell(S);
  const rows = [...new Set(T.selectedCells(S).map(x => x[0]))].sort((a, b) => a - b);
  const story = S.sel.focus.story;
  if (rows.length >= (S.d.table(story, tp)?.rows.length ?? 0)) return delTable(S);
  const done = guardDelete(S, textSpans(S, story, rows.map(rr => [...tp, rr])));
  if (done) return done;
  S.d.updateTable(story, tp, t => { for (const rr of [...rows].reverse()) t = deleteRow(t, rr); return t; });
  return fixCaret(S, tp, r, 0);
}

function delCol(S) {
  const [tp, r, c] = T.cell(S);
  const cells = T.selectedCells(S);
  const story = S.sel.focus.story;
  const t = S.d.table(story, tp);
  if (!t) throw failed('no table');
  if (t.grid.length <= 1) return delTable(S);
  const cols = new Set();
  for (const [rr, cc] of cells) {
    const g = gridCol(t, rr, cc);
    const span = cellSpan(t.rows[rr]?.cells[cc]);
    for (let k = g; k < Math.min(g + span, t.grid.length); k++) cols.add(k);
  }
  if (!cols.size) cols.add(gridCol(t, r, c));
  if (cols.size >= t.grid.length) return delTable(S);
  const prefixes = [];
  t.rows.forEach((row, rr) => row.cells.forEach((x, cc) => {
    const g = gridCol(t, rr, cc);
    const end = Math.min(g + cellSpan(x), t.grid.length);
    if (end > g) { let all = true; for (let k = g; k < end; k++) if (!cols.has(k)) all = false; if (all) prefixes.push(cellPrefix(tp, rr, cc)); }
  }));
  const done = guardDelete(S, textSpans(S, story, prefixes));
  if (done) return done;
  const after = S.d.updateTable(story, tp, t0 => { let x = t0; for (const g of [...cols].sort((a, b) => b - a)) x = deleteCol(x, g); return x; });
  if (!after.rows.length) return delTable(S);
  return fixCaret(S, tp, r, Math.max(0, c - 1));
}

function delTable(S) {
  const [tp] = T.cell(S);
  const story = S.sel.focus.story;
  const done = guardDelete(S, textSpans(S, story, [tp]));
  if (done) return done;
  S.d.removeBlock(story, tp);
  T.setCaret(S, S.d.clamp({story, path: tp, off: 0}));
  return T.finish(S);
}

function deleteCells(S) {
  const [tp, r, c] = T.cell(S);
  const story = S.sel.focus.story;
  const row = S.d.table(story, tp)?.rows[r];
  // A row's last cell stays.
  if (!(row && row.cells.length > 1 && c < row.cells.length)) return fixCaret(S, tp, r, 0);
  const done = guardDelete(S, textSpans(S, story, [cellPrefix(tp, r, c)]));
  if (done) return done;
  S.d.updateTable(story, tp, t => setRow(t, r, rw => (c < rw.cells.length ? {...rw, cells: rw.cells.filter((_, i) => i !== c)} : rw)));
  return fixCaret(S, tp, r, 0);
}

function merge(S, {finish = true} = {}) {
  const [tp] = T.cell(S);
  const cells = T.selectedCells(S);
  if (cells.length < 2) throw failed('select two or more cells to merge');
  const story = S.sel.focus.story;
  const r0 = Math.min(...cells.map(x => x[0])), r1 = Math.max(...cells.map(x => x[0]));
  const c0 = Math.min(...cells.map(x => x[1])), c1 = Math.max(...cells.map(x => x[1]));
  const mk = () => S.d.newId();
  S.d.updateTable(story, tp, t => {
    const g0 = gridCol(t, r0, c0);
    const g1 = gridCol(t, r0, c1) + cellSpan(t.rows[r0]?.cells[c1]) - 1;
    return mergeCells(t, r0, r1, g0, g1, mk);
  });
  if (!finish) { T.setCaret(S, {story, path: [...tp, r0, Math.min(c0, (S.d.table(story, tp)?.rows[r0]?.cells.length ?? 1) - 1), 0], off: 0}); return null; }
  return fixCaret(S, tp, r0, c0);
}

/** The selected cells as Split Cells sees them: one per cell, a vertically merged cell once (split_targets). */
export function splitTargets(S) {
  let cl;
  try { cl = T.cell(S); } catch { return []; }
  const t = S.d.table(S.sel.focus.story, cl[0]);
  if (!t) return [];
  const v = T.selectedCells(S).filter(([r, c]) => c < (t.rows[r]?.cells.length ?? 0))
    .map(([r, c]) => [verticalExtent(t, r, c)?.[0] ?? r, gridCol(t, r, c)]);
  v.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return v.filter((x, i) => i === 0 || x[0] !== v[i - 1][0] || x[1] !== v[i - 1][1]);
}

function split(S, p) {
  const cols = Math.max(1, Math.min(63, Math.floor(p.columns ?? 2)));
  const rows = Math.max(1, Math.min(63, Math.floor(p.rows ?? 1)));
  let cells = splitTargets(S);
  const mergeFirst = cells.length > 1 && (p.mergeFirst ?? true);
  if (mergeFirst) {
    const selRows = new Set(T.selectedCells(S).map(([r]) => r));
    if (rows > selRows.size) throw badParams(`The number must be between 1 and ${selRows.size}.`);
    merge(S, {finish: false});
    cells = [];
  } else if (cells.length > 1 && rows > 1) {
    throw badParams('several cells split one by one keep their rows: `rows` must be 1');
  }
  const [tp, r, c] = T.cell(S);
  const story = S.sel.focus.story;
  const mk = () => S.d.newId();
  let t = S.d.table(story, tp);
  if (!cells.length) cells.push([verticalExtent(t, r, c)?.[0] ?? r, gridCol(t, r, c)]);
  if (cells.length === 1) {
    const [top, g] = cells[0];
    const ci = cellAtGrid(t, top, g);
    const k = ci === null ? null : verticalExtent(t, top, ci)?.[1];
    if (k && k > 1 && rows > k) throw badParams(`The number must be between 1 and ${k}.`);
  }
  const first = cells[0];
  const order = [...cells].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  for (const [top, g] of order) {
    const ci = cellAtGrid(t, top, g);
    if (ci === null) continue;
    const height = verticalExtent(t, top, ci)?.[1] ?? 1;
    if (!mergeFirst && cols === 1 && rows === 1 && height > 1) continue;
    if (height > 1 && rows > 1 && height % rows !== 0) throw badParams(`The number must be a divisor of ${height}.`);
    const next = splitCellGrid(t, top, ci, cols, rows, mk);
    if (!next) throw failed(`can't split into ${rows} rows: the table would get too many rows`);
    t = next;
  }
  S.d.setBlock(story, tp, t);
  const [top, g] = first ?? [r, 0];
  return fixCaret(S, tp, top, cellAtGrid(t, top, g) ?? c);
}

function splitTableCmd(S) {
  const [tp, r] = T.cell(S);
  if (r === 0) throw failed('can\'t split at the first row');
  const story = S.sel.focus.story;
  const t = S.d.table(story, tp);
  const [head, tail] = splitTableAt(t, r, S.d.newId());
  S.d.setBlock(story, tp, head);
  const after = [...tp.slice(0, -1), tp[tp.length - 1] + 1];
  S.d.insertBlock(story, after, P.newParagraph(S.d.newId()));
  S.d.insertBlock(story, [...after.slice(0, -1), after[after.length - 1] + 1], tail);
  T.setCaret(S, {story, path: after, off: 0});
  return T.finish(S);
}

// ---- layout (table/layout.rs) ---------------------------------------------------------------------

function autofit(S, mode) {
  const [tp] = T.cell(S);
  const story = S.sel.focus.story;
  const tw = T.caretTextWidth(S);
  if (mode === 'fixed') return withTable(S, t => tableProps(t, {fixed: true}));
  if (mode === 'contents') {
    const t = S.d.table(story, tp);
    if (!t) throw T.disabled(NOT_IN_TABLE);
    const indent = Number.isFinite(t.props?.indent) ? Math.max(0, t.props.indent) : 0;
    const avail = Math.max(tw - indent, 72);
    const widths = autofitWidths(measureTableColumns(S.d.c, t), avail);
    return withTable(S, t0 => syncCellWidths({...tableProps(t0, {fixed: null, width: null, widthPct: null}), grid: widths.map(w => Math.max(w, 6))}));
  }
  return withTable(S, t0 => {
    const n = Math.max(1, t0.grid.length);
    return syncCellWidths({...tableProps(t0, {fixed: null, widthPct: 100}), grid: t0.grid.map(() => tw / n)});
  });
}

const PROPERTY_KEYS = ['align', 'rtl', 'width', 'widthPct', 'indent', 'rowHeight', 'rowHeightRule', 'allowBreak', 'headerRow', 'columnWidth', 'cellWidth', 'valign'];
const clampNum = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function properties(S, p) {
  const [tp, r, c] = T.cell(S);
  if (!PROPERTY_KEYS.some(k => p[k] !== undefined)) {
    const t = S.d.table(S.sel.focus.story, tp);
    const row = t?.rows[r];
    const cl = row?.cells[c];
    return {...(t?.props ?? {}), row: row ? row.props ?? {} : null, columnWidth: t?.grid[gridCol(t, r, c)] ?? null, cell: cl ? cl.props ?? {} : null};
  }
  const size = (k, lo, hi) => (p[k] === undefined ? undefined : p[k] === null ? null : clampNum(p[k], lo, hi));
  const width = size('width', 6, 1584);
  const widthPct = p.widthPct === undefined ? undefined : clampNum(p.widthPct, 1, 100);
  const indent = p.indent === undefined ? undefined : clampNum(p.indent, -1584, 1584);
  const rowHeight = size('rowHeight', 1, 1584);
  const columnWidth = p.columnWidth === undefined ? undefined : clampNum(p.columnWidth, 6, 1584);
  const cellWidth = size('cellWidth', 6, 1584);
  return withTable(S, t0 => {
    let t = t0;
    if (p.align) t = tableProps(t, {align: p.align});
    if (p.rtl !== undefined) t = tableProps(t, {bidiVisual: p.rtl || null});
    if (indent !== undefined) t = tableProps(t, {indent});
    if (columnWidth !== undefined) t = setColumnWidth(t, r, c, columnWidth);
    if (width !== undefined) t = tableProps(t, {width, widthPct: null});
    if (widthPct !== undefined) t = tableProps(t, {widthPct});
    if (t.rows[r]) {
      t = setRow(t, r, row => {
        let rw = row;
        if (rowHeight !== undefined) rw = rowProps(rw, {height: rowHeight, heightRule: rowHeight !== null ? (p.rowHeightRule ?? 'atLeast') : null});
        else if (p.rowHeightRule && rw.props?.height !== undefined && rw.props?.height !== null) rw = rowProps(rw, {heightRule: p.rowHeightRule});
        if (p.allowBreak !== undefined) rw = rowProps(rw, {cantSplit: !p.allowBreak || null});
        if (p.headerRow !== undefined) rw = rowProps(rw, {header: p.headerRow || null});
        if (rw.cells[c]) {
          const cells = rw.cells.slice();
          if (cellWidth !== undefined) cells[c] = cellProps(cells[c], {width: cellWidth});
          if (p.valign) cells[c] = cellProps(cells[c], {valign: p.valign});
          rw = {...rw, cells};
        }
        return rw;
      });
    }
    return t;
  });
}

function textDirection(S, value) {
  const [tp, r, c] = T.cell(S);
  const names = {horizontal: 'horizontal', lrTb: 'horizontal', down: 'down', tbRl: 'down', up: 'up', btLr: 'up'};
  let dir;
  if (value !== undefined) {
    dir = names[value];
    if (!dir) throw badParams(`unknown text direction \`${value}\``);
  } else {
    const t = S.d.table(S.sel.focus.story, tp);
    if (!t) throw T.disabled(NOT_IN_TABLE);
    dir = textDirectionNext(t.rows[r]?.cells[c]?.props?.textDirection ?? 'horizontal');
  }
  return withCells(S, cl => cellProps(cl, {textDirection: dir === 'horizontal' ? null : dir}));
}

function borders(S, p) {
  const kind = p.kind ?? 'all';
  // The pen (Table Design › Borders: Line Style, Line Weight, Pen Color; core/quill/commands/table_misc.mjs) is what a border is drawn with unless the call says.
  const pen = S.view?.tablePen ?? {};
  const w = clampNum(p.width ?? pen.width ?? 0.5, 0.25, 6);
  const colorOf = p.color ?? pen.color;
  const color = colorOf ? parseRgb(colorOf) : null;
  const style = p.style ?? pen.style ?? 'single';
  const b = style === 'none' ? mkBorder('none', 0, null, 0) : mkBorder(style, w, color, 0);
  const none = mkBorder('none', 0, null, 0);
  return withTable(S, t0 => {
    let cur = {...(t0.props?.borders ?? {})};
    switch (kind) {
      case 'all': cur = bordersAll(b); break;
      case 'none': cur = bordersAll(none); break;
      case 'outside': Object.assign(cur, {top: b, bottom: b, left: b, right: b, between: none, inside_v: none}); break;
      case 'inside': Object.assign(cur, {between: b, inside_v: b, top: none, bottom: none, left: none, right: none}); break;
      case 'top': case 'bottom': case 'left': case 'right': cur[kind] = b; break;
      case 'insideH': cur.between = b; break;
      case 'insideV': cur.inside_v = b; break;
      default: break;
    }
    const t = tableProps(t0, {borders: cur});
    return {...t, rows: t.rows.map(row => ({...row, cells: row.cells.map(c => (c.props?.borders ? cellProps(c, {borders: null}) : c))}))};
  });
}

// ---- sort / convert / formula (table/convert.rs) ------------------------------------------------------

const env = S => ({paraLang: p => T.paraLang(S.d, p)});
const cellLang = (S, c) => { const p = c?.blocks.find(b => b.kind === 'para' && P.plainText(b).trim() !== ''); return p ? T.paraLang(S.d, p) : null; };

function sortTable(S, p) {
  const col = Math.max(0, Math.floor(p.column ?? 0));
  const desc = !!p.descending;
  const [tp] = T.cell(S);
  const t = S.d.table(S.sel.focus.story, tp);
  if (!t) throw failed('no table');
  const skip = Math.min(Number(p.header ?? !!t.rows[0]?.props?.header), t.rows.length);
  const column = t.rows.slice(skip).map(r => r.cells[col] ?? null);
  const lang = column.map(c => (c ? cellLang(S, c) : null)).find(Boolean) ?? T.defaultLang(S);
  const keys = column.map(c => {
    const text = c ? T.cellText(c) : '';
    const numLang = (c ? cellLang(S, c) : null) ?? lang;
    const n = parseNumber(text.trim(), numLang);
    const num = n !== null && Number.isFinite(n) ? n : null;
    return [num, num !== null ? null : sortKey(text.trim(), lang)];
  });
  return withTable(S, t0 => {
    if (skip > t0.rows.length) return t0;
    const body = t0.rows.slice(skip).map((row, i) => [keys[i], row, i]);
    body.sort(([[a, ka], , i], [[b, kb], , j]) => {
      let o;
      if (a !== null && b !== null) o = a < b ? -1 : a > b ? 1 : 0;
      else if (a !== null) o = -1;
      else if (b !== null) o = 1;
      else o = cmpSortKeys(ka, kb);
      if (desc) o = -o;
      return o || i - j;
    });
    return {...t0, rows: [...t0.rows.slice(0, skip), ...body.map(x => x[1])]};
  });
}

const SEPARATORS = {tab: '\t', comma: ','};
function separatorOf(p, refuseObj) {
  const sep = p.separator ?? 'tab';
  if (sep === 'paragraph') return null;
  if (SEPARATORS[sep]) return SEPARATORS[sep];
  if (sep === 'other') {
    const ch = typeof p.char === 'string' ? [...p.char][0] : undefined;
    if (ch && ch !== '\n' && ch !== '\r' && !(refuseObj && ch === P.OBJ)) return ch;
    throw badParams('`char` (the separating character) is required with `other`');
  }
  throw badParams(`unknown separator \`${sep}\``);
}

/** One row of Convert to Text as blocks (row_to_text). */
function rowToText(S, row, sep, out) {
  if (sep === null) {
    for (const b of row.cells.flatMap(c => c.blocks)) {
      if (b.kind === 'para') { const q = {...b}; delete q.section; out.push(q); } else out.push(b);
    }
    return;
  }
  let line = null;
  row.cells.forEach((cell, ci) => {
    if (ci > 0) {
      if (!line) line = P.newParagraph(S.d.newId());
      line = {...line};
      P.append(line, P.paragraphWithText(sep, {}, 'sep'));
    }
    let first = true;
    for (const b of cell.blocks) {
      if (b.kind === 'para') {
        const para = {...b, runs: b.runs.slice(), ...(b.objects ? {objects: b.objects.slice()} : {})};
        delete para.section;
        if (line && first) { line = {...line}; P.append(line, para); } else { if (line) out.push(line); line = para; }
      } else {
        if (line) out.push(line);
        line = null;
        out.push(b);
      }
      first = false;
    }
  });
  if (line) out.push(line);
}

function toText(S, p) {
  const [tp] = T.cell(S);
  const sep = separatorOf(p, true);
  const story = S.sel.focus.story;
  const t = S.d.table(story, tp);
  if (!t) throw failed('no table');
  const cells = T.selectedCells(S);
  let r0 = 0, r1 = t.rows.length - 1;
  if (cells.length > 1 || S.cells) {
    r0 = Math.min(...cells.map(x => x[0]));
    r1 = Math.min(Math.max(...cells.map(x => x[0])), t.rows.length - 1);
  }
  // The head keeps the table's content-control starts, the tail its ends (Table::split_off).
  const [above, tail0] = splitTableAt(t, r1 + 1, S.d.newId());
  const [head0, middle] = splitTableAt(above, r0, S.d.newId());
  const open = t.controls?.open ?? [];
  const close = t.controls?.close ?? 0;
  const blocks = [];
  if (head0.rows.length) blocks.push(head0);
  const textFrom = blocks.length;
  for (const row of middle.rows) rowToText(S, row, sep, blocks);
  // Rows without cells (only from a damaged file) still leave a paragraph in their place.
  if (blocks.length === textFrom) blocks.push(P.newParagraph(S.d.newId()));
  const firstPara = blocks.findIndex((b, k) => k >= textFrom && b.kind === 'para');
  const caretPath = firstPara >= 0 ? [...tp.slice(0, -1), tp[tp.length - 1] + firstPara]
    : [...tp.slice(0, -1), tp[tp.length - 1] + textFrom, 0, 0, 0];
  if (tail0.rows.length) {
    const tail = {...tail0};
    // A floating table keeps its position in the part above; the part below goes in the text flow.
    if (textFrom > 0 && tail.props?.float) { tail.props = {...tail.props}; delete tail.props.float; }
    blocks.push(tail);
  }
  // A content control around the table keeps both ends: on the text where no table part is left to carry them.
  const openOut = head0.rows.length ? [] : open;
  const closeOut = tail0.rows.length ? 0 : close;
  const at = blocks[textFrom];
  if (openOut.length && at?.kind === 'para') {
    const q = {...at, runs: at.runs.slice(), ...(at.objects ? {objects: at.objects.slice()} : {})};
    openOut.forEach((control, k) => P.insertObject(q, k, {type: 'controlStart', control: {...control, block: true}}, {}));
    blocks[textFrom] = q;
  } else if (openOut.length && at?.kind === 'table') {
    blocks[textFrom] = {...at, controls: {...(at.controls ?? {}), open: [...openOut, ...(at.controls?.open ?? [])], close: at.controls?.close ?? 0}};
  }
  const lastI = blocks.length - 1, last = blocks[lastI];
  if (closeOut && last?.kind === 'para') {
    const q = {...last, runs: last.runs.slice(), ...(last.objects ? {objects: last.objects.slice()} : {})};
    for (let i = 0; i < Math.min(closeOut, 1024); i++) P.insertObject(q, q.text.length, {type: 'controlEnd'}, {});
    blocks[lastI] = q;
  } else if (closeOut && last?.kind === 'table') {
    blocks[lastI] = {...last, controls: {open: last.controls?.open ?? [], close: (last.controls?.close ?? 0) + closeOut}};
  }
  S.d.removeBlock(story, tp);
  blocks.forEach((b, k) => S.d.insertBlock(story, [...tp.slice(0, -1), tp[tp.length - 1] + k], b));
  T.setCaret(S, S.d.clamp({story, path: caretPath, off: 0}));
  return T.finish(S);
}

function formula(S, p) {
  const [tp, r, c] = T.cell(S);
  const raw = p.formula ?? '=SUM(ABOVE)';
  const t = S.d.table(S.sel.focus.story, tp);
  if (!t) throw failed('no table');
  const lang = T.defaultLang(S);
  const instr = autoFormulaInstr(t, r, c, raw, lang);
  const text = evaluateFieldWith(t, env(S), lang, r, c, instr);
  const props = T.typingProps(S);
  const end = S.d.insertObject(S.sel.focus, {type: 'field', instr, result: text}, props);
  T.setCaret(S, end);
  T.finish(S);
  return {result: text, formula: instr};
}

/** The paragraphs Convert Text to Table would convert, as text; refused across a table (text_table_lines). */
export function textTableLines(S) {
  const [a, b] = T.ordered(S.sel);
  if (a.story !== b.story || !samePath(a.path.slice(0, -1), b.path.slice(0, -1))) throw failed('select paragraphs to convert');
  const lines = [];
  const i0 = a.path[a.path.length - 1], i1 = b.path[b.path.length - 1];
  for (let i = i0; i <= i1; i++) { const q = S.d.para(a.story, [...a.path.slice(0, -1), i]); if (q) lines.push(P.plainText(q)); }
  if (lines.length !== i1 - i0 + 1) throw failed('select only paragraphs to convert');
  return lines;
}

/** The cells Convert Text to Table makes of `lines` and the column count (text_table_cells). */
export function textTableCells(lines, sep, columns) {
  if (sep === null) {
    const cols = Math.max(1, Math.min(columns ?? 1, MAX_COLS));
    const rows = [];
    for (let i = 0; i < lines.length; i += cols) rows.push(lines.slice(i, i + cols));
    return [rows, cols];
  }
  const cols = Math.max(1, columns ?? Math.max(1, ...lines.map(l => l.split(sep).length)));
  const rows = [];
  for (const l of lines) {
    const fields = l.split(sep);
    const per = Math.min(cols, MAX_COLS);
    for (let i = 0; i < fields.length; i += per) rows.push(fields.slice(i, i + per));
  }
  return [rows, cols];
}

/** text_table_paras: each cell its field cut out of the source paragraph, trimmed, formatting kept. */
function textTableParas(S, paras, sep, columns) {
  const fields = paras.map(p => {
    const out = [];
    let from = 0;
    if (sep !== null && sep !== P.OBJ) {
      for (let i = p.text.indexOf(sep); i >= 0; i = p.text.indexOf(sep, i + sep.length)) { out.push([from, i]); from = i + sep.length; }
    }
    out.push([from, p.text.length]);
    return out;
  });
  const cols = sep === null ? Math.max(1, Math.min(columns ?? 1, MAX_COLS)) : Math.max(1, columns ?? Math.max(1, ...fields.map(f => f.length)));
  const perRow = Math.min(cols, MAX_COLS);
  const rows = [];
  let row = [];
  paras.forEach((p0, k) => {
    const work = {...p0, runs: p0.runs.slice(), ...(p0.objects ? {objects: p0.objects.slice()} : {})};
    delete work.section;
    const pieces = [];
    for (const [x, y] of [...fields[k]].reverse()) {
      const field = work.text.slice(x, y);
      const start = x + (field.length - field.trimStart().length);
      const end = Math.max(x + field.trimEnd().length, start);
      const piece = P.splitOff(work, start, S.d.newId());
      P.splitOff(piece, end - start, S.d.newId());
      pieces.push(piece);
    }
    pieces.reverse();
    for (const piece of pieces) { row.push(piece); if (row.length === perRow) { rows.push(row); row = []; } }
    if (sep !== null && row.length) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  return [rows, cols];
}

const MAX_INITIAL_WIDTH = 22 * 72;

function fromText(S, p) {
  const sep = separatorOf(p, false);
  const fit = p.autofit ?? 'initial';
  if (!['initial', 'fixed', 'contents', 'window'].includes(fit)) throw badParams(`unknown AutoFit behavior \`${fit}\``);
  let colWidth = 0;
  if (fit !== 'contents' && fit !== 'window' && p.width !== undefined && p.width !== null) {
    if (!(p.width >= 0 && p.width <= MAX_INITIAL_WIDTH)) throw badParams('`width` must be between 0 and 1584 pt (22 in)');
    colWidth = p.width;
  }
  const columns = p.columns === undefined ? null : Math.max(1, Math.min(Math.floor(p.columns), MAX_COLS));
  const [a, b] = T.ordered(S.sel);
  textTableLines(S);
  const i0 = a.path[a.path.length - 1], i1 = b.path[b.path.length - 1];
  const paras = [];
  for (let i = i0; i <= i1; i++) { const q = S.d.para(a.story, [...a.path.slice(0, -1), i]); if (q) paras.push(q); }
  const [cells, cols] = textTableParas(S, paras, sep, columns);
  if (cols > MAX_COLS) throw failed('a table can have at most 63 columns');
  if (cells.length > MAX_ROWS) throw failed(`a table can have at most ${MAX_ROWS} rows`);
  const width = T.caretTextWidth(S);
  const mk = () => S.d.newId();
  let t = newTable(Math.max(1, cells.length), cols, width, mk);
  if (colWidth > 0) {
    t = {...t, grid: t.grid.map(() => colWidth), rows: t.rows.map(row => ({...row, cells: row.cells.map(c => cellProps(c, {width: colWidth}))}))};
  }
  t = {...t, rows: t.rows.map((row, r) => ({...row, cells: row.cells.map((c, ci) => (cells[r]?.[ci] ? {...c, blocks: [{...cells[r][ci], id: mk()}]} : c))}))};
  for (let i = i1; i >= i0; i--) S.d.removeBlock(a.story, [...a.path.slice(0, -1), i]);
  S.d.insertBlock(a.story, a.path, t);
  T.setCaret(S, {story: a.story, path: [...a.path, 0, 0, 0], off: 0});
  if (fit !== 'initial') return autofit(S, fit);
  return T.finish(S);
}

function quickTable(S, p) {
  const kind = p.kind ?? 'tabular';
  let data;
  if (kind === 'calendar') {
    data = [['M', 'T', 'W', 'T', 'F', 'S', 'S']];
    const days = ['', '', ...Array.from({length: 31}, (_, i) => String(i + 1)), '', '', ''];
    for (let i = 0; i < days.length; i += 7) data.push(days.slice(i, i + 7));
  } else if (kind === 'matrix') {
    data = [['', 'Column A', 'Column B', 'Column C'], ['Row 1', '1', '2', '3'], ['Row 2', '4', '5', '6'], ['Row 3', '7', '8', '9']];
  } else {
    data = [['Item', 'Needed'], ['Books', '1'], ['Magazines', '3'], ['Notebooks', '1'], ['Paper pads', '1'], ['Pens', '3'], ['Pencils', '2']];
  }
  const cols = Math.max(1, ...data.map(r => r.length));
  const mk = () => S.d.newId();
  let t = newTable(data.length, cols, T.caretTextWidth(S), mk);
  t = tableProps(t, {style: kind === 'calendar' ? 'GridTable1Light' : 'GridTable4AccentBlue'});
  t = {...t, rows: t.rows.map((row, r) => ({...(r === 0 ? rowProps(row, {header: true}) : row),
    cells: row.cells.map((c, ci) => (data[r][ci] !== undefined ? {...c, blocks: [P.paragraphWithText(data[r][ci], {}, mk())]} : c))}))};
  const story = S.sel.focus.story;
  const at = T.deleteSelection(S);
  const nw = S.d.splitParagraph(at);
  S.d.insertBlock(story, nw.path, t);
  T.setCaret(S, {story, path: [...nw.path, 0, 0, 0], off: 0});
  return T.finish(S);
}

// ---- select (table/select.rs) -----------------------------------------------------------------------

function selectColumn(S) {
  const [tp, r, c] = T.cell(S);
  const story = S.sel.focus.story;
  const t = S.d.table(story, tp);
  if (!t) throw T.disabled(NOT_IN_TABLE);
  let [g0, g1] = T.gridCols(t, r, c);
  for (const [rr, cc] of T.selectedCells(S)) { const [a, b] = T.gridCols(t, rr, cc); g0 = Math.min(g0, a); g1 = Math.max(g1, b); }
  return T.selectRange(S, story, tp, [0, Math.max(0, t.rows.length - 1)], [g0, g1]);
}
const selectFinish = (S, f) => { f(); T.finish(S); return T.selResult(S); };

// ---- table styles (shared with table_style.mjs) ------------------------------------------------------

/** A table style's id by id or display name, case-insensitive (table_style_id). */
export function tableStyleId(sheet, name) {
  const st = sheet.styles;
  return (st.find(x => x.kind === 'table' && x.id === name) ?? st.find(x => x.kind === 'table' && x.name.toLowerCase() === String(name).toLowerCase()))?.id ?? null;
}

// ---- the command table -----------------------------------------------------------------------------

const CELL_ALIGNS = {topLeft: ['left', 'top'], topCenter: ['center', 'top'], topRight: ['right', 'top'], centerLeft: ['left', 'center'],
  center: ['center', 'center'], centerRight: ['right', 'center'], bottomLeft: ['left', 'bottom'], bottomCenter: ['center', 'bottom'], bottomRight: ['right', 'bottom']};
const LOOK_KEYS = ['headerRow', 'totalRow', 'bandedRows', 'firstColumn', 'lastColumn', 'bandedColumns'];
const run = f => (ctx, p) => f(T.open(ctx), p ?? {});

export default defineCommands({
  family: 'table',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    t_({id: 'table.insertRowAbove', label: 'Insert Above', description: 'Insert Above (Table Layout › Rows & Columns): rows like the caret\'s, as many as the selection spans.',
      params: s.object({}), run: run(S => row(S, false))}),
    t_({id: 'table.insertRowBelow', label: 'Insert Below', description: 'Insert Below (Table Layout › Rows & Columns): rows like the caret\'s, as many as the selection spans.',
      params: s.object({}), run: run(S => row(S, true))}),
    t_({id: 'table.insertColumnLeft', label: 'Insert Left', description: 'Insert Left (Table Layout › Rows & Columns): a column beside the caret\'s cell; the table keeps its width.',
      params: s.object({}), run: run(S => col(S, false))}),
    t_({id: 'table.insertColumnRight', label: 'Insert Right', description: 'Insert Right (Table Layout › Rows & Columns): a column beside the caret\'s cell; the table keeps its width.',
      params: s.object({}), run: run(S => col(S, true))}),
    t_({id: 'table.deleteRow', label: 'Delete Rows', description: 'Delete Rows (Table Layout › Rows & Columns › Delete): the selected rows; every row deletes the table.',
      params: s.object({}), run: run(S => delRow(S))}),
    t_({id: 'table.deleteColumn', label: 'Delete Columns', description: 'Delete Columns (Table Layout › Rows & Columns › Delete): every grid column a selected cell covers.',
      params: s.object({}), run: run(S => delCol(S))}),
    t_({id: 'table.deleteTable', label: 'Delete Table', description: 'Delete Table (Table Layout › Rows & Columns › Delete).',
      params: s.object({}), run: run(S => delTable(S))}),
    t_({id: 'table.deleteCells', label: 'Delete Cells', dialog: 'dialog.deleteCells',
      description: 'Delete Cells (Table Layout › Rows & Columns › Delete): the caret\'s cell; a row\'s last cell stays.',
      params: s.object({}), run: run(S => deleteCells(S))}),
    t_({id: 'table.merge', label: 'Merge Cells', description: 'Merge Cells (Table Layout › Merge): the selected cells become one.',
      state(ctx) {
        const st = inTable(ctx);
        if (!st.enabled) return st;
        try { const S = T.open(ctx); return T.selectedCells(S).length >= 2 ? {enabled: true} : {enabled: false, reason: 'select two or more cells to merge'}; } catch { return st; }
      },
      params: s.object({}), run: run(S => merge(S))}),
    t_({id: 'table.split', label: 'Split Cells', dialog: 'dialog.splitCells',
      description: 'Split Cells (Table Layout › Merge): the caret\'s cell, or the selected cells (merged first unless mergeFirst is false), into columns × rows.',
      params: s.object({columns: s.optional(s.integer({min: 1, max: 63})), rows: s.optional(s.integer({min: 1, max: 63})), mergeFirst: s.optional(s.boolean())}),
      run: run(split)}),
    t_({id: 'table.splitTable', label: 'Split Table', description: 'Split Table (Table Layout › Merge): the rows from the caret\'s on become a table of their own.',
      state(ctx) { const st = inTable(ctx); if (!st.enabled) return st; return caretTable(ctx).r === 0 ? {enabled: false, reason: 'can\'t split at the first row'} : st; },
      params: s.object({}), run: run(S => splitTableCmd(S))}),
    t_({id: 'table.style', label: 'Table Styles', description: 'Table Styles (Table Design › Table Styles): give the caret\'s table a table style (id or name).',
      params: s.object({style: s.string({min: 1, max: 256})}),
      state(ctx) {
        const st = inTable(ctx);
        if (!st.enabled) return st;
        const ct = caretTable(ctx);
        const items = ctx.doc.styles.styles.filter(x => x.kind === 'table' && !x.hidden && !x.semiHidden)
          .map(x => ({id: x.id, label: x.name, value: x.id}));
        return {enabled: true, value: items.length ? items : ct.t.props?.style ?? null};
      },
      run: run((S, p) => {
        const id = tableStyleId(S.d.c.styles, p.style);
        if (!id) throw badParams(`no table style \`${p.style}\``);
        return withTable(S, t => tableProps(t, {style: id}));
      })}),
    t_({id: 'table.look', label: 'Table Style Options', description: 'Table Style Options (Table Design): header row, total row, banded rows, first column, last column, banded columns.',
      // `toggle` (an option's name) flips that option: the shell's ribbon checkboxes send no value
      // for a "<bool>" arg yet (design note U-quill-table--integrator--toggle-bool-args).
      params: s.object({...Object.fromEntries(LOOK_KEYS.map(k => [k, s.optional(s.boolean())])), toggle: s.optional(s.enum(LOOK_KEYS))}),
      state(ctx, p) {
        const st = inTable(ctx);
        if (!st.enabled) return st;
        const key = p?.toggle ?? LOOK_KEYS.find(k => p && k in p);
        const look = tableLook(caretTable(ctx).t.props ?? {});
        return key ? {enabled: true, checked: !!look[key]} : {enabled: true, value: look};
      },
      run: run((S, p) => withTable(S, t => {
        const look = {...tableLook(t.props ?? {})};
        for (const k of LOOK_KEYS) if (typeof p[k] === 'boolean') look[k] = p[k];
        if (p.toggle && typeof p[p.toggle] !== 'boolean') look[p.toggle] = !look[p.toggle];
        return tableProps(t, {look});
      }))}),
    t_({id: 'table.shading', label: 'Shading', description: 'Shading (Table Design › Table Styles): the selected cells\' fill colour; null for No Color.',
      params: s.object({color: s.optional(s.nullable(s.color()))}),
      state(ctx) {
        const st = inTable(ctx);
        if (!st.enabled) return st;
        const ct = caretTable(ctx);
        const sh = ct.t.rows[ct.r]?.cells[ct.c]?.props?.shading;
        return {enabled: true, value: Array.isArray(sh) ? `#${sh.map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase()}` : null};
      },
      run: run((S, p) => {
        const c = p.color && p.color !== 'none' && p.color !== 'auto' ? parseRgb(p.color) : null;
        return withCells(S, cl => cellProps(cl, {shading: c}));
      })}),
    t_({id: 'table.borders', label: 'Borders', description: 'Borders (Table Design › Borders): all, outside, inside, none, or one side, single lines of a width and colour.',
      params: s.object({kind: s.optional(s.enum(['all', 'outside', 'inside', 'none', 'top', 'bottom', 'left', 'right', 'insideH', 'insideV'])),
        width: s.optional(s.number({min: 0, max: 100})), color: s.optional(s.color()),
        style: s.optional(s.enum(['none', 'single', 'double', 'dotted', 'dashed', 'dotDash', 'thick', 'triple', 'wave']))}),
      run: run(borders)}),
    t_({id: 'table.cellAlign', label: 'Alignment', description: 'Alignment (Table Layout › Alignment): the selected cells\' vertical and horizontal text alignment.',
      params: s.object({value: s.optional(s.enum(Object.keys(CELL_ALIGNS)))}),
      state(ctx, p) {
        const st = inTable(ctx);
        if (!st.enabled) return st;
        const ct = caretTable(ctx);
        const cl = ct.t.rows[ct.r]?.cells[ct.c];
        const va = cl?.props?.valign ?? 'top';
        const para = cl?.blocks.find(b => b.kind === 'para');
        const ha = para ? (resolvePara(ctx.doc.styles, para.props ?? {}).align ?? 'left') : 'left';
        const want = p?.value ? CELL_ALIGNS[p.value] : null;
        return {enabled: true, checked: want ? want[0] === ha && want[1] === va : undefined};
      },
      run: run((S, p) => {
        const v = p.value ?? 'topLeft';
        const pair = CELL_ALIGNS[v];
        if (!pair) throw badParams(`unknown alignment \`${v}\``);
        const [h, va] = pair;
        return withCells(S, cl => ({...cellProps(cl, {valign: va}), blocks: cl.blocks.map(b => (b.kind === 'para' ? {...b, props: {...(b.props ?? {}), align: h}} : b))}));
      })}),
    t_({id: 'table.textDirection', label: 'Text Direction', description: 'Text Direction (Table Layout › Alignment): horizontal, down or up; without a value the next one after the caret cell\'s.',
      params: s.object({value: s.optional(s.enum(['horizontal', 'down', 'up', 'lrTb', 'tbRl', 'btLr']))}),
      run: run((S, p) => textDirection(S, p.value))}),
    t_({id: 'table.autofit', label: 'AutoFit', description: 'AutoFit (Table Layout › Cell Size): Contents sizes columns to their text, Window spreads them across the text column, Fixed keeps the widths.',
      params: s.object({mode: s.optional(s.enum(['contents', 'window', 'fixed']))}),
      run: run((S, p) => autofit(S, p.mode ?? 'window'))}),
    t_({id: 'table.distributeColumns', label: 'Distribute Columns', description: 'Distribute Columns (Table Layout › Cell Size): every column the same width.',
      params: s.object({}),
      run: run(S => withTable(S, t => { const total = t.grid.reduce((a, x) => a + x, 0); const n = Math.max(1, t.grid.length); return syncCellWidths({...t, grid: t.grid.map(() => total / n)}); }))}),
    t_({id: 'table.distributeRows', label: 'Distribute Rows', description: 'Distribute Rows (Table Layout › Cell Size): every row the height of the tallest set one (at least 18 pt).',
      params: s.object({}),
      run: run(S => withTable(S, t => {
        const h = Math.max(18, t.rows.reduce((m, r) => Math.max(m, r.props?.height ?? 0), 0));
        return {...t, rows: t.rows.map(r => rowProps(r, {height: h}))};
      }))}),
    t_({id: 'table.columnWidth', label: 'Table Column Width', description: 'Table Column Width (Table Layout › Cell Size): every column the selection covers gets this width.',
      params: s.object({width: s.number({min: 0, max: 100000})}),
      state(ctx) {
        const st = inTable(ctx);
        if (!st.enabled) return st;
        const ct = caretTable(ctx);
        return {enabled: true, value: Math.round((ct.t.grid[gridCol(ct.t, ct.r, ct.c)] ?? 0) * 10) / 10};
      },
      run: run((S, p) => {
        const w = clampNum(p.width, 6, 1584);
        const cells = T.selectedCells(S);
        return withTable(S, t => setColumnWidths(t, cells, w));
      })}),
    t_({id: 'table.rowHeight', label: 'Table Row Height', description: 'Table Row Height (Table Layout › Cell Size): every row the selection covers, at least or exactly this tall.',
      params: s.object({height: s.number({min: 0, max: 100000}), rule: s.optional(s.enum(['atLeast', 'exact']))}),
      state(ctx) {
        const st = inTable(ctx);
        if (!st.enabled) return st;
        const ct = caretTable(ctx);
        const h = ct.t.rows[ct.r]?.props?.height;
        return {enabled: true, value: typeof h === 'number' ? Math.round(h * 10) / 10 : null};
      },
      run: run((S, p) => {
        const h = clampNum(p.height, 1, 1584);
        const rule = p.rule ?? 'atLeast';
        const rows = [...new Set(T.selectedCells(S).map(([r]) => r))];
        return withTable(S, t => {
          let x = t;
          for (const r of rows) if (x.rows[r]) x = setRow(x, r, rw => rowProps(rw, {height: h, heightRule: rule}));
          return x;
        });
      })}),
    t_({id: 'table.repeatHeader', label: 'Repeat Header Rows', description: 'Repeat Header Rows (Table Layout › Data): the caret\'s row repeats at the top of each page.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { const st = inTable(ctx); if (!st.enabled) return st; const ct = caretTable(ctx); return {enabled: true, checked: !!ct.t.rows[ct.r]?.props?.header}; },
      run: run((S, p) => {
        const [, r] = T.cell(S);
        return withTable(S, t => (t.rows[r] ? setRow(t, r, rw => rowProps(rw, {header: (p.value ?? !rw.props?.header) || null})) : t));
      })}),
    t_({id: 'table.altText', label: 'Alt Text', description: 'Alt Text (Table Properties › Alt Text): the table\'s title and description; empty clears.',
      params: s.object({text: s.optional(s.string({max: 100000})), title: s.optional(s.string({max: 100000}))}),
      run: run((S, p) => {
        if (p.title === undefined && p.text === undefined) throw badParams('`text` or `title` (string) is required');
        const set = (x, cur) => (x === undefined ? cur : x.trim() === '' ? null : P.capAlt(x));
        return withTable(S, t => tableProps(t, {caption: set(p.title, t.props?.caption ?? null), description: set(p.text, t.props?.description ?? null)}));
      })}),
    t_({id: 'table.sort', label: 'Sort', dialog: 'dialog.tableSort', description: 'Sort (Table Layout › Data): the rows by a column; numbers first, numerically, then text in the column\'s language.',
      params: s.object({column: s.optional(s.integer({min: 0, max: 62})), descending: s.optional(s.boolean()), header: s.optional(s.boolean())}),
      run: run(sortTable)}),
    t_({id: 'table.toText', label: 'Convert to Text', dialog: 'dialog.tableToText',
      description: 'Convert to Text (Table Layout › Data): the selected rows, or the whole table, become paragraphs separated by tabs, commas, paragraph marks or another character.',
      params: s.object({separator: s.optional(s.enum(['tab', 'comma', 'paragraph', 'other'])), char: s.optional(s.string({max: 16}))}),
      run: run(toText)}),
    t_({id: 'table.formula', label: 'Formula', dialog: 'dialog.tableFormula',
      description: 'Formula (Table Layout › Data): insert a formula field (=SUM(ABOVE), cell references, functions), evaluated now and by Update Field.',
      params: s.object({formula: s.optional(s.string({max: 4096}))}),
      run: run(formula)}),
    t_({id: 'table.selectTable', label: 'Select Table', risk: 'read', effect: 'view', description: 'Select Table (Table Layout › Table › Select).',
      params: s.object({}), run: run(S => { const [tp] = T.cell(S); return selectFinish(S, () => T.selectCells(S, tp, null)); })}),
    t_({id: 'table.selectRow', label: 'Select Row', risk: 'read', effect: 'view', description: 'Select Row (Table Layout › Table › Select).',
      params: s.object({}), run: run(S => { const [tp, r] = T.cell(S); return selectFinish(S, () => T.selectCells(S, tp, [r, null])); })}),
    t_({id: 'table.selectColumn', label: 'Select Column', risk: 'read', effect: 'view', description: 'Select Column (Table Layout › Table › Select): the grid columns of the selected cells, every row.',
      params: s.object({}), run: run(S => selectFinish(S, () => selectColumn(S)))}),
    t_({id: 'table.selectCell', label: 'Select Cell', risk: 'read', effect: 'view', description: 'Select Cell (Table Layout › Table › Select).',
      params: s.object({}), run: run(S => { const [tp, r, c] = T.cell(S); return selectFinish(S, () => T.selectCells(S, tp, [r, c])); })}),
    t_({id: 'table.rtl', label: 'Right-to-Left Table', description: 'Right-to-Left Table (Table Layout › Table): the first column stands at the right; without a value it toggles.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) { const st = inTable(ctx); if (!st.enabled) return st; return {enabled: true, checked: !!caretTable(ctx).t.props?.bidiVisual}; },
      run: run((S, p) => {
        const [tp] = T.cell(S);
        const on = p.value ?? !S.d.table(S.sel.focus.story, tp)?.props?.bidiVisual;
        return withTable(S, t => tableProps(t, {bidiVisual: on || null}));
      })}),
    t_({id: 'table.properties', label: 'Properties', dialog: 'dialog.tableProperties',
      description: 'Properties (Table Layout › Table): table, row, column and cell settings in one step; without settings it returns the current ones.',
      params: s.object({align: s.optional(s.enum(['left', 'center', 'right'])), rtl: s.optional(s.boolean()), width: s.optional(s.nullable(s.number())),
        widthPct: s.optional(s.number()), indent: s.optional(s.number()), rowHeight: s.optional(s.nullable(s.number())),
        rowHeightRule: s.optional(s.enum(['atLeast', 'exact'])), allowBreak: s.optional(s.boolean()), headerRow: s.optional(s.boolean()),
        columnWidth: s.optional(s.number()), cellWidth: s.optional(s.nullable(s.number())), valign: s.optional(s.enum(['top', 'center', 'bottom']))}),
      run: (ctx, p) => {
        const S = T.open(ctx);
        if (!PROPERTY_KEYS.some(k => p?.[k] !== undefined)) return properties(S, p ?? {});
        return properties(S, p);
      }}),
    {id: 'table.fromText', label: 'Convert Text to Table', risk: 'edit', dialog: 'dialog.textToTable',
      description: 'Convert Text to Table (Insert › Tables): the selected paragraphs become a table, split at tabs, commas, paragraphs or another character.',
      params: s.object({separator: s.optional(s.enum(['tab', 'comma', 'paragraph', 'other'])), char: s.optional(s.string({max: 16})),
        columns: s.optional(s.integer({min: 1, max: 1000})), autofit: s.optional(s.enum(['initial', 'fixed', 'contents', 'window'])),
        width: s.optional(s.nullable(s.number()))}),
      state: T.ready,
      run: run(fromText)},
    {id: 'table.quick', label: 'Quick Tables', risk: 'edit', description: 'Quick Tables (Insert › Tables): a calendar, tabular list or matrix, already styled.',
      params: s.object({kind: s.optional(s.enum(['calendar', 'tabular', 'matrix']))}),
      state: T.ready,
      run: run(quickTable)},
  ],
});

export {fixCaret, withTable, withCells, cellProps, tableProps, rowProps, setRow, setCell, guardDelete, textSpans, merge, autofit, row as insertRowAt, col as insertColAt};
