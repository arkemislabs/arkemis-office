// Grid document addresses (docs/architecture.md 14.1, 14.3, 14.7; F:grid).
//
//   /                                   workbook
//   /sh:<sheetId>                       sheet
//   /sh:<id>/B7  /sh:<id>/A1:C9  /sh:<id>/A1:B2,D4      cell, range, multi-area
//   /sh:<id>/row:5  /rows:5-9  /col:C  /cols:C-F         whole rows / columns
//   /sh:<id>/B2/t:0-4                   a run of a cell's text (UTF-16 code units)
//   /tbl:<name>  /tbl:<name>/col:<columnName>            table, table column
//   /name:<definedName>                 defined name
//   /sh:<id>/chart:<id> /shape:<id> /pic:<id>             drawing objects
//   /sh:<id>/note:B7 /cf:<ruleId> /dv:<ruleId>            note, conditional format, validation
//   /pivot:<id>  /slicer:<id>
// Friendly inputs: `Sheet1!B2:C9`, `'My sheet'!A1`, `B2` (active sheet), `B:D`, `3:5`, a defined
// name or a table name. `canonical` turns them into the canonical form; reads return both forms
// ({address, a1}). Cell addresses use A1 because spreadsheet semantics define them: inserting a
// row moves B7 to B8 (mapThrough follows the `grid.structure` op exactly as gridcraft adjusts
// references). Sheets use stable ids.
//
// Ranges follow gridcraft crates/core/src/addr.rs (lib/addr.mjs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. No DOM, no Node built-ins.

import {CommandError} from '../kernel/errors.mjs';
import {parseTextRange, genericResolver} from '../kernel/address.mjs';
import {MAX_ROWS, MAX_COLS, a1, colToLetters, lettersToCol, parseRange, rangeA1, quoteSheet, unquoteSheet, rangeOf, isFullCols, isFullRows, intersects} from './lib/addr.mjs';
import {cellAt, rawCellAt, forEachCell, usedBounds, blockOf, blockEntries, isLegacySheet, parseKey} from './model/store.mjs';
import {styleAt, sheetView, activeSheetIndex} from './model/workbook.mjs';
import {sheetIndex, colWidth, rowHeight, isRowHidden, isColHidden, merges, freeze, tableRanges} from './model/sheet.mjs';
import {mapLine, mapRange} from './model/structure.mjs';
import {engineFor} from './model/calc.mjs';
import {displayAt} from './model/index.mjs';
import {toJSONValue, GArray} from './lib/value.mjs';

const MAX_READ_CELLS = 250_000;
const invalid = (message, input) => new CommandError('invalid_address', message, input === undefined ? undefined : {address: input});
const notFound = (message, address) => new CommandError('not_found', message, address ? {address} : undefined);
const enc = s => String(s).replace(/[%/]/g, c => encodeURIComponent(c));
const dec = s => { try { return decodeURIComponent(s); } catch { throw invalid(`Bad escape in ${s}`); } };

// ---------------------------------------------------------------------------------------------
// Parsing

function lettersOrThrow(t, input) {
  const c = lettersToCol(t.replace(/\$/g, ''));
  if (c === null) throw invalid(`${t} is not a column`, input);
  return c;
}
function rowOrThrow(t, input) {
  const n = Number(t.replace(/\$/g, ''));
  if (!/^\$?\d{1,7}$/.test(t) || n < 1 || n > MAX_ROWS) throw invalid(`${t} is not a row`, input);
  return n - 1;
}

/** `A1:B2,D4` (or `B:D`, `3:5`) → areas. */
function parseAreas(body, input) {
  const areas = body.split(',').map(part => {
    const r = parseRange(part.trim().replace(/\$/g, ''));
    if (!r) throw invalid(`${part} is not a cell or range`, input);
    return r;
  });
  if (!areas.length) throw invalid('An address names at least one cell', input);
  return areas;
}

