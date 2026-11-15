// Tables on a page (Insert › Table and the Table Layout tab; U:slate/table).
//
// Slate has no ArtCraft upstream; OneNote's tables are rectangular grids (no merged cells) inside
// a note container: rows, columns, cell shading, hidden borders, an optional header row and a
// sort. The schema (core/slate/schema.mjs) is table > tableRow > tableCell > blocks, every node
// with a block id. This module builds tables, reads what the selection names in one and edits
// the grid as ProseMirror transforms.
//
// The selection of a table is addresses: a caret or text range inside cells; `/pg:<id>/b:<cellId>`
// for a selected cell (one range per selected cell, so Select Columns is a range per cell of the
// columns); `/pg:<id>/b:<tableId>` for the whole table.
//
// No DOM, no Node built-ins.

import {Fragment} from '@tiptap/pm/model';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, nodeOf, schema} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {blockIndex} from '../model/page.mjs';
import {sortKey, cmpSortKeys} from '../../quill/model/collate.mjs';

export const MAX_ROWS = 500;
export const MAX_COLS = 99;

const bid = ctx => `b${ctx.host.uid()}`;

export function newCell(ctx, shading = null) {
  return schema.nodes.tableCell.create({id: bid(ctx), shading}, schema.nodes.paragraph.create({id: bid(ctx)}));
}
export function newRow(ctx, cols, shadings = []) {
  const cells = [];
  for (let c = 0; c < cols; c++) cells.push(newCell(ctx, shadings[c] ?? null));
  return schema.nodes.tableRow.create({id: bid(ctx)}, cells);
}
/** A table of empty cells as OneNote inserts one (borders on, no header row). */
export function newTable(ctx, rows, cols) {
  const list = [];
  for (let r = 0; r < rows; r++) list.push(newRow(ctx, cols));
  return schema.nodes.table.create({id: bid(ctx), hideBorders: false, headerRow: false, sortHeader: false, widths: null}, list);
}

/** Position of cell (row, col) of the table at tablePos. */
export function cellPos(table, tablePos, row, col) {
  let pos = tablePos + 1;
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
  const rowNode = table.child(row);
  let cp = pos + 1;
  for (let c = 0; c < col; c++) cp += rowNode.child(c).nodeSize;
  return cp;
}
export const rowPos = (table, tablePos, row) => { let pos = tablePos + 1; for (let r = 0; r < row; r++) pos += table.child(r).nodeSize; return pos; };
export const colCount = table => (table.childCount ? table.child(0).childCount : 0);

const POINT = /^\/pg:([^/]+)\/(?:b|c|media):([^/]+)/;
const idOf = address => { const m = POINT.exec(address ?? ''); return m ? {page: decodeURIComponent(m[1]), id: decodeURIComponent(m[2])} : null; };

/** The id-carrying ancestors of a node, itself first: [{node, pos, id}]. */
function chainOf(index, id) {
  const out = [];
  let cur = id;
  for (let guard = 0; cur && guard < 64; guard++) {
    const hit = index.get(cur);
    if (!hit) break;
    out.push({node: hit.node, pos: hit.pos, id: cur});
    cur = hit.parent;
  }
  return out;
}

/** The (table, row, col) trail of an endpoint, innermost table first; `whole` when it names a table or a row. */
function trail(index, id) {
  const chain = chainOf(index, id);
  const out = [];
  for (let i = 0; i < chain.length; i++) {
    const n = chain[i];
    if (n.node.type.name === 'tableCell') {
      const rowEntry = chain[i + 1], tableEntry = chain[i + 2];
      if (!rowEntry || !tableEntry) continue;
      const row = tableEntry.node.content.content.findIndex(r => r === rowEntry.node || r.attrs.id === rowEntry.id);
      const col = rowEntry.node.content.content.findIndex(c => c === n.node || c.attrs.id === n.id);
      out.push({table: tableEntry, row, col, self: i === 0 ? 'cell' : null});
    } else if (n.node.type.name === 'tableRow' && i === 0) {
      const tableEntry = chain[1];
      if (tableEntry) out.push({table: tableEntry, row: tableEntry.node.content.content.findIndex(r => r.attrs.id === n.id), col: null, self: 'row'});
    } else if (n.node.type.name === 'table' && i === 0) out.push({table: n, row: null, col: null, self: 'table'});
  }
  return out;
}

/**
 * What the selection names in a table: {pageId, doc, table: {id, pos, node}, cells: Set('r,c'),
 * rows, cols (sorted unique), whole, focus: {row, col}} or null when it is not in a table. A caret
 * is its cell; a text range across cells is the rectangle between its ends; cell addresses
 * (Select Cell / Rows / Columns) are the cells named; a table address is every cell.
 */
