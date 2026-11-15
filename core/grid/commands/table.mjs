// Table Design tab: Table Name, Resize Table, Convert to Range, Remove Duplicates, the Table Style
// Options (Header Row, Total Row, Banded Rows, First Column, Last Column, Banded Columns), the Table
// Styles gallery and the Total Row functions.
// Translated from gridcraft crates/engine/src/cmd/insert/table.rs (`table_flag`, `write_totals`,
// `table_total_fn`, `table_style`, `table_rename`, `table_convert`, `valid_table_name`) and
// cmd/extra/data.rs (`table_resize`) at 146161b4b450a56e5e59a083ba0478582d1e602b, with
// tables.rs (`gallery`, `table_cell_style`). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A table is stored on its sheet: {name, range: 'A1:C9', headerRow, totalsRow, columns: [{name,
// totalsRowFunction?, totalsRowLabel?}], style: {name|null, showRowStripes, showColumnStripes,
// showFirstColumn, showLastColumn}, autoFilter}. A table with no header row keeps its column names
// in `columns` and its range starts at the first data row (model/sheet.mjs `tableRanges`).
//
// Differences kept on purpose:
//   - Header Row is Excel's (the header cells are cleared and the table range starts at the first
//     data row; turning it back on writes the column names above it, inserting a row when the row
//     above holds data). gridcraft's `table.headerRow` toggles the filter buttons, which here is
//     the Filter Button check box (data.filter).
//   - Total Row asks for room the way Excel does: cells below the table move down when the row
//     under it holds data (gridcraft overwrote them).
//   - Export, Properties, Open in Browser and Unlink need a linked (SharePoint) table: hidden.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {a1, parseRange, rangeA1, contains, intersects, rangeOf, MAX_ROWS} from '../lib/addr.mjs';
import {engineFor} from '../model/calc.mjs';
import {cellAt, writeCell, blockEntries} from '../model/store.mjs';
import {styleAt, styleIdAt} from '../model/workbook.mjs';
import {resolveColor, hex, DEFAULT_THEME} from '../model/style.mjs';
import {tableRanges, tableByName} from '../model/sheet.mjs';
import {hasDoc, gridSel, requireSchema2} from '../lib/edit-targets.mjs';
import {bad, failed, baseDoc, valueOf} from '../lib/data-common.mjs';
import {ERR, display} from '../lib/value.mjs';
import {parse, parseName, print, mapExpr, structRefText} from '../lib/formula.mjs';
import {tablesOf, styleInfo, tableLook, tableCellStyle, gallery} from '../lib/table-style.mjs';
import {internFull} from '../lib/format-ranges.mjs';
import {validTableName} from './insert/tables.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/insert/table.rs', 'crates/engine/src/cmd/extra/data.rs', 'crates/engine/src/tables.rs']};
const TABLE = s.optional(s.string({min: 1, max: 255}));
const ON = s.optional(s.boolean());

/** The SUBTOTAL function numbers of the Total Row functions (`TotalsFn::subtotal_code`). */
export const TOTAL_CODES = Object.freeze({sum: 109, average: 101, count: 103, countNums: 102, max: 104, min: 105, stdDev: 107, var: 110});
export const TOTAL_FUNCTIONS = Object.freeze(['none', 'average', 'count', 'countNums', 'max', 'min', 'stdDev', 'sum', 'var', 'custom']);

// ---------------------------------------------------------------- lookup

/** The table a call names (`table`), else the one holding the active cell: {content, si, ti, t, sheet, range}. */
function locate(ctx, p, what) {
  const content = baseDoc(ctx);
  if (typeof p.table === 'string' && p.table) {
    const hit = tableByName(content, p.table);
    if (!hit) throw bad(what, `no table named \`${p.table}\``);
    const sheet = content.sheets[hit[0]];
    return {content, si: hit[0], ti: sheet.tables.indexOf(hit[1]), t: hit[1], sheet, range: parseRange(hit[1].range)};
  }
  const sel = gridSel(ctx);
  const sheet = content.sheets[sel.sheet];
  const list = tablesOf(sheet);
  const at = list.find(x => contains(x.range, sel.active));
  if (!at) throw failed('Select a cell in a table.');
  return {content, si: sel.sheet, ti: sheet.tables.indexOf(at.table), t: at.table, sheet, range: at.range};
}

