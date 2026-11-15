// What moves with the cells when rows, columns or cells are inserted, deleted or moved (U:grid/sheet):
// merged areas, conditional-format, validation and edit-range ranges, tables (and their columns),
// the AutoFilter, the print area, notes, comments, hyperlinks, and every formula and defined name
// that refers to the sheet.
// Translated from gridcraft crates/engine/src/cmd/sheet.rs (`map_range`, `shift_sheet_features`,
// `shift_cell_features`, `shift_table_columns`, `check_table_shift`, `inherit_line_format`,
// `rewrite`) at 146161b4b450a56e5e59a083ba0478582d1e602b, with references adjusted through
// lib/formula.mjs `adjust` (crates/formula/src/adjust.rs). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Whole rows and columns go through the foundation's `grid.structure` op (cells, line sizes,
// merges, tables, freeze, formulas, names); `shiftSideTables` then moves the side tables that op
// leaves. Insert/Delete Cells and Move Columns have no foundation op: `transformSheets` builds the
// new sheets and names and the command applies them as one `grid.replace` op (undo restores the
// exact previous sheets). No DOM, no Node built-ins.

import {MAX_ROWS, MAX_COLS, parseRange, rangeA1, a1, parseCell} from './addr.mjs';
import {parse, parseName, print, adjust, refRange} from './formula.mjs';
import {blockOf, blockEntries} from '../model/store.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {shiftObjects, rewriteSources, fixRef} from './objects-shift.mjs';

/** sheet.rs `map_range`: where a range of the edited sheet goes after an edit (null = deleted). */
export function mapRangeThrough(edit, r) {
  const expr = {t: 'ref', sheet: {k: 'cur'}, kind: {k: 'range',
    a: {row: r.start.row, col: r.start.col, rowAbs: false, colAbs: false}, b: {row: r.end.row, col: r.end.col, rowAbs: false, colAbs: false}}};
  const out = adjust(expr, 'S', 'S', edit);
  return out?.t === 'ref' ? refRange(out) : null;
}
const mapText = (edit, text) => { const r = parseRange(String(text)); if (!r) return text; const m = mapRangeThrough(edit, r); return m ? rangeA1(m) : null; };
const mapCellKey = (edit, key) => { const c = parseCell(key); if (!c) return key; const m = mapRangeThrough(edit, {start: c, end: c}); return m ? a1(m.start.row, m.start.col) : null; };
const isSingleText = t => { const r = parseRange(t); return !!r && r.start.row === r.end.row && r.start.col === r.end.col; };

const ruleList = (list, edit) => {
  if (!Array.isArray(list)) return list;
  const out = [];
  for (const rule of list) {
    const rs = Array.isArray(rule?.ranges) ? rule.ranges : rule?.range ? [rule.range] : null;
    if (!rs) { out.push(rule); continue; }
    const mapped = rs.map(x => (typeof x === 'string' ? mapText(edit, x) : x)).filter(Boolean);
    if (!mapped.length) continue;
    out.push(Array.isArray(rule.ranges) ? {...rule, ranges: mapped} : {...rule, range: mapped[0]});
  }
  return out;
};
const keyMap = (map, edit) => {
  if (!map || typeof map !== 'object') return map;
  const out = {};
  for (const [k, v] of Object.entries(map)) { const n = mapCellKey(edit, k); if (n) out[n] = v; }
  return out;
};

/** sheet.rs `shift_table_columns`: columns inserted inside a table become new table columns; deleted ones leave it. */
export function shiftTableColumns(t, at, count, insert) {
  const r = parseRange(t.range);
  const cols = Array.isArray(t.columns) ? t.columns.slice() : null;
  if (!r || !cols) return t;
  if (insert) {
    if (at > r.start.col && at <= r.end.col) {
      const idx = at - r.start.col;
      let n = cols.length;
      for (let k = 0; k < count; k++) {
        let name;
        do { n++; name = `Column${n}`; } while (cols.some(c => String(c?.name ?? c).toLowerCase() === name.toLowerCase()));
        cols.splice(Math.min(idx + k, cols.length), 0, typeof cols[0] === 'string' ? name : {name});
      }
    }
    return {...t, columns: cols};
  }
  const lo = Math.max(at, r.start.col), hi = Math.min(at + count, r.end.col + 1);
  if (hi > lo) {
    const a = lo - r.start.col, b = hi - r.start.col;
    if (b <= cols.length) cols.splice(a, b - a);
  }
  return {...t, columns: cols};
}

/**
 * The side tables of one sheet through an edit (sheet.rs `shift_cell_features` /
 * `shift_sheet_features` for what the foundation op does not move). `withCore` also maps merges
 * and tables (Insert/Delete Cells and moves, which the foundation op does not handle).
 */