/** Sheet-relative tail after `/sh:<id>` or `Sheet!`. */
function parseTail(segs, input, sheet) {
  if (!segs.length) return {kind: 'sheet', sheet};
  const [head, ...rest] = segs;
  const i = head.indexOf(':');
  const k = i < 0 ? head : head.slice(0, i), key = i < 0 ? undefined : dec(head.slice(i + 1));
  const lower = k.toLowerCase();
  const done = ast => { if (rest.length) throw invalid(`Nothing is addressed below ${head}`, input); return ast; };
  if ((lower === 'row' || lower === 'rows') && key !== undefined) {
    const [a, b = a] = key.split('-');
    const r0 = rowOrThrow(a, input), r1 = rowOrThrow(b, input);
    return done({kind: 'rows', sheet, lines: [Math.min(r0, r1), Math.max(r0, r1)]});
  }
  if ((lower === 'col' || lower === 'cols') && key !== undefined) {
    const [a, b = a] = key.split('-');
    const c0 = lettersOrThrow(a, input), c1 = lettersOrThrow(b, input);
    return done({kind: 'cols', sheet, lines: [Math.min(c0, c1), Math.max(c0, c1)]});
  }
  if (['chart', 'shape', 'pic'].includes(lower) && key) return done({kind: 'object', sheet, objType: lower, id: key});
  if (lower === 'note' && key) {
    const r = parseRange(key);
    if (!r || r.start.row !== r.end.row || r.start.col !== r.end.col) throw invalid(`${key} is not a cell`, input);
    return done({kind: 'note', sheet, cell: r.start});
  }
  if ((lower === 'cf' || lower === 'dv') && key) return done({kind: lower, sheet, id: key});
  // Cells: the segment itself is A1 text (no kind:key).
  const areas = parseAreas(dec(head), input);
  if (!rest.length) {
    // `B:D` and `3:5` are whole columns and rows: their canonical forms are cols:/rows:.
    if (areas.length === 1 && isFullCols(areas[0]) && !isFullRows(areas[0])) return {kind: 'cols', sheet, lines: [areas[0].start.col, areas[0].end.col]};
    if (areas.length === 1 && isFullRows(areas[0]) && !isFullCols(areas[0])) return {kind: 'rows', sheet, lines: [areas[0].start.row, areas[0].end.row]};
    return {kind: 'cells', sheet, areas};
  }
  const t = rest[0];
  if (rest.length === 1 && t.startsWith('t:')) {
    if (areas.length !== 1 || areas[0].start.row !== areas[0].end.row || areas[0].start.col !== areas[0].end.col) throw invalid('A text range is inside one cell', input);
    return {kind: 'text', sheet, cell: areas[0].start, text: parseTextRange(t.slice(2))};
  }
  throw invalid(`Nothing is addressed below ${head}`, input);
}

