// Data > Sort & Filter > Sort A to Z, Sort Z to A and Sort (the dialog: levels by cell values,
// cell colour or font colour, custom lists, case, header row, top to bottom or left to right).
// Translated from gridcraft crates/engine/src/cmd/data/sort.rs (`quick_sort`, `sort`, `do_sort`,
// `case_order`) and cmd/data.rs (specs) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Behaviour as Excel: the body below a header row is reordered whole lines at a time (cells with
// formulas keep their relative references pointing at the same neighbours, notes, comments,
// hyperlinks and row heights travel with their row), blanks always sort last whatever the order,
// merged cells that are not all one size refuse the sort, and a protected sheet refuses it unless
// Sort is allowed. Floating objects anchored in the body are not moved yet (they belong to U:grid/draw).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, rangeA1, parseCell} from '../../lib/addr.mjs';
import {parse, print, shiftRelative} from '../../lib/formula.mjs';
import {sortCompare} from '../../lib/value.mjs';
import {engineFor} from '../../model/calc.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';
import {mergesIntersecting} from '../../model/sheet.mjs';
import {styleAt} from '../../model/workbook.mjs';
import {resolveColor} from '../../model/style.mjs';
import {hasDoc, gridSel, requireSchema2} from '../../lib/edit-targets.mjs';
import {protectionOf} from '../../lib/format-ranges.mjs';
import {dataTarget, guessHeader, colParam, valueOf, bad, failed, baseDoc} from '../../lib/data-common.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/data.rs', 'crates/engine/src/cmd/data/sort.rs']};
const RANGE = s.optional(s.string({min: 1, max: 4096, description: 'Range (default: the selection, or the region around the active cell)'}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const MAX_KEYS = 64;
const MAX_BODY = 20_000_000;

/** Case-sensitive tie-break for text equal ignoring case: lowercase sorts before uppercase at the first letter that differs in case. */
const isLower = ch => ch === ch.toLowerCase() && ch !== ch.toUpperCase();
function caseCompare(a, b) {
  const ca = [...a], cb = [...b];
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    if (ca[i] !== cb[i]) return Number(isLower(cb[i])) - Number(isLower(ca[i]));
  }
  return 0;
}

const colorKey = rgb => (rgb ? rgb[0] * 65536 + rgb[1] * 256 + rgb[2] : 0xFFFFFFFF);

/** Moves the entries of an A1-keyed side map with their cells (notes, comments, hyperlinks, cell pictures). */
function moveKeyed(sheet, name, body, pairs) {
  const map = sheet[name];
  if (!map || !Object.keys(map).length) return null;
  const next = {};
  for (const k of Object.keys(map)) {
    const c = parseCell(k);
    if (c && c.row >= body.start.row && c.row <= body.end.row && c.col >= body.start.col && c.col <= body.end.col) continue;
    next[k] = map[k];
  }
  for (const [src, dst] of pairs) { const v = map[a1(src.row, src.col)]; if (v !== undefined) next[a1(dst.row, dst.col)] = v; }
  return next;
}

function doSort(ctx, si, r, header, keys, byCols, matchCase) {
  const content = baseDoc(ctx);
  const sheet = requireSchema2(ctx, si);
  const pr = protectionOf(sheet);
  if (pr && !pr.sort) throw failed("Sorting isn't allowed on this protected sheet (Review › Unprotect Sheet).");
  const body = byCols
    ? (header && r.end.col > r.start.col ? {start: {row: r.start.row, col: r.start.col + 1}, end: r.end} : r)
    : (header && r.end.row > r.start.row ? {start: {row: r.start.row + 1, col: r.start.col}, end: r.end} : r);
  const w = body.end.col - body.start.col + 1, h = body.end.row - body.start.row + 1;
  if (w * h > MAX_BODY) throw bad('data.sort', 'range too large');
  if (mergesIntersecting(sheet, body).some(m => !(m.start.row === m.end.row && m.start.col === m.end.col))) throw failed('To do this, all the merged cells need to be the same size.');
  const n = byCols ? w : h;
  const line = (i, k) => (byCols ? {row: k, col: body.start.col + i} : {row: body.start.row + i, col: k});
  const engine = engineFor(content);
  const keyed = [];
  for (let i = 0; i < n; i++) {
    keyed.push(keys.map(k => {
      const c = line(i, k.col);
      const v = valueOf(engine, si, c.row, c.col);
      let color = 0;
      if (k.by === 'cellColor') color = colorKey(resolveColor(styleAt(content, sheet, c.row, c.col).fill.fg, content.theme));
      else if (k.by === 'fontColor') color = colorKey(resolveColor(styleAt(content, sheet, c.row, c.col).font.color, content.theme));
      return [v, color];
    }));
  }
  const order = [...Array(n).keys()];
  order.sort((a, b) => {
    for (let ki = 0; ki < keys.length; ki++) {
      const k = keys[ki];
      const [va, ca] = keyed[a][ki], [vb, cb] = keyed[b][ki];
      let o;
      if (k.by !== 'values') o = ca - cb;
      else if (k.list) {
        const pos = v => { const i = typeof v === 'string' ? k.list.findIndex(x => x.toLowerCase() === v.toLowerCase()) : -1; return i < 0 ? Infinity : i; };
        const pa = pos(va), pb = pos(vb);
        o = pa === pb ? 0 : pa < pb ? -1 : 1;
      } else if (matchCase && typeof va === 'string' && typeof vb === 'string') o = sortCompare(va, vb) || caseCompare(va, vb);
      else o = sortCompare(va, vb);
      const blank = va === null || va === undefined || vb === null || vb === undefined;
      if (k.desc && !blank) o = -o;
      if (o !== 0) return o;
    }
    return 0;
  });
  if (order.every((o, i) => o === i)) return {sorted: rangeA1(body)};
  // Whole lines move; formulas keep their relative references.
  const lanes = [];
  if (byCols) for (let row = body.start.row; row <= body.end.row; row++) lanes.push(row);
  else for (let col = body.start.col; col <= body.end.col; col++) lanes.push(col);
  const moved = [], pairs = [];
  order.forEach((srcI, dstI) => {
    for (const k of lanes) {
      const src = line(srcI, k), dst = line(dstI, k);
      let cell = cellAt(sheet, src.row, src.col);
      if (cell?.f !== undefined && !cell.a) {
        let f = cell.f;
        try { f = print(shiftRelative(parse(cell.f), dst.row - src.row, dst.col - src.col)); } catch { /* keep as is */ }
        cell = {...cell, f};
      }
      moved.push([dst, cell]);
      pairs.push([src, dst]);
    }
  });
  for (const [dst, cell] of moved) writeCell(ctx.change, ctx.doc, si, dst.row, dst.col, cell ? {...cell} : null);
  for (const name of ['notes', 'comments', 'hyperlinks', 'cellPictures']) {
    const next = moveKeyed(sheet, name, body, pairs);
    if (next) ctx.change.set(['sheets', si, name], next);
  }
  // Row heights travel with rows.
  if (!byCols && sheet.rows) {
    const rows = {...sheet.rows};
    order.forEach((srcI, i) => {
      const row = body.start.row + i;
      const info = sheet.rows[body.start.row + srcI];
      const here = sheet.rows[row];
      if (info) {
        const {hidden, ...rest} = info;
        const next = here?.hidden ? {...rest, hidden: true} : rest;
        if (Object.keys(next).length) rows[row] = next; else delete rows[row];
      } else if (here) { const {size, ...rest} = here; if (Object.keys(rest).length) rows[row] = rest; else delete rows[row]; }
    });
    ctx.change.set(['sheets', si, 'rows'], rows);
  }
  return {sorted: rangeA1(body)};
}

function quickSort(ctx, p, asc) {
  const {sheet: si, range: r} = dataTarget(ctx, p, asc ? 'data.sortAscending' : 'data.sortDescending');
  const sel = gridSel(ctx);
  const col = Math.min(Math.max(colParam(p.column, r.start.col) ?? sel.active.col, r.start.col), r.end.col);
  const content = baseDoc(ctx);
  const header = typeof p.header === 'boolean' ? p.header : guessHeader(content, si, r);
  return doSort(ctx, si, r, header, [{col, desc: !asc, by: 'values', list: null}], false, false);
}

function sort(ctx, p) {
  const {sheet: si, range: r} = dataTarget(ctx, p, 'data.sort');
  const content = baseDoc(ctx);
  const header = typeof p.header === 'boolean' ? p.header : guessHeader(content, si, r);
  const byCols = p.orientation === 'columns';
  const keys = [];
  for (const k of p.keys ?? []) {
    let col;
    if (byCols) {
      if (Number.isInteger(k.row)) { if (k.row < 1) throw bad('data.sort', 'sort key row must be 1 or greater'); col = k.row - 1; }
      else col = colParam(k.column, r.start.row);
    } else col = colParam(k.column, r.start.col);
    if (col === null || col === undefined) continue;
    keys.push({col, desc: k.order === 'desc', by: k.by ?? 'values', list: Array.isArray(k.customList) ? k.customList.filter(x => typeof x === 'string') : null});
  }
  if (!keys.length) throw bad('data.sort', 'give at least one sort level in `keys`');
  if (keys.length > MAX_KEYS) throw bad('data.sort', `too many sort levels (${MAX_KEYS} max)`);
  return doSort(ctx, si, r, header, keys, byCols, p.matchCase === true);
}

export default defineCommands({
  family: 'data/sort',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.sortAscending', label: 'Sort A to Z', risk: 'edit',
      description: 'Sort the data around the active cell (or the range) by one column, smallest to largest; the header row is guessed.',
      params: s.object({range: RANGE, sheet: SHEET, header: s.optional(s.boolean({description: 'Whether the first row is a header (default: guessed)'})), column: s.optional(s.union([s.string({min: 1, max: 4}), s.integer({min: 0})], {description: 'Column letter, or 0-based offset into the range (default: the active cell\'s column)'}))}),
      state: hasDoc,
      run: (ctx, p) => quickSort(ctx, p, true),
    },
    {
      id: 'data.sortDescending', label: 'Sort Z to A', risk: 'edit',
      description: 'Sort the data around the active cell (or the range) by one column, largest to smallest; the header row is guessed.',
      params: s.object({range: RANGE, sheet: SHEET, header: s.optional(s.boolean()), column: s.optional(s.union([s.string({min: 1, max: 4}), s.integer({min: 0})]))}),
      state: hasDoc,
      run: (ctx, p) => quickSort(ctx, p, false),
    },
    {
      id: 'data.sort', label: 'Sort…', risk: 'edit', dialog: 'dialog.sort',
      description: 'Sort a range by up to 64 levels: each {column, order: asc|desc, by: values|cellColor|fontColor, customList?}; header?, orientation: rows|columns, matchCase?.',
      params: s.object({
        range: RANGE, sheet: SHEET, header: s.optional(s.boolean()),
        keys: s.array(s.object({
          column: s.optional(s.union([s.string({min: 1, max: 4}), s.integer({min: 0})])), row: s.optional(s.integer({min: 0})),
          order: s.optional(s.enum(['asc', 'desc'])), by: s.optional(s.enum(['values', 'cellColor', 'fontColor'])),
          customList: s.optional(s.array(s.string({max: 255}), {max: 1000})),
        }), {max: MAX_KEYS}),
        orientation: s.optional(s.enum(['rows', 'columns'])), matchCase: s.optional(s.boolean()),
      }),
      state: hasDoc,
      run: sort,
    },
  ],
});
