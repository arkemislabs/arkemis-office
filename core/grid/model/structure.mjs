// Structural edits as one app-specific change op (docs/architecture.md 4.2): inserting or deleting
// whole rows or columns moves cells, line sizes, merges, tables, the freeze and every formula and
// defined name that refers to the sheet, exactly as gridcraft adjusts references; addresses and
// anchors map through the same op (address.mjs `mapThrough`).
// Translated from gridcraft crates/model/src/sheet.rs (`insert_rows`, `delete_rows`,
// `insert_cols`, `delete_cols`, `shift_lines`, `shift_merges`) and crates/model/src/workbook.rs
// (`adjust_all`) at 146161b4b450a56e5e59a083ba0478582d1e602b, using crates/formula/src/adjust.rs
// through lib/formula.mjs `adjust`. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Op: {op: 'grid.structure', sheet: <sheet id>, edit: {type: 'insert'|'delete', axis: 'rows'|'cols', at, count}}
// Inverse: {op: 'grid.replace', sheets, names} (the exact previous sheets and names, shared).
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {MAX_ROWS, MAX_COLS, parseRange, rangeA1} from '../lib/addr.mjs';
import {parse, parseName, print, adjust} from '../lib/formula.mjs';
import {blockOf, blockEntries, isLegacySheet} from './store.mjs';
import {a1} from '../lib/addr.mjs';

const mapIndex = (v, at, cnt, insert, max) => {
  if (insert) { if (v >= at) { const n = v + cnt; return n >= max ? null : n; } return v; }
  if (v < at) return v;
  if (v >= at + cnt) return v - cnt;
  return null;
};

/** Moves an index through an edit (null when deleted or pushed off the sheet). */
export function mapLine(edit, axis, v) {
  if (edit.axis !== axis) return v;
  return mapIndex(v, edit.at, edit.count, edit.type === 'insert', axis === 'rows' ? MAX_ROWS : MAX_COLS);
}

/** A range through an edit; null when it is deleted whole. */
export function mapRange(edit, r) {
  const axis = edit.axis, insert = edit.type === 'insert';
  const lo = axis === 'rows' ? r.start.row : r.start.col, hi = axis === 'rows' ? r.end.row : r.end.col;
  const max = axis === 'rows' ? MAX_ROWS : MAX_COLS;
  let lo2, hi2;
  if (insert) {
    lo2 = lo >= edit.at ? lo + edit.count : lo;
    hi2 = Math.min(hi >= edit.at ? hi + edit.count : hi, max - 1);
    if (lo2 > hi2) return null;
  } else {
    const end = edit.at + edit.count;
    if (lo >= edit.at && hi < end) return null;
    lo2 = lo < edit.at ? lo : lo >= end ? lo - edit.count : edit.at;
    hi2 = hi < edit.at ? hi : hi >= end ? hi - edit.count : Math.max(0, edit.at - 1);
    hi2 = Math.max(hi2, lo2);
  }
  return axis === 'rows' ? {start: {row: lo2, col: r.start.col}, end: {row: hi2, col: r.end.col}}
    : {start: {row: r.start.row, col: lo2}, end: {row: r.end.row, col: hi2}};
}

function adjustFormula(text, host, target, edit, named = false) {
  let expr;
  try { expr = named ? parseName(text) : parse(text); } catch { return text; }
  return print(adjust(expr, host, target, edit));
}

function moveLines(map, edit, axis) {
  if (!map || typeof map !== 'object' || edit.axis !== axis) return map;
  const out = {};
  for (const k of Object.keys(map)) {
    const n = mapLine(edit, axis, Number(k));
    if (n !== null) out[n] = map[k];
  }
  return out;
}

/** The sheet's cells moved through the edit; formulas everywhere adjusted for `target`. */
function moveCells(sheet, edit, host, target) {
  const out = {};
  for (const bk of Object.keys(sheet.blocks ?? {})) {
    const e = blockEntries(sheet.blocks[bk]);
    for (let i = 0; i < e.rows.length; i++) {
      const row = edit.axis === 'rows' ? mapLine(edit, 'rows', e.rows[i]) : e.rows[i];
      const col = edit.axis === 'cols' ? mapLine(edit, 'cols', e.cols[i]) : e.cols[i];
      if (row === null || col === null) continue;
      let cell = e.cells[i];
      if (cell.f !== undefined) cell = {...cell, f: adjustFormula(cell.f, host, target, edit)};
      if (cell.a) { const r = parseRange(cell.a); const m = r && mapRange(edit, r); cell = m ? {...cell, a: rangeA1(m)} : (({a, ...rest}) => rest)(cell); }
      (out[blockOf(row)] ??= {})[a1(row, col)] = cell;
    }
  }
  return out;
}