/** Parse an address (canonical or friendly). Throws invalid_address. */
export function parse(input) {
  if (typeof input !== 'string' || !input.trim()) throw invalid('An address is a non-empty string', input);
  if (input.length > 4096) throw invalid('An address has at most 4096 characters', input);
  const s = input.trim();
  if (s === '/') return {kind: 'root'};
  if (s.startsWith('/')) {
    const segs = s.slice(1).split('/');
    if (segs.some(x => !x)) throw invalid('An address has an empty segment', input);
    const [head, ...rest] = segs;
    const i = head.indexOf(':');
    const kind = i < 0 ? head : head.slice(0, i), key = i < 0 ? undefined : dec(head.slice(i + 1));
    switch (kind) {
      case 'sh': if (!key) throw invalid('/sh: needs a sheet id', input); return parseTail(rest, input, {id: key});
      case 'tbl':
        if (!key) throw invalid('/tbl: needs a table name', input);
        if (!rest.length) return {kind: 'table', table: key};
        if (rest.length === 1 && rest[0].startsWith('col:')) return {kind: 'tableColumn', table: key, column: dec(rest[0].slice(4))};
        throw invalid('Below a table only /col:<column name> is addressed', input);
      case 'name': if (!key || rest.length) throw invalid('/name:<definedName>', input); return {kind: 'name', name: key};
      case 'pivot': case 'slicer': if (!key || rest.length) throw invalid(`/${kind}:<id>`, input); return {kind, id: key};
      // Raw content paths (`/sheets/0/cells/A1`): the kernel's generic JSON addressing, kept for
      // command families written before this resolver (they read schema-1 documents that way).
      case 'sheets': case 'styles': case 'names': case 'activeSheetId': case 'dateSystem': case 'calc': case 'namedRanges':
        if (key === undefined) return {kind: 'json', generic: genericResolver.parse(s)};
        throw invalid(`Unknown address kind ${kind}`, input);
      default: throw invalid(`Unknown address kind ${kind}`, input);
    }
  }
  // Friendly: Sheet!A1, 'My sheet'!A1:B2, A1, B:D, 3:5, a name or table.
  const bang = s.lastIndexOf('!');
  if (bang > 0) {
    const name = unquoteSheet(s.slice(0, bang)), body = s.slice(bang + 1);
    const [cells, ...more] = body.split('/');
    return parseTail([enc(cells), ...more], input, {name});
  }
  const [first, ...more] = s.split('/');
  try { return parseTail([enc(first), ...more], input, null); } catch (e) {
    if (!more.length && /^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u.test(s)) return {kind: 'friendlyName', name: s};
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting

const lineKey = (axis, [lo, hi]) => {
  const t = n => (axis === 'rows' ? String(n + 1) : colToLetters(n));
  return lo === hi ? `${axis === 'rows' ? 'row' : 'col'}:${t(lo)}` : `${axis}:${t(lo)}-${t(hi)}`;
};
const areasText = areas => areas.map(rangeA1).join(',');

/** Canonical (or, for unresolved friendly sheets, friendly) text of an AST. */
export function format(ast) {
  if (!ast || typeof ast !== 'object') throw invalid('Not an address');
  const sheetPrefix = () => (ast.sheet?.id !== undefined ? `/sh:${enc(ast.sheet.id)}` : ast.sheet?.name !== undefined ? `${quoteSheet(ast.sheet.name)}!` : '');
  const join = tail => (ast.sheet?.id !== undefined ? `${sheetPrefix()}/${tail}` : `${sheetPrefix()}${tail}`);
  switch (ast.kind) {
    case 'root': return '/';
    case 'sheet': return ast.sheet?.id !== undefined ? sheetPrefix() : `${quoteSheet(ast.sheet?.name ?? '')}!A1`;
    case 'cells': return join(areasText(ast.areas));
    case 'rows': case 'cols': return join(lineKey(ast.kind, ast.lines));
    case 'text': return join(`${a1(ast.cell.row, ast.cell.col)}/t:${ast.text.from}${ast.text.to !== ast.text.from ? `-${ast.text.to}` : ''}`);
    case 'object': return join(`${ast.objType}:${enc(ast.id)}`);
    case 'note': return join(`note:${a1(ast.cell.row, ast.cell.col)}`);
    case 'cf': case 'dv': return join(`${ast.kind}:${enc(ast.id)}`);
    case 'table': return `/tbl:${enc(ast.table)}`;
    case 'tableColumn': return `/tbl:${enc(ast.table)}/col:${enc(ast.column)}`;
    case 'name': return `/name:${enc(ast.name)}`;
    case 'pivot': case 'slicer': return `/${ast.kind}:${enc(ast.id)}`;
    case 'friendlyName': return ast.name;
    case 'json': return genericResolver.format(ast.generic);
    default: throw invalid(`Unknown address kind ${ast.kind}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Resolving

function sheetOf(content, ast, input) {
  if (!ast.sheet) return activeSheetIndex(content);
  const si = ast.sheet.id !== undefined ? (content.sheets ?? []).findIndex(s => s.id === ast.sheet.id) : sheetIndex(content, ast.sheet.name);
  if (si < 0) throw notFound(`No sheet ${ast.sheet.id ?? ast.sheet.name}`, input);
  return si;
}

const findTable = (content, name) => {
  const l = String(name).toLowerCase();
  for (let si = 0; si < (content.sheets ?? []).length; si++) {
    const t = (content.sheets[si].tables ?? []).find(x => x.name.toLowerCase() === l);
    if (t) return {si, table: t};
  }
  return null;
};
const findName = (content, name, si) => {
  const l = String(name).toLowerCase(), list = content.names ?? (content.namedRanges ?? []).map(n => ({name: n.name, formula: n.reference, scope: n.sheetId}));
  const sid = content.sheets?.[si]?.id;
  return list.find(n => n.scope && n.scope === sid && n.name.toLowerCase() === l) ?? list.find(n => !n.scope && n.name.toLowerCase() === l) ?? null;
};

/** Canonical AST: sheet by id, friendly names resolved. */
function canonicalAst(content, ast, input) {
  if (ast.kind === 'friendlyName') {
    const t = findTable(content, ast.name);
    if (t) return {kind: 'table', table: t.table.name};
    const n = findName(content, ast.name, activeSheetIndex(content));
    if (n) return {kind: 'name', name: n.name};
    throw notFound(`Nothing named ${ast.name}`, input);
  }
  if (['root', 'table', 'tableColumn', 'name', 'pivot', 'slicer', 'json'].includes(ast.kind)) return ast;
  const si = sheetOf(content, ast, input);
  return {...ast, sheet: {id: content.sheets[si].id}};
}

const a1Text = (content, si, ast) => {
  const q = quoteSheet(content.sheets[si].name);
  switch (ast.kind) {
    case 'sheet': return `${q}!A1`;
    case 'cells': return ast.areas.map(r => `${q}!${rangeA1(r)}`).join(',');
    case 'rows': return `${q}!${ast.lines[0] + 1}:${ast.lines[1] + 1}`;
    case 'cols': return `${q}!${colToLetters(ast.lines[0])}:${colToLetters(ast.lines[1])}`;
    case 'text': case 'note': return `${q}!${a1(ast.cell.row, ast.cell.col)}`;
    default: return `${q}`;
  }
};

/** Resolve to {kind, sheet, address, a1, node, areas?}. Throws not_found / invalid_address. */
export function resolve(content, ast0) {
  const input = typeof ast0 === 'string' ? ast0 : undefined;
  const ast = canonicalAst(content, typeof ast0 === 'string' ? parse(ast0) : ast0, input);
  const address = format(ast);
  switch (ast.kind) {
    case 'root': return {kind: 'workbook', address, node: content};
    case 'json': return {...genericResolver.resolve(content, ast.generic), address};
    case 'table': {
      const t = findTable(content, ast.table);
      if (!t) throw notFound(`No table ${ast.table}`, address);
      const g = tableRanges(t.table);
      return {kind: 'table', address, sheet: t.si, a1: `${quoteSheet(content.sheets[t.si].name)}!${rangeA1(g.range)}`, node: t.table, areas: [g.range]};
    }
    case 'tableColumn': {
      const t = findTable(content, ast.table);
      if (!t) throw notFound(`No table ${ast.table}`, address);
      const cols = (t.table.columns ?? []).map(c => (typeof c === 'string' ? c : c.name));
      const ci = cols.findIndex(c => c.toLowerCase() === ast.column.toLowerCase());
      if (ci < 0) throw notFound(`Table ${t.table.name} has no column ${ast.column}`, address);
      const g = tableRanges(t.table);
      const col = g.range.start.col + ci;
      const r = rangeOf(g.range.start.row, col, g.range.end.row, col);
      return {kind: 'tableColumn', address, sheet: t.si, a1: `${quoteSheet(content.sheets[t.si].name)}!${rangeA1(r)}`, node: t.table.columns[ci], areas: [r]};
    }
    case 'name': {
      const n = findName(content, ast.name, activeSheetIndex(content));
      if (!n) throw notFound(`No defined name ${ast.name}`, address);
      return {kind: 'name', address, node: n};
    }
    case 'pivot': case 'slicer': {
      for (let si = 0; si < content.sheets.length; si++) {
        const list = content.sheets[si][ast.kind === 'pivot' ? 'pivots' : 'slicers'] ?? [];
        const node = list.find(x => String(x.id) === ast.id);
        if (node) return {kind: ast.kind, address, sheet: si, node};
      }
      throw notFound(`No ${ast.kind} ${ast.id}`, address);
    }
    default: break;
  }
  const si = sheetOf(content, ast, address);
  const sheet = content.sheets[si];
  const base = {address, sheet: si, a1: a1Text(content, si, ast)};
  switch (ast.kind) {
    case 'sheet': return {...base, kind: 'sheet', node: sheet};
    case 'cells': return {...base, kind: ast.areas.length === 1 && ast.areas[0].start.row === ast.areas[0].end.row && ast.areas[0].start.col === ast.areas[0].end.col ? 'cell' : 'range',
      areas: ast.areas, node: ast.areas.length === 1 ? cellAt(sheet, ast.areas[0].start.row, ast.areas[0].start.col) : null};
    case 'rows': return {...base, kind: 'rows', areas: [rangeOf(ast.lines[0], 0, ast.lines[1], MAX_COLS - 1)], node: null};
    case 'cols': return {...base, kind: 'cols', areas: [rangeOf(0, ast.lines[0], MAX_ROWS - 1, ast.lines[1])], node: null};
    case 'text': {
      const text = displayAt(content, si, ast.cell.row, ast.cell.col).text;
      if (ast.text.to > text.length) throw notFound(`The cell's text has ${text.length} characters`, address);
      return {...base, kind: 'text', node: text.slice(ast.text.from, ast.text.to), areas: [rangeOf(ast.cell.row, ast.cell.col, ast.cell.row, ast.cell.col)]};
    }
    case 'note': {
      const key = a1(ast.cell.row, ast.cell.col);
      const node = sheet.notes?.[key] ?? sheet.comments?.[key] ?? null;
      if (!node) throw notFound(`No note on ${key}`, address);
      return {...base, kind: 'note', node};
    }
    case 'object': {
      const list = sheet[{chart: 'charts', shape: 'shapes', pic: 'images'}[ast.objType]] ?? [];
      const node = list.find(x => String(x.id) === ast.id);
      if (!node) throw notFound(`No ${ast.objType} ${ast.id}`, address);
      return {...base, kind: ast.objType, node};
    }
    case 'cf': case 'dv': {
      const list = sheet[ast.kind === 'cf' ? 'conditionalFormats' : 'validations'] ?? [];
      const node = list.find(x => String(x.id) === ast.id);
      if (!node) throw notFound(`No ${ast.kind === 'cf' ? 'conditional format' : 'validation rule'} ${ast.id}`, address);
      return {...base, kind: ast.kind, node};
    }
    default: throw invalid(`Unknown address kind ${ast.kind}`);
  }
}

/** Friendly → canonical text. */
export function canonical(content, input) {
  return format(canonicalAst(content, typeof input === 'string' ? parse(input) : input, typeof input === 'string' ? input : undefined));
}

// ---------------------------------------------------------------------------------------------
// Mapping through changes

/**
 * Maps an AST through a content op. Only structural edits (`grid.structure` app ops) move cells;
 * removing a sheet deletes the addresses on it.
 */
export function mapThrough(op, ast) {
  if (ast?.kind === 'json') {
    const next = genericResolver.mapThrough(op, ast.generic);
    if (next?.deleted) return {deleted: true, nearest: next.nearest ? {kind: 'json', generic: next.nearest} : undefined};
    return next === ast.generic ? ast : {kind: 'json', generic: next};
  }
  if (!op || !ast || !ast.sheet || ast.sheet.id === undefined) return ast;
  // An undone structural edit runs `grid.replace` forward with the edit as its inverse: map
  // through the opposite edit (an undone insert removes the lines it added).
  const undone = op.op === 'app' && op.forward?.op === 'grid.replace' && op.inverse?.op === 'grid.structure' ? op.inverse : null;
  const structural = op.op === 'app' && op.forward?.op === 'grid.structure' ? op.forward : undone
    ? {...undone, edit: {...undone.edit, type: undone.edit.type === 'insert' ? 'delete' : 'insert'}} : null;
  if (structural && structural.sheet === ast.sheet.id) {
    const edit = structural.edit;
    const nearest = {kind: 'sheet', sheet: ast.sheet};
    switch (ast.kind) {
      case 'cells': {
        const areas = ast.areas.map(r => mapRange(edit, r)).filter(Boolean);
        return areas.length ? {...ast, areas} : {deleted: true, nearest};
      }
      case 'rows': case 'cols': {
        if (edit.axis !== ast.kind) return ast;
        const r = mapRange(edit, ast.kind === 'rows' ? rangeOf(ast.lines[0], 0, ast.lines[1], 0) : rangeOf(0, ast.lines[0], 0, ast.lines[1]));
        if (!r) return {deleted: true, nearest};
        return {...ast, lines: ast.kind === 'rows' ? [r.start.row, r.end.row] : [r.start.col, r.end.col]};
      }
      case 'text': case 'note': {
        const row = mapLine(edit, 'rows', ast.cell.row), col = mapLine(edit, 'cols', ast.cell.col);
        return row === null || col === null ? {deleted: true, nearest} : {...ast, cell: {row, col}};
      }
      default: return ast;
    }
  }
  if (op.op === 'splice' && op.path.length === 1 && op.path[0] === 'sheets' && (op.removed ?? []).some(s => s?.id === ast.sheet.id)
    && !(op.items ?? []).some(s => s?.id === ast.sheet.id)) {
    return {deleted: true, nearest: {kind: 'root'}};
  }
  if (!structural && op.op === 'app' && op.forward?.op === 'grid.replace' && Array.isArray(op.forward.sheets) && !op.forward.sheets.some(s => s.id === ast.sheet.id)) {
    return {deleted: true, nearest: {kind: 'root'}};
  }
  return ast;
}

/** Addresses a list of committed content ops changed (doc.changed events). */
export function changed(ops, content) {
  const out = new Set();
  const sheetId = i => content.sheets?.[i]?.id;
  const cellsOf = obj => (obj && typeof obj === 'object' ? Object.keys(obj).filter(k => parseKey(k)) : []);
  for (const op of ops) {
    const p = op.path;
    if (op.op === 'app') {
      const f = op.forward;
      out.add(f?.op === 'grid.structure' ? `/sh:${enc(f.sheet)}` : '/');
      continue;
    }
    if (p[0] !== 'sheets' || p.length < 2) { out.add('/'); continue; }
    const id = sheetId(p[1]);
    if (id === undefined) { out.add('/'); continue; }
    const base = `/sh:${enc(id)}`;
    if ((p[2] === 'blocks' && p.length === 5) || (p[2] === 'cells' && p.length >= 4)) { out.add(`${base}/${p[p[2] === 'blocks' ? 4 : 3]}`); continue; }
    if (p[2] === 'blocks' && p.length === 4) {
      for (const k of new Set([...cellsOf(op.value), ...cellsOf(op.old)])) out.add(`${base}/${k}`);
      continue;
    }
    if ((p[2] === 'rows' || p[2] === 'cols') && p.length >= 4) {
      const n = Number(p[3]);
      out.add(`${base}/${p[2] === 'rows' ? `row:${n + 1}` : `col:${colToLetters(n)}`}`);
      continue;
    }
    out.add(base);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// Reading

function boundedAreas(sheet, areas) {
  const used = usedBounds(sheet);
  return areas.map(r => {
    if (!(isFullCols(r) || isFullRows(r))) return r;
    if (!used) return null;
    const x = rangeOf(Math.max(r.start.row, isFullCols(r) ? 0 : r.start.row), r.start.col, isFullCols(r) ? Math.min(r.end.row, used.r1) : r.end.row,
      isFullRows(r) ? Math.min(r.end.col, used.c1) : r.end.col);
    return x.end.row < x.start.row || x.end.col < x.start.col ? null : x;
  }).filter(Boolean);
}

function grid(content, si, area, cellFn) {
  const rows = [];
  for (let r = area.start.row; r <= area.end.row; r++) {
    const row = [];
    for (let c = area.start.col; c <= area.end.col; c++) row.push(cellFn(r, c));
    rows.push(row);
  }
  return rows;
}

const jsonValue = v => (v instanceof GArray ? toJSONValue(v.data[0] ?? null) : toJSONValue(v));

/** Flat props of a cell's style (format units read `.bold`, `.fontName`...), plus the full style. */
export function cellProps(content, si, row, col) {
  const sheet = content.sheets[si];
  const st = styleAt(content, sheet, row, col);
  const c = cellAt(sheet, row, col);
  return {
    bold: st.font.bold, italic: st.font.italic, underline: st.font.underline ?? 'none', strike: st.font.strike,
    fontName: st.font.name, fontSize: st.font.size, fontColor: st.font.color ?? null, vertAlign: st.font.vert ?? null,
    fill: st.fill.pattern && st.fill.pattern !== 'none' ? st.fill.fg ?? null : null, numFmt: st.numFmt,
    hAlign: st.align.h, vAlign: st.align.v, wrap: st.align.wrap, indent: st.align.indent, rotation: st.align.rotation, shrink: st.align.shrink,
    borders: st.borders, locked: st.protection.locked, hidden: st.protection.hidden,
    style: st, styleId: c?.s ?? 0,
    width: colWidth(sheet, col), height: rowHeight(sheet, row),
    merged: merges(sheet).find(m => m.start.row <= row && row <= m.end.row && m.start.col <= col && col <= m.end.col) ? true : false,
  };
}

/** read(content, ast, as) per 14.7. */
export function read(content, ast0, as = 'json') {
  const ast1 = typeof ast0 === 'string' ? parse(ast0) : ast0;
  if (ast1?.kind === 'json') return genericResolver.read(content, ast1.generic, as);
  const res = resolve(content, ast0);
  const si = res.sheet;
  switch (res.kind) {
    case 'workbook': {
      if (as !== 'json' && as !== 'props') throw invalid(`A workbook reads as json`);
      return {
        sheets: content.sheets.map((s, i) => {
          const u = usedBounds(s);
          return {address: `/sh:${enc(s.id)}`, a1: `${quoteSheet(s.name)}!A1`, id: s.id, name: s.name, active: i === activeSheetIndex(content),
            hidden: s.hidden ?? false, used: u ? rangeA1(rangeOf(u.r0, u.c0, u.r1, u.c1)) : null};
        }),
        names: (content.names ?? []).map(n => ({address: `/name:${enc(n.name)}`, ...n})),
        tables: content.sheets.flatMap(s => (s.tables ?? []).map(t => ({address: `/tbl:${enc(t.name)}`, a1: `${quoteSheet(s.name)}!${t.range}`, name: t.name}))),
        dateSystem: content.dateSystem === 1904 ? 1904 : 1900,
        calc: content.calc ?? {mode: 'auto'},
      };
    }
    case 'sheet': {
      const s = res.node;
      const u = usedBounds(s);
      if (as === 'json' || as === 'props') {
        const {blocks: _b, cells: _c, ...meta} = s;
        return {address: res.address, a1: res.a1, ...meta, view: sheetView(s), freeze: freeze(s), used: u ? rangeA1(rangeOf(u.r0, u.c0, u.r1, u.c1)) : null};
      }
      if (!u) return [];
      return read(content, {kind: 'cells', sheet: {id: s.id}, areas: [rangeOf(u.r0, u.c0, u.r1, u.c1)]}, as);
    }
    case 'cell': case 'range': case 'rows': case 'cols': case 'tableColumn': {
      const sheet = content.sheets[si];
      if (as === 'props') {
        if (res.kind === 'rows' || res.kind === 'cols') {
          const ast = typeof ast0 === 'string' ? parse(ast0) : ast0;
          const lines = ast.lines ?? [res.areas[0].start.row, res.areas[0].end.row];
          if (lines[1] - lines[0] > 10_000) throw new CommandError('too_large', 'Read at most 10,000 lines at once');
          const out = [];
          for (let i = lines[0]; i <= lines[1]; i++) {
            out.push(res.kind === 'rows' ? {row: i + 1, height: rowHeight(sheet, i), hidden: isRowHidden(sheet, i)}
              : {col: colToLetters(i), width: colWidth(sheet, i), hidden: isColHidden(sheet, i)});
          }
          return out;
        }
        const a = res.areas[0];
        return {address: res.address, a1: res.a1, ...cellProps(content, si, a.start.row, a.start.col)};
      }
      const areas = boundedAreas(sheet, res.areas);
      let total = 0;
      for (const r of areas) total += (r.end.row - r.start.row + 1) * (r.end.col - r.start.col + 1);
      if (total > MAX_READ_CELLS) throw new CommandError('too_large', `That range has ${total} cells; read at most ${MAX_READ_CELLS} at once`);
      const engine = engineFor(content);
      const one = area => {
        switch (as) {
          case 'values': return grid(content, si, area, (r, c) => jsonValue(engine.sheetValue(si, r, c)));
          case 'formulas': return grid(content, si, area, (r, c) => {
            const cell = cellAt(sheet, r, c);
            if (cell?.f !== undefined) return `=${cell.f}`;
            return jsonValue(engine.sheetValue(si, r, c));
          });
          case 'display': case 'text': return grid(content, si, area, (r, c) => displayAt(content, si, r, c, engine.sheetValue(si, r, c)).text);
          case 'runs': return grid(content, si, area, (r, c) => [{text: displayAt(content, si, r, c, engine.sheetValue(si, r, c)).text}]);
          case 'json': {
            const out = {};
            forEachCell(sheet, area.start.row, area.start.col, area.end.row, area.end.col, (r, c) => {
              const raw = rawCellAt(sheet, r, c);
              out[a1(r, c)] = isLegacySheet(sheet) ? raw : {...raw, value: jsonValue(engine.sheetValue(si, r, c))};
            });
            return out;
          }
          default: throw invalid(`Unknown read kind ${as}`);
        }
      };
      if (as === 'text') {
        return areas.map(a => one(a).map(row => row.join('\t')).join('\n')).join('\n\n');
      }
      if (res.kind === 'cell' && (as === 'values' || as === 'formulas' || as === 'display')) return areas.length ? one(areas[0])[0][0] : null;
      const parts = areas.map(one);
      if (as === 'json') return {address: res.address, a1: res.a1, cells: Object.assign({}, ...parts)};
      return res.areas.length === 1 ? parts[0] ?? [] : parts;
    }
    case 'text': {
      if (as === 'text' || as === 'json' || as === 'display') return res.node;
      if (as === 'runs') return [{text: res.node}];
      throw invalid(`A text range reads as text or runs`);
    }
    default:
      return {address: res.address, ...(res.a1 ? {a1: res.a1} : {}), ...structuredClone(res.node)};
  }
}

// ---------------------------------------------------------------------------------------------
// Enumerating

/** Lists children: sheets (and names, tables) of the workbook; stored cells of a sheet or range. */
export function enumerate(content, ast0, {depth = 1, cursor, limit = 100} = {}) {
  if (ast0?.kind === 'json') return genericResolver.enumerate(content, ast0.generic, {depth, limit});
  const res = resolve(content, ast0);
  const start = cursor ? Number(cursor) || 0 : 0;
  const nodes = [];
  if (res.kind === 'workbook') {
    const all = [
      ...content.sheets.map(s => ({address: `/sh:${enc(s.id)}`, a1: `${quoteSheet(s.name)}!A1`, kind: 'sheet', name: s.name})),
      ...(content.names ?? []).map(n => ({address: `/name:${enc(n.name)}`, kind: 'name', name: n.name, formula: n.formula})),
      ...content.sheets.flatMap(s => (s.tables ?? []).map(t => ({address: `/tbl:${enc(t.name)}`, a1: `${quoteSheet(s.name)}!${t.range}`, kind: 'table', name: t.name}))),
    ];
    const page = all.slice(start, start + limit);
    return page.length + start < all.length ? {nodes: page, cursor: String(start + limit)} : {nodes: page};
  }
  if (res.sheet === undefined) return {nodes: []};
  const si = res.sheet, sheet = content.sheets[si];
  const area = res.areas?.[0] ?? (() => { const u = usedBounds(sheet); return u ? rangeOf(u.r0, u.c0, u.r1, u.c1) : null; })();
  if (!area) return {nodes: []};
  const engine = engineFor(content);
  const q = quoteSheet(sheet.name);
  let i = 0, more = false;
  const areas = res.areas ?? [area];
  for (const ar of areas) {
    forEachCell(sheet, ar.start.row, ar.start.col, ar.end.row, ar.end.col, (r, c, cell) => {
      if (i++ < start) return true;
      if (nodes.length >= limit) { more = true; return false; }
      const node = {address: `/sh:${enc(sheet.id)}/${a1(r, c)}`, a1: `${q}!${a1(r, c)}`, kind: 'cell', value: jsonValue(engine.sheetValue(si, r, c))};
      if (cell.f !== undefined) node.formula = `=${cell.f}`;
      if (depth > 1) node.display = displayAt(content, si, r, c).text;
      nodes.push(node);
      return true;
    });
    if (more) break;
  }
  return more ? {nodes, cursor: String(start + nodes.length)} : {nodes};
}

// ---------------------------------------------------------------------------------------------
// Find (document.find)

/** Text search over what cells show (and formulas), in reading order. */
export function find(content, {query, scope, regex = false, matchCase = false, wholeWord = false, limit = 100}) {
  let source = regex ? query : String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b(?:${source})\\b`;
  let re;
  try { re = new RegExp(source, `g${matchCase ? '' : 'i'}u`); } catch (e) { throw new CommandError('invalid_params', `query is not a valid regular expression: ${e.message}`, {path: '/query'}); }
  const res = resolve(content, scope ?? {kind: 'root'});
  const sheets = res.kind === 'workbook' ? content.sheets.map((_, i) => i) : [res.sheet];
  const matches = [];
  const engine = engineFor(content);
  for (const si of sheets) {
    const sheet = content.sheets[si];
    const areas = res.areas ?? [rangeOf(0, 0, MAX_ROWS - 1, MAX_COLS - 1)];
    for (const ar of areas) {
      forEachCell(sheet, ar.start.row, ar.start.col, ar.end.row, ar.end.col, (r, c, cell) => {
        const text = displayAt(content, si, r, c, engine.sheetValue(si, r, c)).text;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) && matches.length < limit) {
          if (!m[0].length) { re.lastIndex++; continue; }
          matches.push({address: `/sh:${enc(sheet.id)}/${a1(r, c)}/t:${m.index}-${m.index + m[0].length}`, cell: `/sh:${enc(sheet.id)}/${a1(r, c)}`,
            a1: `${quoteSheet(sheet.name)}!${a1(r, c)}`, from: m.index, to: m.index + m[0].length, text: m[0], context: text.slice(0, 120),
            ...(cell.f !== undefined ? {formula: `=${cell.f}`} : {})});
        }
        return matches.length < limit;
      });
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
  }
  return {matches, ...(matches.length >= limit ? {truncated: true} : {})};
}

export {intersects, blockOf, blockEntries};