/** The table at the active cell of the current document, or null (for state functions). */
function tableAtActive(ctx) {
  if (!hasDoc(ctx).enabled) return null;
  const sel = gridSel(ctx);
  const sheet = ctx.doc.sheets[sel.sheet];
  const at = tablesOf(sheet).find(x => contains(x.range, sel.active));
  return at ? at.table : null;
}
const inTable = pick => (ctx, p) => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  const named = typeof p?.table === 'string' && p.table ? tableByName(ctx.doc, p.table) : null;
  const t = named ? named[1] : tableAtActive(ctx);
  if (!t) return {enabled: false, reason: 'select a cell in a table'};
  return {enabled: true, ...pick(t)};
};

const tableAt = (ctx, si, ti) => ctx.change.get(['sheets', si, 'tables', ti]) ?? ctx.doc.sheets[si].tables[ti];
const saveTable = (ctx, si, ti, t) => ctx.change.set(['sheets', si, 'tables', ti], t);
const styleOf = t => { const st = styleInfo(t); return {name: st.name === 'None' ? null : st.name, showRowStripes: st.showRowStripes, showColumnStripes: st.showColumnStripes, showFirstColumn: st.showFirstColumn, showLastColumn: st.showLastColumn}; };

// ---------------------------------------------------------------- formulas that name a table

/** Rewrites every formula of the workbook (and the defined names) through `f(expr, si, row, col)`; null keeps one. */
function mapFormulas(ctx, content, f) {
  content.sheets.forEach((sheet, si) => {
    if (!sheet.blocks) return;
    for (const bk of Object.keys(sheet.blocks)) {
      const e = blockEntries(sheet.blocks[bk]);
      for (let i = 0; i < e.cells.length; i++) {
        const c = e.cells[i];
        if (c.f === undefined) continue;
        let expr;
        try { expr = parse(c.f); } catch { continue; }
        const out = f(expr, si, e.rows[i], e.cols[i]);
        if (out) writeCell(ctx.change, content, si, e.rows[i], e.cols[i], {...cellAt(sheet, e.rows[i], e.cols[i]), f: print(out)});
      }
    }
  });
  (content.names ?? []).forEach((n, i) => {
    let expr;
    try { expr = parseName(String(n.formula ?? '').replace(/^=/, '')); } catch { return; }
    const out = f(expr, -1, 0, 0);
    if (out) ctx.change.set(['names', i, 'formula'], `${String(n.formula ?? '').startsWith('=') ? '=' : ''}${print(out)}`);
  });
}

/** A copy of `expr` after `fn` changed some node, else null. */
function changed(expr, fn) {
  let hit = false;
  const out = mapExpr(expr, x => { const y = fn(x); if (y !== x) hit = true; return y; });
  return hit ? out : null;
}

// ---------------------------------------------------------------- Table Name

function renameTable(ctx, p) {
  const L = locate(ctx, p, 'table.rename');
  if (typeof p.name !== 'string' || !p.name) throw bad('table.rename', 'missing `name`');
  const name = p.name;
  if (!validTableName(name)) throw failed('The name that you entered is not valid.');
  const old = L.t.name;
  const lower = name.toLowerCase();
  const taken = L.content.sheets.some(sh => (sh.tables ?? []).some(t => t !== L.t && t.name.toLowerCase() === lower));
  if (taken || (L.content.names ?? []).some(n => n.name.toLowerCase() === lower)) throw failed('The name entered already exists. Enter a unique name.');
  if (name === old) return {table: name};
  const oldLower = old.toLowerCase();
  // A bare name that is also a defined name resolves to the defined name, so it is not the table.
  const shadowed = (L.content.names ?? []).some(n => n.name.toLowerCase() === oldLower);
  saveTable(ctx, L.si, L.ti, {...L.t, name});
  mapFormulas(ctx, L.content, expr => changed(expr, x => {
    if (x.t === 'struct' && String(x.table).toLowerCase() === oldLower) return {...x, table: name};
    if (x.t === 'name' && !shadowed && String(x.v).toLowerCase() === oldLower) return {...x, v: name};
    return x;
  }));
  // Slicers and PivotTables that point at the table follow it.
  L.content.sheets.forEach((sheet, si) => {
    (sheet.slicers ?? []).forEach((sl, i) => { if (String(sl.table).toLowerCase() === oldLower) ctx.change.set(['sheets', si, 'slicers', i, 'table'], name); });
    (sheet.pivots ?? []).forEach((pt, i) => { if (typeof pt.source === 'string' && pt.source.toLowerCase() === oldLower) ctx.change.set(['sheets', si, 'pivots', i, 'source'], name); });
  });
  return {table: name};
}