export function shiftSheet(sheet, edit, {withCore = false} = {}) {
  const next = {...sheet};
  if (withCore) {
    if (Array.isArray(sheet.merges)) next.merges = sheet.merges.map(m => mapText(edit, m)).filter(m => m && !isSingleText(m));
    if (Array.isArray(sheet.tables)) {
      next.tables = sheet.tables.map(t => {
        let t2 = t;
        const tr = parseRange(t.range);
        if (tr && (edit.type === 'insertCells' || edit.type === 'deleteCells') && edit.axis === 'cols'
          && edit.range.start.row <= tr.start.row && edit.range.end.row >= tr.end.row) {
          t2 = shiftTableColumns(t, edit.range.start.col, edit.range.end.col - edit.range.start.col + 1, edit.type === 'insertCells');
        }
        const m = mapText(edit, t.range);
        return m ? {...t2, range: m} : null;
      }).filter(t => t && (!Array.isArray(t.columns) || t.columns.length));
    }
  }
  for (const k of ['conditionalFormats', 'validations', 'editRanges']) if (sheet[k] !== undefined) next[k] = ruleList(sheet[k], edit);
  for (const k of ['notes', 'comments', 'hyperlinks', 'cellPictures']) if (sheet[k] !== undefined) next[k] = keyMap(sheet[k], edit);
  if (sheet.autofilter?.range) {
    const m = mapText(edit, sheet.autofilter.range);
    if (m) next.autofilter = {...sheet.autofilter, range: m}; else delete next.autofilter;
  }
  if (typeof sheet.printArea === 'string') {
    const m = mapText(edit, sheet.printArea);
    if (m) next.printArea = m; else delete next.printArea;
  }
  if (Array.isArray(sheet.sparklines)) {
    next.sparklines = sheet.sparklines.map(sp => { const n = sp?.cell ? mapCellKey(edit, sp.cell) : sp?.cell; return n === null ? null : {...sp, cell: n, ...(sp.source ? {source: fixRef(sp.source, sheet.name, sheet.name, edit)} : {})}; }).filter(Boolean);
  }
  if (Array.isArray(sheet.pivots)) {
    // A PivotTable moves with its report; its source follows the cells it reads. One whose first cell was deleted goes.
    next.pivots = sheet.pivots.map(pt => {
      const an = mapText(edit, pt.anchor);
      if (an === null) return null;
      const lr = pt.lastRange ? mapText(edit, pt.lastRange) : null;
      const src = typeof pt.source === 'string' && /[!:]/.test(pt.source) ? fixRef(pt.source, sheet.name, sheet.name, edit) : pt.source;
      return {...pt, anchor: an, lastRange: lr, source: src};
    }).filter(Boolean);
  }
  return next;
}

/**
 * The side tables the foundation's line op leaves, moved through it (one change per changed key). `before` is the
 * edited sheet as it was: the floating objects follow their anchors by it, and every sheet's charts and sparklines
 * follow the cells they plot.
 */
export function shiftSideTables(change, content, si, edit, before = null) {
  const sheet = content.sheets[si];
  const objects = before ? shiftObjects(sheet, before, edit) : {};
  for (const [k, v] of Object.entries(objects)) change.set(['sheets', si, k], v);
  content.sheets.forEach((sh, sj) => {
    const base = sj === si ? {...sh, ...objects} : sh;
    for (const [k, v] of Object.entries(rewriteSources(base, sh.name, sheet.name, edit, sj !== si))) change.set(['sheets', sj, k], v);
  });
  const next = shiftSheet(sheet, edit);
  for (const k of ['conditionalFormats', 'validations', 'editRanges', 'notes', 'comments', 'hyperlinks', 'cellPictures', 'autofilter', 'printArea', 'sparklines', 'pivots']) {
    if (sheet[k] === undefined && next[k] === undefined) continue;
    if (JSON.stringify(sheet[k]) === JSON.stringify(next[k])) continue;
    if (next[k] === undefined) change.delete(['sheets', si, k]); else change.set(['sheets', si, k], next[k]);
  }
}

/**
 * Table columns after a whole-column insert or delete (the foundation op moves table ranges
 * only): `before` is the sheet as it was before the op.
 */
export function fixTableColumns(change, content, si, before, edit) {
  if (edit.axis !== 'cols' || !Array.isArray(before?.tables)) return;
  const now = content.sheets[si].tables;
  if (!Array.isArray(now)) return;
  const byName = new Map(before.tables.map(t => [t.name, t]));
  const tables = now.map(t => {
    const old = byName.get(t.name);
    if (!old || !Array.isArray(old.columns)) return t;
    const cols = shiftTableColumns(old, edit.at, edit.count, edit.type === 'insert').columns;
    return JSON.stringify(cols) === JSON.stringify(t.columns) ? t : {...t, columns: cols};
  }).filter(t => !Array.isArray(t.columns) || t.columns.length);
  if (JSON.stringify(tables) !== JSON.stringify(now)) change.set(['sheets', si, 'tables'], tables);
}

