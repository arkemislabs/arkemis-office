// Shared fixture for the U:quill table and insert units' tests: a schema-2 Quill session (one
// paragraph per line of `text`), the first table, its cells' laid-out rectangles (page points, the
// translated layout with the default metrics shaper, the same one the commands read through
// lib/caret-session.mjs `layoutFor`), and selections by table cell.

import {createTestSession} from '../../core/kernel/testing.mjs';
import {contentFromText} from '../../core/quill/model/content.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {layout} from '../../core/quill/layout/index.mjs';
import {resetLayouts} from '../../core/quill/lib/caret-session.mjs';

export const blocks = t => t.content.body.chunks.flat();

/** A session over `text` (one paragraph per line; '' is one empty paragraph). */
export async function doc(text = '', edit) {
  resetLayouts();
  let content = contentFromText(text);
  if (edit) content = edit(content) ?? content;
  return createTestSession('quill', {content});
}

/** Upstream's `table_session(rows, cols)`: a blank document with insert.table run at its start. */
export async function tableSession(rows, cols, text = '') {
  const t = await doc(text);
  await t.exec('insert.table', {rows, cols});
  return t;
}

/** Index of the first top-level table and the table itself. */
export const tableIndex = t => blocks(t).findIndex(b => b.kind === 'table');
export const firstTable = t => blocks(t).find(b => b.kind === 'table');
/** Each row's cell spans. */
export const shape = tb => tb.rows.map(r => r.cells.map(c => Math.max(1, c.props?.span ?? 1)));

/** The current layout of the document (what the page view draws). */
export const lay = t => layout(t.content, {view: 'print'});

/** A cell's rectangle on page 0 ({x, y, w, h}) of the outermost table, with right()/bottom(). */
export function cellRect(t, row, cell, page = 0) {
  const it = lay(t).pages[page].items.find(i => i.kind === 'cell' && i.row === row && i.cell === cell && i.table.length === 1);
  if (!it) throw new Error(`no cell ${row},${cell} on page ${page}`);
  const r = it.rect;
  return {x: r.x, y: r.y, w: r.w, h: r.h, right: r.x + r.w, bottom: r.y + r.h, midY: r.y + r.h / 2, midX: r.x + r.w / 2};
}

/** Put the caret at the start of cell (r, c) of the first table. */
export function caretIn(t, r, c, off = 0) {
  const a = addrOf(t, {story: 'body', path: [tableIndex(t), r, c, 0], off});
  t.session.setSelection(t.docId, {ranges: [{anchor: a, focus: a}], primary: 0});
}

/** Select from cell (r0, c0) offset a to cell (r1, c1) offset b. */
export function selectCells(t, [r0, c0, a = 0], [r1, c1, b]) {
  const ti = tableIndex(t);
  const pb = t.content.body.chunks.flat()[ti].rows[r1].cells[c1].blocks[0];
  const A = addrOf(t, {story: 'body', path: [ti, r0, c0, 0], off: a});
  const B = addrOf(t, {story: 'body', path: [ti, r1, c1, 0], off: b ?? pb.text.length});
  t.session.setSelection(t.docId, {ranges: [{anchor: A, focus: B}], primary: 0});
}

/** The model address of a position. */
export async function importAddress() { return import('../../core/quill/address.mjs'); }
let addressOf = null;
export async function ready() { addressOf ??= (await importAddress()).addressOf; addressMod ??= await importAddress(); }
export function addrOf(t, pos) {
  if (!addressOf) throw new Error('call await ready() first');
  return addressOf(t.content, pos);
}

/** The plain text of cell (r, c)'s paragraphs, joined by \n. */
export function cellText(t, r, c) {
  return firstTable(t).rows[r].cells[c].blocks.filter(b => b.kind === 'para').map(b => P.plainText(b)).join('\n');
}

/** Type "r{row}c{cell}" into every cell (upstream `fill`). */
export async function fill(t) {
  const tb = firstTable(t);
  for (let r = 0; r < tb.rows.length; r++) for (let c = 0; c < tb.rows[r].cells.length; c++) {
    caretIn(t, r, c);
    await t.exec('text.insert', {text: `r${r}c${c}`});
  }
}

/** Expect `fn` to reject. */
export async function rejects(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected an error');
}

export const near = (a, b, tol) => Math.abs(a - b) < tol;

/** [row, cell] of the first table an address is in (by the row and cell ids in the address), or null. */
export function cellOfAddress(t, address) {
  const m = /^\/body\/b:([^/]+)\/r:([^/]+)\/c:([^/]+)\//.exec(address ?? '');
  if (!m) return null;
  const tb = blocks(t).find(b => b.id === m[1]);
  if (!tb || tb.kind !== 'table') return null;
  const r = tb.rows.findIndex(x => x.id === m[2]);
  const c = r < 0 ? -1 : tb.rows[r].cells.findIndex(x => x.id === m[3]);
  return r < 0 || c < 0 ? null : [r, c];
}

/**
 * The selection as table cells: {n (ranges), rows [first, last], cols [first, last] (cell indices),
 * cells ([[r, c]] of every range end)}, or null when an end is outside the first table.
 */
export function selCells(t) {
  const ranges = t.doc.selection.ranges;
  const ends = ranges.flatMap(r => [cellOfAddress(t, r.anchor), cellOfAddress(t, r.focus)]);
  if (ends.some(e => !e)) return null;
  const rs = ends.map(e => e[0]), cs = ends.map(e => e[1]);
  return {n: ranges.length, rows: [Math.min(...rs), Math.max(...rs)], cols: [Math.min(...cs), Math.max(...cs)], cells: ends};
}

let addressMod = null;
/** The primary selection as model positions {anchor, focus}. */
export function selPositions(t) {
  if (!addressMod) throw new Error('call await ready() first');
  const all = addressMod.selectionPositions(t.content, t.doc.selection);
  return all[t.doc.selection.primary ?? 0] ?? all[0];
}
/** Select from {path, off} to {path, off} in the body (paths of the body's blocks). */
export function selectBody(t, [pa, oa], [pf, of]) {
  const A = addrOf(t, {story: 'body', path: Array.isArray(pa) ? pa : [pa], off: oa});
  const F = addrOf(t, {story: 'body', path: Array.isArray(pf) ? pf : [pf], off: of});
  t.session.setSelection(t.docId, {ranges: [{anchor: A, focus: F}], primary: 0});
}
/** The selected text of the primary range in the body (paragraphs joined by \n). */
export function selectedText(t) {
  const {anchor, focus} = selPositions(t);
  const [a, b] = addressMod.cmpPositions(anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor];
  const paras = blocks(t);
  if (a.path.length !== 1 || b.path.length !== 1) throw new Error('selectedText: top-level paragraphs only');
  const out = [];
  for (let i = a.path[0]; i <= b.path[0]; i++) {
    // Offsets count the object marks (U+FFFC) in the paragraph's text; the selected text drops them.
    const tx = paras[i].text;
    out.push(tx.slice(i === a.path[0] ? a.off : 0, i === b.path[0] ? b.off : undefined).replace(/￼/g, ''));
  }
  return out.join('\n');
}
export async function readyAll() { await ready(); addressMod ??= await importAddress(); }