// ---------------------------------------------------------------- Resize Table

function resizeTable(ctx, p) {
  const L = locate(ctx, p, 'table.resize');
  const text = String(p.range ?? '').replace(/\$/g, '').replace(/^.*!/, '').trim();
  const r = parseRange(text);
  if (!r) throw bad('table.resize', 'missing `range`');
  requireSchema2(ctx, L.si);
  const engine = engineFor(L.content);
  if (tablesOf(L.sheet).some(o => o.table !== L.t && intersects(o.range, r))) throw failed("A table can't overlap another table.");
  if (r.start.row !== L.range.start.row || !intersects(r, L.range)) {
    throw failed('The headers must remain in the same row, and the resulting table range must overlap the original table range.');
  }
  const headerRow = L.t.headerRow !== false;
  const old = L.t.columns ?? [];
  const taken = new Set();
  const columns = [];
  const names = [];
  for (let c = r.start.col; c <= r.end.col; c++) {
    let name = headerRow ? display(valueOf(engine, L.si, r.start.row, c)) : (old[c - L.range.start.col]?.name ?? '');
    if (name === '') name = `Column${c - r.start.col + 1}`;
    const base = name;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}${k}`;
    taken.add(name.toLowerCase());
    names.push(name);
    columns.push(old.find(x => String(x.name).toLowerCase() === name.toLowerCase()) ?? {name});
  }
  // Headers are text: a new column's empty header cell is named, as Excel does.
  if (headerRow) {
    for (let c = r.start.col; c <= r.end.col; c++) {
      const own = cellAt(L.sheet, r.start.row, c);
      if (own?.v === undefined && own?.f === undefined) writeCell(ctx.change, L.content, L.si, r.start.row, c, {...(own ?? {}), v: names[c - r.start.col]});
    }
  }
  saveTable(ctx, L.si, L.ti, {...L.t, range: rangeA1(r), columns});
  return {table: L.t.name, range: rangeA1(r)};
}

// ---------------------------------------------------------------- Convert to Range

/** The range a structured reference covers for a formula at `row` (eval.mjs `structured`), or null when it has none. */
function structRange(info, st, row) {
  const {range, data, headerRow, totalsRow} = info;
  let r0 = range.start.row, r1 = range.end.row;
  const items = st.specifiers;
  if (!items.length || (items.length === 1 && items[0] === 'data')) {
    if (!data) return null;
    r0 = data.start.row; r1 = data.end.row;
  } else if (items.includes('thisRow')) {
    if (row < range.start.row || row > range.end.row) return null;
    r0 = r1 = row;
  } else if (!items.includes('all')) {
    let lo = Infinity, hi = -1;
    const add = (a, b) => { lo = Math.min(lo, a); hi = Math.max(hi, b); };
    if (items.includes('headers')) { if (!headerRow) return null; add(range.start.row, range.start.row); }
    if (items.includes('data') && data) add(data.start.row, data.end.row);
    if (items.includes('totals')) { if (!totalsRow) return null; add(range.end.row, range.end.row); }
    if (lo > hi) return null;
    r0 = lo; r1 = hi;
  }
  let c0 = range.start.col, c1 = range.end.col;
  const cols = info.columns.map(c => String(c.name).toLowerCase());
  if (st.colStart !== null) {
    const i = cols.indexOf(String(st.colStart).toLowerCase());
    if (i < 0) return null;
    c0 = c1 = range.start.col + i;
    if (st.colEnd !== null) {
      const j = cols.indexOf(String(st.colEnd).toLowerCase());
      if (j < 0) return null;
      c0 = Math.min(c0, range.start.col + j); c1 = Math.max(c1, range.start.col + j);
    }
  }
  return rangeOf(r0, c0, r1, c1);
}

const refNode = (si, content, host, r) => {
  const pt = (row, col) => ({row, col, rowAbs: false, colAbs: false});
  const sheet = si === host ? {k: 'cur'} : {k: 'named', name: content.sheets[si].name};
  return r.start.row === r.end.row && r.start.col === r.end.col
    ? {t: 'ref', sheet, kind: {k: 'cell', a: pt(r.start.row, r.start.col)}}
    : {t: 'ref', sheet, kind: {k: 'range', a: pt(r.start.row, r.start.col), b: pt(r.end.row, r.end.col)}};
};

function convertToRange(ctx, p) {
  const L = locate(ctx, p, 'table.convertToRange');
  const sheet = L.sheet;
  const info = {...tableRanges(L.t), columns: L.t.columns ?? []};
  const hit = {table: L.t, range: info.range};
  // The table look becomes plain formatting.
  for (let row = info.range.start.row; row <= info.range.end.row; row++) {
    for (let col = info.range.start.col; col <= info.range.end.col; col++) {
      const own = styleAt(L.content, sheet, row, col);
      const full = tableCellStyle(hit, row, col, own);
      if (full === own) continue;
      const id = internFull(ctx, full);
      if (id === styleIdAt(sheet, row, col)) continue;
      const cell = cellAt(ctx.change.get(['sheets', L.si]) ?? sheet, row, col) ?? {};
      writeCell(ctx.change, L.content, L.si, row, col, {...cell, s: id});
    }
  }
  const lower = L.t.name.toLowerCase();
  // Formulas that named the table now name its cells.
  mapFormulas(ctx, L.content, (expr, si, row, col) => changed(expr, x => {
    // `[@Qty]` names no table: the one holding the formula's cell.
    const own = x.t === 'struct' && x.table === '' && si === L.si && contains(info.range, {row, col});
    if (x.t !== 'struct' || (String(x.table).toLowerCase() !== lower && !own)) return x;
    const r = structRange(info, x, row);
    return r ? refNode(L.si, L.content, si, r) : {t: 'err', v: ERR.Ref};
  }));
  const next = (sheet.tables ?? []).filter(t => t !== L.t);
  if (next.length) ctx.change.set(['sheets', L.si, 'tables'], next); else ctx.change.delete(['sheets', L.si, 'tables']);
  // A slicer needs its table.
  const slicers = (sheet.slicers ?? []).filter(sl => String(sl.table).toLowerCase() !== lower);
  if (slicers.length !== (sheet.slicers ?? []).length) { if (slicers.length) ctx.change.set(['sheets', L.si, 'slicers'], slicers); else ctx.change.delete(['sheets', L.si, 'slicers']); }
  return {range: rangeA1(info.range)};
}

// ---------------------------------------------------------------- Table Style Options

/** Cells of the Total Row (labels and SUBTOTAL formulas), written for `t` as it is now. */
function writeTotals(ctx, content, si, t) {
  if (!t.totalsRow) return;
  const range = parseRange(t.range);
  const row = range.end.row;
  const sheet = ctx.change.get(['sheets', si]) ?? content.sheets[si];
  (t.columns ?? []).forEach((col, i) => {
    const c = range.start.col + i;
    const own = cellAt(sheet, row, c) ?? {};
    const fn = col.totalsRowFunction;
    if (fn && TOTAL_CODES[fn]) {
      writeCell(ctx.change, content, si, row, c, {s: own.s, f: `SUBTOTAL(${TOTAL_CODES[fn]},${structRefText({table: t.name, specifiers: [], colStart: col.name, colEnd: null})})`});
    } else if (fn === 'custom' && col.totalsRowFormula) {
      writeCell(ctx.change, content, si, row, c, {s: own.s, f: String(col.totalsRowFormula).replace(/^=/, '')});
    } else if (col.totalsRowLabel) writeCell(ctx.change, content, si, row, c, {s: own.s, v: col.totalsRowLabel});
    else writeCell(ctx.change, content, si, row, c, {s: own.s});
  });
}

/** Whether any cell of the `cols` of a row holds something. */
const rowHolds = (sheet, row, c0, c1) => { for (let c = c0; c <= c1; c++) { const x = cellAt(sheet, row, c); if (x && (x.v !== undefined || x.f !== undefined)) return true; } return false; };

/** Whether the column's data are numbers (the Total Row sums those and counts the rest). */
function numericColumn(content, si, t, i) {
  const info = tableRanges(t);
  if (!info.data) return false;
  const engine = engineFor(content);
  let n = 0, other = 0;
  for (let row = info.data.start.row; row <= info.data.end.row && row < info.data.start.row + 200; row++) {
    const v = valueOf(engine, si, row, info.range.start.col + i);
    if (typeof v === 'number') n++; else if (v !== null && v !== undefined && v !== '') other++;
  }
  return n > 0 && n >= other;
}

function totalRow(ctx, p) {
  const L = locate(ctx, p, 'table.totalRow');
  requireSchema2(ctx, L.si);
  const on = typeof p.on === 'boolean' ? p.on : !L.t.totalsRow;
  if (on === !!L.t.totalsRow) return {on};
  const range = L.range;
  const cols = L.t.columns ?? [];
  if (on) {
    const row = range.end.row + 1;
    if (row >= MAX_ROWS) throw failed("There's no room below the table for the total row.");
    if (rowHolds(L.sheet, row, range.start.col, range.end.col)) {
      ctx.run('home.insertCells', {range: `${a1(row, range.start.col)}:${a1(row, range.end.col)}`, sheet: L.si, shift: 'down'});
    }
    const t0 = tableAt(ctx, L.si, L.ti);
    const columns = (t0.columns ?? []).map(c => ({...c}));
    const hasFn = columns.some(c => c.totalsRowFunction);
    if (!hasFn && columns.length) {
      const last = columns.length - 1;
      if (columns.length > 1) { columns[0].totalsRowLabel = columns[0].totalsRowLabel ?? 'Total'; }
      columns[last].totalsRowFunction = numericColumn(L.content, L.si, t0, last) ? 'sum' : 'count';
    }
    const t = {...t0, totalsRow: true, range: rangeA1({start: range.start, end: {row, col: range.end.col}}), columns};
    saveTable(ctx, L.si, L.ti, t);
    writeTotals(ctx, L.content, L.si, t);
  } else {
    const row = range.end.row;
    for (let c = range.start.col; c <= range.end.col; c++) writeCell(ctx.change, L.content, L.si, row, c, {s: cellAt(L.sheet, row, c)?.s});
    saveTable(ctx, L.si, L.ti, {...L.t, totalsRow: false, range: rangeA1({start: range.start, end: {row: row - 1, col: range.end.col}})});
  }
  return {on};
}

/** Banded Rows, Banded Columns, First Column, Last Column. */
const styleFlag = key => (ctx, p) => {
  const L = locate(ctx, p, 'table style option');
  const st = styleOf(L.t);
  const on = typeof p.on === 'boolean' ? p.on : !st[key];
  saveTable(ctx, L.si, L.ti, {...L.t, style: {...st, [key]: on}});
  return {on};
};

function headerRow(ctx, p) {
  const L = locate(ctx, p, 'table.headerRow');
  requireSchema2(ctx, L.si);
  const had = L.t.headerRow !== false;
  const on = typeof p.on === 'boolean' ? p.on : !had;
  if (on === had) return {on};
  const range = L.range;
  const cols = L.t.columns ?? [];
  if (!on) {
    if (range.end.row <= range.start.row) throw failed('A table needs a row of data besides its header.');
    for (let c = range.start.col; c <= range.end.col; c++) writeCell(ctx.change, L.content, L.si, range.start.row, c, {s: cellAt(L.sheet, range.start.row, c)?.s});
    saveTable(ctx, L.si, L.ti, {...L.t, headerRow: false, range: rangeA1({start: {row: range.start.row + 1, col: range.start.col}, end: range.end})});
    return {on};
  }
  // On: the names go in the row above the data, which is made when that row holds something (or is the sheet's first).
  let row = range.start.row - 1;
  if (row < 0 || rowHolds(L.sheet, row, range.start.col, range.end.col)) {
    ctx.run('home.insertCells', {range: `${a1(range.start.row, range.start.col)}:${a1(range.start.row, range.end.col)}`, sheet: L.si, shift: 'down'});
    // Insert Cells moved the table down with the data: the new row sits where its first row was.
    const t1 = tableAt(ctx, L.si, L.ti);
    const r1 = parseRange(t1.range);
    row = r1.start.row - 1;
    const sheet1 = ctx.change.get(['sheets', L.si]) ?? L.sheet;
    (t1.columns ?? []).forEach((c, i) => writeCell(ctx.change, L.content, L.si, row, r1.start.col + i, {...(cellAt(sheet1, row, r1.start.col + i) ?? {}), v: c.name}));
    saveTable(ctx, L.si, L.ti, {...t1, headerRow: true, range: rangeA1({start: {row, col: r1.start.col}, end: r1.end})});
    return {on};
  }
  cols.forEach((c, i) => writeCell(ctx.change, L.content, L.si, row, range.start.col + i, {...(cellAt(L.sheet, row, range.start.col + i) ?? {}), v: c.name}));
  saveTable(ctx, L.si, L.ti, {...L.t, headerRow: true, range: rangeA1({start: {row, col: range.start.col}, end: range.end})});
  return {on};
}

// ---------------------------------------------------------------- Table Styles

function tableStyle(ctx, p) {
  const L = locate(ctx, p, 'table.style');
  const name = typeof p.style === 'string' && p.style ? p.style : 'TableStyleMedium2';
  const known = name === 'None' || gallery().includes(name);
  if (!known) throw bad('table.style', `unknown style \`${name}\``);
  saveTable(ctx, L.si, L.ti, {...L.t, style: {...styleOf(L.t), name: name === 'None' ? null : name}});
  return {style: name};
}