function adjustText(text, host, target, edit, named = false) {
  let e;
  try { e = named ? parseName(text) : parse(text); } catch { return text; }
  return print(adjust(e, host, target, edit));
}

/**
 * Cells of `sheet` moved by `move(row, col) -> [row, col] | null` (null drops the cell), formulas
 * adjusted for `edit` against the edited sheet `target`.
 */
function movedBlocks(sheet, move, edit, target) {
  const out = {};
  for (const bk of Object.keys(sheet.blocks ?? {})) {
    const e = blockEntries(sheet.blocks[bk]);
    for (let i = 0; i < e.rows.length; i++) {
      const to = move(e.rows[i], e.cols[i]);
      if (!to) continue;
      const [row, col] = to;
      if (row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS) continue;
      let cell = e.cells[i];
      if (cell.f !== undefined) { const f = adjustText(cell.f, sheet.name, target, edit); if (f !== cell.f) cell = {...cell, f}; }
      if (cell.a) { const m = mapText(edit, cell.a); cell = m ? {...cell, a: m} : (({a, ...rest}) => rest)(cell); }
      (out[blockOf(row)] ??= {})[a1(row, col)] = cell;
    }
  }
  return out;
}

/**
 * New sheets and names for a cell-level edit on sheet `si`:
 *   {type: 'insertCells'|'deleteCells', axis: 'rows'|'cols', range} (Insert/Delete Cells), or
 *   {type: 'move', from, toRow, toCol} (a block moved on its sheet; the destination is replaced).
 * `move(row, col)` places the edited sheet's cells; other sheets only get their formulas adjusted.
 */
export function transformSheets(content, si, edit, move) {
  const target = content.sheets[si].name;
  const sheets = content.sheets.map((sh, i) => {
    if (i === si) return {...shiftSheet(sh, edit, {withCore: true}), ...rewriteSources(sh, sh.name, target, edit, false), blocks: movedBlocks(sh, move, edit, target)};
    return {...sh, ...rewriteSources(sh, sh.name, target, edit, true), blocks: movedBlocks(sh, (r, c) => [r, c], edit, target)};
  });
  const names = Array.isArray(content.names) ? content.names.map(n => {
    const was = String(n.formula ?? '');
    const body = was.replace(/^=/, '');
    const text = adjustText(body, '\u0000', target, edit, true);
    return text === body ? n : {...n, formula: was.startsWith('=') ? `=${text}` : text};
  }) : content.names;
  return {sheets, names};
}

/** The cells move of Insert/Delete Cells (sheet.rs `shift_rows_in_cols` / `shift_cols_in_rows` and `take_cells`). */
export function cellShift(edit) {
  const r = edit.range;
  const h = r.end.row - r.start.row + 1, w = r.end.col - r.start.col + 1;
  const insert = edit.type === 'insertCells';
  if (edit.axis === 'rows') {
    return (row, col) => {
      if (col < r.start.col || col > r.end.col) return [row, col];
      if (insert) return row >= r.start.row ? [row + h, col] : [row, col];
      if (row >= r.start.row && row <= r.end.row) return null;
      return row > r.end.row ? [row - h, col] : [row, col];
    };
  }
  return (row, col) => {
    if (row < r.start.row || row > r.end.row) return [row, col];
    if (insert) return col >= r.start.col ? [row, col + w] : [row, col];
    if (col >= r.start.col && col <= r.end.col) return null;
    return col > r.end.col ? [row, col - w] : [row, col];
  };
}

/**
 * sheet.rs `check_table_shift`: Insert/Delete Cells never shifts part of a table (cells shifted up
 * or down must hold whole table columns, left or right whole table rows, and deleting never takes
 * a header row without the whole table).
 */
export function checkTableShift(sheet, edit) {
  if (edit.type !== 'insertCells' && edit.type !== 'deleteCells') return;
  const r = edit.range, del = edit.type === 'deleteCells';
  for (const t of sheet.tables ?? []) {
    const tr = parseRange(t.range);
    if (!tr) continue;
    let ok;
    if (edit.axis === 'rows') {
      const moves = tr.end.row >= r.start.row && tr.start.col <= r.end.col && tr.end.col >= r.start.col;
      const header = t.headerRow !== false && t.header !== false;
      const headerAlone = del && header && r.start.row <= tr.start.row && r.end.row >= tr.start.row && r.end.row < tr.end.row;
      ok = !moves || (r.start.col <= tr.start.col && r.end.col >= tr.end.col && !headerAlone);
    } else {
      const moves = tr.end.col >= r.start.col && tr.start.row <= r.end.row && tr.end.row >= r.start.row;
      ok = !moves || (r.start.row <= tr.start.row && r.end.row >= tr.end.row);
    }
    if (!ok) throw new CommandError('failed', "This operation isn't allowed: it would shift cells in a table on your worksheet.");
  }
}
