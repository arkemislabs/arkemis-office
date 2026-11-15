// Insert > Tables > Table: turn a block of cells into a table (header row, filter buttons, banded
// style), as Create Table does.
// Translated from gridcraft crates/engine/src/cmd/insert/table.rs (`insert_table`, `block`) and
// cmd/insert.rs (specs) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// A table is stored on its sheet: {name, range: 'A1:C9', headerRow, totalsRow, columns: [{name}],
// style: {name, showRowStripes, ...}, autoFilter}. Without a header row the data moves down a row to
// make room for one (Insert Cells shifting down), with names Column1, Column2, ...; headers are text.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, rangeA1, colToLetters, intersects, contains, isSingle} from '../../lib/addr.mjs';
import {engineFor} from '../../model/calc.mjs';
import {cellAt, writeCell, usedBounds} from '../../model/store.mjs';
import {hasDoc, gridSel, targetRange, requireSchema2} from '../../lib/edit-targets.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {bad, baseDoc, failed, valueOf, regionAround} from '../../lib/data-common.mjs';
import {display} from '../../lib/value.mjs';
import {tablesOf} from '../../lib/table-style.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/insert.rs', 'crates/engine/src/cmd/insert/table.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

/** Whether `name` may name a table: a letter, underscore or backslash first, then letters, digits, underscores and periods; no cell address, no R1C1 name. */
export function validTableName(name) {
  const n = String(name);
  if (!n || n.length > 255) return false;
  if (!/^[\p{L}_\\][\p{L}\p{N}_.]*$/u.test(n)) return false;
  if (/^[Rr]([0-9]+)?([Cc]([0-9]+)?)?$/.test(n) || /^[Cc][0-9]*$/.test(n)) return false;
  if (/^[A-Za-z]{1,3}[0-9]+$/.test(n)) return false;
  return true;
}

function insertTable(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  let si, r;
  if (typeof p.range === 'string' && p.range) { const t = targetRange(ctx, p); si = t.sheet; r = t.range; }
  else {
    si = sel.sheet;
    const cur = sel.ranges[sel.ranges.length - 1];
    r = !isSingle(cur) ? cur : regionAround(content, si, sel.active);
  }
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const engine = engineFor(content);
  if (tablesOf(sheet).some(t => intersects(t.range, r))) throw failed("A table can't overlap another table.");
  for (const [, b] of Object.entries(sheet.blocks ?? {})) for (const [k, c] of Object.entries(b)) {
    if (c.a === undefined) continue;
    const m = /^([A-Z]+)(\d+)$/.exec(k);
    if (m) { /* a multi-cell array formula anchor inside the block */ const rng = String(c.a); if (rng.includes(':') && intersects(r, parseA(rng))) throw failed("Multi-cell array formulas aren't allowed in tables."); }
  }
  if ((r.end.row - r.start.row + 1) * (r.end.col - r.start.col + 1) > 50_000_000) throw bad('insert.table', 'range too large');
  const textAt = (row, col) => valueOf(engine, si, row, col);
  const header = typeof p.header === 'boolean' ? p.header
    : r.end.row > r.start.row && Array.from({length: r.end.col - r.start.col + 1}, (_, i) => textAt(r.start.row, r.start.col + i)).every(v => typeof v === 'string');
  const taken = new Set((content.sheets).flatMap(sh => (sh.tables ?? []).map(t => t.name.toLowerCase())));
  const names = new Set((content.names ?? []).map(n => n.name.toLowerCase()));
  let name = typeof p.name === 'string' && p.name ? p.name : null;
  if (name === null) { let k = 1; while (taken.has(`table${k}`)) k++; name = `Table${k}`; }
  if (!validTableName(name)) throw failed('The name that you entered is not valid.');
  if (taken.has(name.toLowerCase()) || names.has(name.toLowerCase())) throw failed('The name entered already exists. Enter a unique name.');
  // Without a header row, the data moves down a row to make room for one: never a table with it.
  if (!header && tablesOf(sheet).some(t => t.range.end.row >= r.start.row && t.range.start.col <= r.end.col && t.range.end.col >= r.start.col)) {
    throw failed("This operation isn't allowed: it would shift cells in a table on your worksheet.");
  }
  let range = r;
  const headers = [];
  const taken2 = new Set();
  const nextSuffix = new Map();
  if (!header) {
    const u = usedBounds(sheet);
    if (u && u.r1 >= 1_048_575) throw failed("To prevent possible loss of data, cells can't be pushed off the end of the worksheet.");
    ctx.run('home.insertCells', {range: `${a1(r.start.row, r.start.col)}:${a1(r.start.row, r.end.col)}`, sheet: si, shift: 'down'});
    range = {start: {...r.start}, end: {row: Math.min(1_048_575, r.end.row + 1), col: r.end.col}};
  }
  const readHeader = (row, col) => (header ? display(textAt(row, col)) : '');
  for (let c = range.start.col; c <= range.end.col; c++) {
    let n = readHeader(range.start.row, c);
    if (n === '') n = `Column${c - range.start.col + 1}`;
    const base = n, key = base.toLowerCase();
    let k = nextSuffix.get(key) ?? 2;
    while (taken2.has(n.toLowerCase())) { n = `${base}${k}`; k += 1; }
    nextSuffix.set(key, k);
    taken2.add(n.toLowerCase());
    headers.push(n);
  }
  // Headers are text.
  const after = ctx.doc;
  headers.forEach((h, i) => {
    const col = range.start.col + i;
    const old = cellAt(after.sheets[si], range.start.row, col);
    writeCell(ctx.change, after, si, range.start.row, col, {...(old ?? {}), v: h, f: undefined});
  });
  const table = {name, range: rangeA1(range), headerRow: true, totalsRow: false, columns: headers.map(h => ({name: h})),
    style: {name: typeof p.style === 'string' && p.style ? p.style : 'TableStyleMedium2', showRowStripes: true, showColumnStripes: false, showFirstColumn: false, showLastColumn: false}, autoFilter: true};
  const list = ctx.change.get(['sheets', si, 'tables']) ?? sheet.tables ?? [];
  setIn(ctx.change, ['sheets', si, 'tables'], [...list, table]);
  return {table: name, range: rangeA1(range)};
}

function parseA(text) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(text);
  if (!m) return {start: {row: 0, col: 0}, end: {row: 0, col: 0}};
  const col = t => [...t].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return {start: {row: Number(m[2]) - 1, col: col(m[1])}, end: {row: Number(m[4]) - 1, col: col(m[3])}};
}

export default defineCommands({
  family: 'insert/tables',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'insert.table', label: 'Table', risk: 'edit', dialog: 'dialog.createTable',
      description: 'Convert the selected block (or `range`, or the block around the active cell) to a table: header (does the block start with headers; default: whether its first row is all text), style (default TableStyleMedium2), name (default Table1, Table2, ...). Without a header row, a row of Column1, Column2, ... headers is inserted above the data. → {table, range}.',
      params: s.object({range: s.optional(s.string({min: 1, max: 4096})), sheet: SHEET, header: s.optional(s.boolean()), style: s.optional(s.string({max: 60})), name: s.optional(s.string({max: 255}))}),
      state: hasDoc,
      run: insertTable,
    },
  ],
});

export {colToLetters, contains};