/** The Table Styles gallery: the 21 Light, 28 Medium and 11 Dark styles, each drawn with its header, band and line colours. */
function styleTiles(ctx) {
  const t = tableAtActive(ctx);
  const current = t ? styleInfo(t).name : '';
  const theme = ctx.doc?.theme ?? DEFAULT_THEME;
  const hexOf = c => (c ? hex(resolveColor(c, theme)) : null);
  return gallery().map(name => {
    const lk = tableLook(name);
    const fam = /Light/.test(name) ? 'Light' : /Medium/.test(name) ? 'Medium' : 'Dark';
    return {id: name, label: name.replace(/^TableStyle/, '').replace(/(\D)(\d)/, '$1 $2'), value: name, group: fam, selected: name === current, iconOnly: true,
      art: {kind: 'table', header: hexOf(lk.headerFill), band: hexOf(lk.bandFill), body: hexOf(lk.bodyFill), line: hexOf(lk.line), text: lk.headerFont ? '#FFFFFF' : '#222222'}};
  });
}

// ---------------------------------------------------------------- Total Row functions

function totalFunction(ctx, p) {
  const L = locate(ctx, p, 'table.totalFunction');
  requireSchema2(ctx, L.si);
  if (!L.t.totalsRow) throw failed('Turn the Total Row on first.');
  const cols = (L.t.columns ?? []).map(c => ({...c}));
  const wanted = p.column;
  const i = typeof wanted === 'number' ? wanted : cols.findIndex(c => String(c.name).toLowerCase() === String(wanted ?? '').toLowerCase());
  if (!(i >= 0 && i < cols.length)) throw bad('table.totalFunction', 'missing `column`: name a column of the table');
  const fn = p.function ?? 'sum';
  if (fn === 'none') { delete cols[i].totalsRowFunction; delete cols[i].totalsRowFormula; } else { cols[i].totalsRowFunction = fn; if (fn !== 'custom') delete cols[i].totalsRowFormula; }
  if (fn !== 'none') delete cols[i].totalsRowLabel;
  const t = {...L.t, columns: cols};
  saveTable(ctx, L.si, L.ti, t);
  writeTotals(ctx, L.content, L.si, t);
  return {column: cols[i].name, function: fn};
}