export function tableSelection(ctx) {
  if (!isNotebook(ctx.doc)) return null;
  const ranges = ctx.selection?.ranges ?? [];
  if (!ranges.length) return null;
  const first = idOf(ranges[ctx.selection.primary ?? 0]?.focus ?? ranges[0].focus) ?? idOf(ranges[0].anchor);
  if (!first || !ctx.doc.pages[first.page]) return null;
  const pageId = first.page;
  const doc = nodeOf(ctx.doc.pages[pageId].body);
  const index = blockIndex(doc);
  let table = null;
  const cells = new Set();
  let whole = false;
  let focus = null;
  for (const r of ranges) {
    const a = idOf(r.anchor), f = idOf(r.focus ?? r.anchor);
    if (!a || !f || a.page !== pageId || f.page !== pageId) continue;
    const ta = trail(index, a.id), tf = trail(index, f.id);
    // The innermost table both ends are in.
    let pair = null;
    for (const x of ta) { const y = tf.find(z => z.table.id === x.table.id); if (y) { pair = [x, y]; break; } }
    if (!pair) continue;
    const [pa, pf] = pair;
    if (table && table.id !== pa.table.id) continue;
    table = pa.table;
    if (pa.self === 'table' || pf.self === 'table') { whole = true; continue; }
    const rows = [pa.row, pf.row], cols = [pa.col, pf.col];
    const rowsFrom = pa.col === null ? 0 : null;
    if (pa.col === null || pf.col === null) {
      // A row address: its whole row.
      for (let rr = Math.min(...rows); rr <= Math.max(...rows); rr++) for (let cc = 0; cc < colCount(table.node); cc++) cells.add(`${rr},${cc}`);
      void rowsFrom;
      continue;
    }
    for (let rr = Math.min(...rows); rr <= Math.max(...rows); rr++) for (let cc = Math.min(...cols); cc <= Math.max(...cols); cc++) cells.add(`${rr},${cc}`);
    if (!focus) focus = {row: pf.row, col: pf.col};
  }
  if (!table) return null;
  if (whole) { for (let rr = 0; rr < table.node.childCount; rr++) for (let cc = 0; cc < colCount(table.node); cc++) cells.add(`${rr},${cc}`); }
  if (!focus) focus = {row: 0, col: 0};
  const pairs = [...cells].map(k => k.split(',').map(Number));
  return {pageId, doc, table, cells, rows: [...new Set(pairs.map(p => p[0]))].sort((x, y) => x - y), cols: [...new Set(pairs.map(p => p[1]))].sort((x, y) => x - y),
    whole: whole || cells.size === table.node.childCount * colCount(table.node), focus};
}

export const NOT_IN_TABLE = 'Click in a table to use the table commands';

/** State helper: enabled when the selection is in a table. */
export function tableState(ctx) {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  return tableSelection(ctx) ? {enabled: true} : {enabled: false, reason: NOT_IN_TABLE};
}

export function needTable(ctx) {
  const t = tableSelection(ctx);
  if (!t) throw new CommandError('disabled', NOT_IN_TABLE);
  return t;
}

/** Selection addresses for a set of cells (one range per cell) of a table. */
export function cellRanges(pageId, table, cells) {
  const ranges = [];
  for (const [r, c] of cells) {
    const id = table.child(r).child(c).attrs.id;
    const a = `/pg:${pageId}/b:${id}`;
    ranges.push({anchor: a, focus: a});
  }
  return {ranges, primary: 0};
}

/** Sorted rows of a table by the text of a column (OneNote's Sort): numbers by value, text by locale order, empty cells last. */
export function sortedRows(table, col, descending, skipHeader) {
  const rows = table.content.content.slice();
  const head = skipHeader ? rows.splice(0, 1) : [];
  const text = row => row.child(col).textContent.trim();
  const num = s => (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s.replace(/,/g, '')) ? Number(s.replace(/,/g, '')) : null);
  const keyed = rows.map((row, i) => ({row, i, t: text(row), n: num(text(row)), k: null}));
  for (const x of keyed) x.k = sortKey(x.t);
  const cmp = (a, b) => {
    if (a.t === '' || b.t === '') return a.t === b.t ? 0 : a.t === '' ? 1 : -1;
    if (a.n !== null && b.n !== null) return a.n - b.n;
    if (a.n !== null || b.n !== null) return a.n !== null ? -1 : 1;
    return cmpSortKeys(a.k, b.k);
  };
  keyed.sort((a, b) => {
    // Empty cells stay last in either order.
    if (a.t === '' || b.t === '') return a.t === b.t ? a.i - b.i : a.t === '' ? 1 : -1;
    return (descending ? -cmp(a, b) : cmp(a, b)) || a.i - b.i;
  });
  return [...head, ...keyed.map(x => x.row)];
}

/** The rows of a Fragment for replaceWith. */
export const rowsFragment = rows => Fragment.from(rows);