function adjustSheetFormulas(sheet, host, target, edit) {
  let changed = false;
  const blocks = {};
  for (const bk of Object.keys(sheet.blocks ?? {})) {
    const b = sheet.blocks[bk];
    let nb = b;
    for (const k of Object.keys(b)) {
      const c = b[k];
      if (c.f === undefined) continue;
      const f = adjustFormula(c.f, host, target, edit);
      if (f !== c.f) { if (nb === b) nb = {...b}; nb[k] = {...c, f}; }
    }
    if (nb !== b) changed = true;
    blocks[bk] = nb;
  }
  return changed ? {...sheet, blocks} : sheet;
}

/** Applies a structural edit; returns {content, inverse}. */
export function applyStructure(content, op) {
  const si = content.sheets.findIndex(s => s.id === op.sheet);
  if (si < 0) throw new CommandError('not_found', `No sheet ${op.sheet}`);
  const edit = op.edit;
  if (!edit || !['insert', 'delete'].includes(edit.type) || !['rows', 'cols'].includes(edit.axis)
    || !Number.isInteger(edit.at) || !Number.isInteger(edit.count) || edit.at < 0 || edit.count < 1) {
    throw new CommandError('invalid_params', 'A structural edit is {type: insert|delete, axis: rows|cols, at, count}');
  }
  const sheet = content.sheets[si];
  if (isLegacySheet(sheet)) throw new CommandError('failed', 'Migrate the workbook to schema 2 before inserting or deleting lines');
  const target = sheet.name;
  const sheets = content.sheets.map((sh, i) => {
    if (i !== si) return adjustSheetFormulas(sh, sh.name, target, edit);
    const next = {...sh, blocks: moveCells(sh, edit, sh.name, target)};
    if (sh.rows) next.rows = moveLines(sh.rows, edit, 'rows');
    if (sh.cols) next.cols = moveLines(sh.cols, edit, 'cols');
    if (sh.merges) next.merges = sh.merges.map(m => { const r = parseRange(m); const x = r && mapRange(edit, r); return x && rangeA1(x); })
      .filter(m => m && m.includes(':'));
    if (sh.tables) next.tables = sh.tables.map(t => { const r = parseRange(t.range); const x = r && mapRange(edit, r); return x ? {...t, range: rangeA1(x)} : null; }).filter(Boolean);
    if (sh.freeze) {
      const key = edit.axis === 'rows' ? 'rows' : 'cols';
      const n = sh.freeze[key];
      if (n && edit.at < n) next.freeze = {...sh.freeze, [key]: Math.max(0, edit.type === 'insert' ? n + edit.count : n - Math.min(edit.count, n - edit.at))};
    }
    return next;
  });
  const names = (content.names ?? []).map(n => {
    const host = n.scope ? content.sheets.find(s => s.id === n.scope)?.name ?? target : target;
    const formula = adjustFormula(String(n.formula ?? '').replace(/^=/, ''), host, target, edit, true);
    return formula === n.formula ? n : {...n, formula};
  });
  return {content: {...content, sheets, ...(content.names ? {names} : {})}, inverse: {op: 'grid.replace', sheets: content.sheets, names: content.names}};
}

/** App ops of the grid foundation (schema.mjs `apply`). */
export function applyGridOp(content, op) {
  switch (op?.op) {
    case 'grid.structure': return applyStructure(content, op);
    case 'grid.replace': {
      const next = {...content, sheets: op.sheets};
      if (op.names === undefined) delete next.names; else next.names = op.names;
      return {content: next, inverse: {op: 'grid.replace', sheets: content.sheets, names: content.names}};
    }
    default: throw new CommandError('failed', `Unknown grid operation ${op?.op}`);
  }
}