// ---------------------------------------------------------------- Remove Duplicates

function removeDuplicates(ctx, p) {
  const L = locate(ctx, p, 'table.removeDuplicates');
  const info = tableRanges(L.t);
  if (!info.data) return {removed: 0, remaining: 0};
  const range = {start: {row: info.range.start.row, col: info.range.start.col}, end: {row: info.data.end.row, col: info.range.end.col}};
  const params = {range: `${a1(range.start.row, range.start.col)}:${a1(range.end.row, range.end.col)}`, sheet: L.si, header: info.headerRow};
  if (Array.isArray(p.columns)) params.columns = p.columns;
  return ctx.run('data.removeDuplicates', params);
}

export default defineCommands({
  family: 'table',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'table.rename', label: 'Table Name', risk: 'edit', description: 'Rename a table (`table`, default the one at the selection) to `name`; structured references, slicers and PivotTables that use it follow.',
      params: s.object({table: TABLE, name: s.string({min: 1, max: 255})}), state: inTable(t => ({value: t.name})), run: renameTable},
    {id: 'table.resize', label: 'Resize Table', risk: 'edit', dialog: 'dialog.tableResize', description: 'Resize a table to `range` (A1:F20): the header row stays in its row and the new range must overlap the old one.',
      params: s.object({table: TABLE, range: s.string({min: 1, max: 4096})}), state: inTable(() => ({})), run: resizeTable},
    {id: 'table.convertToRange', label: 'Convert to Range', risk: 'edit', description: 'Turn a table into a plain range: the table look stays as formatting and structured references become cell references.',
      params: s.object({table: TABLE}), state: inTable(() => ({})), run: convertToRange},
    {id: 'table.removeDuplicates', label: 'Remove Duplicates', risk: 'edit', description: 'Remove the duplicate rows of a table (`columns`: the ones that decide, default all).',
      params: s.object({table: TABLE, columns: s.optional(s.array(s.union([s.string({min: 1, max: 4}), s.integer({min: 0})]), {max: 16_384}))}), state: inTable(() => ({})), run: removeDuplicates},
    {id: 'table.headerRow', label: 'Header Row', risk: 'edit', description: 'Show or hide the header row of a table (`on`). Hiding it clears the header cells; the column names are kept and come back when it is shown again.',
      params: s.object({table: TABLE, on: ON}), state: inTable(t => ({checked: t.headerRow !== false})), run: headerRow},
    {id: 'table.totalRow', label: 'Total Row', risk: 'edit', description: 'Show or hide the total row below a table (`on`): "Total" in the first column and a SUBTOTAL in the last.',
      params: s.object({table: TABLE, on: ON}), state: inTable(t => ({checked: !!t.totalsRow})), run: totalRow},
    {id: 'table.bandedRows', label: 'Banded Rows', risk: 'edit', description: 'Show or hide the row stripes of a table style (`on`).',
      params: s.object({table: TABLE, on: ON}), state: inTable(t => ({checked: styleInfo(t).showRowStripes})), run: styleFlag('showRowStripes')},
    {id: 'table.bandedColumns', label: 'Banded Columns', risk: 'edit', description: 'Show or hide the column stripes of a table style (`on`).',
      params: s.object({table: TABLE, on: ON}), state: inTable(t => ({checked: styleInfo(t).showColumnStripes})), run: styleFlag('showColumnStripes')},
    {id: 'table.firstColumn', label: 'First Column', risk: 'edit', description: 'Emphasize the first column of a table (`on`).',
      params: s.object({table: TABLE, on: ON}), state: inTable(t => ({checked: styleInfo(t).showFirstColumn})), run: styleFlag('showFirstColumn')},
    {id: 'table.lastColumn', label: 'Last Column', risk: 'edit', description: 'Emphasize the last column of a table (`on`).',
      params: s.object({table: TABLE, on: ON}), state: inTable(t => ({checked: styleInfo(t).showLastColumn})), run: styleFlag('showLastColumn')},
    {id: 'table.style', label: 'Table Styles', risk: 'edit', description: 'Apply a table style (TableStyleLight1 to 21, Medium1 to 28, Dark1 to 11, or "None" to clear it).',
      params: s.object({table: TABLE, style: s.string({min: 1, max: 64})}),
      state: (ctx, p) => { const st = inTable(() => ({}))(ctx, p); return st.enabled ? {...st, value: styleTiles(ctx)} : st; }, run: tableStyle},
    {id: 'table.totalFunction', label: 'Total Row function', risk: 'edit', description: 'Choose what the total row shows under a column: none, average, count, countNums, max, min, stdDev, sum or var.',
      params: s.object({table: TABLE, column: s.union([s.string({min: 1, max: 255}), s.integer({min: 0})]), function: s.optional(s.enum(TOTAL_FUNCTIONS))}), state: inTable(() => ({})), run: totalFunction},
  ],
});
