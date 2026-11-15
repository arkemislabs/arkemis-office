// Data > Sort & Filter > Advanced (Advanced Filter) and Data > Data Tools > Consolidate.
// Translated from gridcraft crates/engine/src/cmd/whatif/advanced_filter.rs (`criterion_matches`,
// `advanced_filter`) and cmd/whatif/consolidate.rs (`Agg`, `consolidate`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Advanced Filter: the list has a header row; the criteria range has a header row of field names and
// rows OR'ed with columns AND'ed (">100", "=abc", "a*", "<>"; a criteria cell under a blank or
// unmatched heading holding a formula is a computed criterion, written for the first data row); the
// matching rows are hidden-in-place or copied to another place, optionally unique records only.
// Consolidate: combines ranges from several sheets by position or by top-row / left-column labels with
// sum, count, count numbers, average, max, min or product, writing values from the destination.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {rangeA1, rangeOf, intersects, count as rangeCount} from '../../lib/addr.mjs';
import {parse, print, shiftRelative} from '../../lib/formula.mjs';
import {compareText, CellError, ERR, toBool} from '../../lib/value.mjs';
import {parseNumberText} from '../../lib/parse.mjs';
import {wildcard} from '../../lib/edit-find.mjs';
import {engineFor} from '../../model/calc.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';
import {styleIdAt} from '../../model/workbook.mjs';
import {hasDoc, gridSel} from '../../lib/edit-targets.mjs';
import {parseRangeText, regionAround, valueOf, textOf, setRowsHidden, bad, failed, baseDoc} from '../../lib/data-common.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/whatif.rs', 'crates/engine/src/cmd/whatif/advanced_filter.rs', 'crates/engine/src/cmd/whatif/consolidate.rs']};
const EPS = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(b), 1);

/** Splits ">=10" into [">=", "10"]; text without an operator means "begins with". */
function splitOp(t) {
  for (const op of ['<>', '>=', '<=', '=', '>', '<']) if (t.startsWith(op)) return [op, t.slice(op.length)];
  return ['begins', t];
}

/** Does a list value match one criteria cell's value (Excel's advanced-filter semantics)? */
export function criterionMatches(v, text, crit) {
  if (crit === null || crit === undefined) return true;
  if (typeof crit === 'number') return typeof v === 'number' && EPS(v, crit);
  if (typeof crit === 'boolean') return v === crit;
  if (crit instanceof CellError) return v instanceof CellError && v.code === crit.code;
  if (typeof crit !== 'string') return false;
  const [op, operand] = splitOp(crit);
  const empty = v === null || v === undefined;
  if (operand === '') {
    if (op === '=') return empty || text === '';
    if (op === '<>') return !(empty || text === '');
    return true;
  }
  const num = parseNumberText(operand);
  const lt = text.toLowerCase(), lo = operand.toLowerCase();
  let cmp;
  if (typeof v === 'number' && num !== null) cmp = v < num ? -1 : v > num ? 1 : 0;
  else if (typeof v === 'number') cmp = null;
  else if (empty) cmp = null;
  else if (num !== null && op !== 'begins') cmp = null;
  else cmp = compareText(text, operand);
  const hasWild = /[*?]/.test(operand);
  switch (op) {
    case '=': return num === null && hasWild ? wildcard(lt, lo) : num === null ? lt === lo : cmp === 0;
    case '<>': return num === null && hasWild ? !wildcard(lt, lo) : num === null ? lt !== lo : cmp !== 0;
    case '>': return cmp === 1;
    case '<': return cmp === -1;
    case '>=': return cmp === 1 || cmp === 0;
    case '<=': return cmp === -1 || cmp === 0;
    default: // a plain text criterion: begins with (wildcards allowed); a plain number equals
      if (typeof v === 'number' && num !== null) return EPS(v, num);
      return !empty && wildcard(lt, `${lo}*`);
  }
}

function advancedFilter(ctx, p) {
  const CMD = 'data.advancedFilter';
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const list = typeof p.range === 'string' && p.range.trim()
    ? parseRangeText(content, p.range, CMD, sel.sheet)
    : {sheet: sel.sheet, range: regionAround(content, sel.sheet, sel.active)};
  const {sheet: si, range: lr} = list;
  const crit = typeof p.criteria === 'string' && p.criteria.trim() ? parseRangeText(content, p.criteria, CMD, sel.sheet) : null;
  if (rangeCount(lr) > 50_000_000) throw bad(CMD, 'the list range is too large');
  if (crit && (crit.range.end.col - crit.range.start.col + 1 > 1024 || crit.range.end.row - crit.range.start.row + 1 > 10_000)) throw bad(CMD, 'the criteria range is too large');
  const engine = engineFor(content);
  const headers = [];
  for (let c = lr.start.col; c <= lr.end.col; c++) headers.push(textOf(content, si, lr.start.row, c, valueOf(engine, si, lr.start.row, c)).trim().toLowerCase());
  const firstData = lr.start.row + 1;
  // Criteria rows to conditions.
  const rows = [];
  if (crit) {
    const csh = content.sheets[crit.sheet];
    for (let cr = crit.range.start.row + 1; cr <= crit.range.end.row; cr++) {
      const conds = [];
      for (let cc = crit.range.start.col; cc <= crit.range.end.col; cc++) {
        const v = valueOf(engine, crit.sheet, cr, cc);
        const formula = cellAt(csh, cr, cc)?.f;
        if ((v === null || v === undefined || v === '') && formula === undefined) continue;
        const head = textOf(content, crit.sheet, crit.range.start.row, cc, valueOf(engine, crit.sheet, crit.range.start.row, cc)).trim().toLowerCase();
        const off = head ? headers.indexOf(head) : -1;
        if (off >= 0) conds.push({off, crit: v, text: null});
        else if (formula !== undefined) conds.push({computed: formula, at: {row: cr, col: cc}});
        else throw failed(`The criteria label \`${head}\` doesn't match a column of the list.`);
      }
      rows.push(conds);
    }
  }
  const matchesRow = row => {
    if (!rows.length) return true;
    return rows.some(conds => conds.every(c => {
      if (c.computed !== undefined) {
        let f = c.computed;
        try { f = print(shiftRelative(parse(c.computed), row - firstData, 0)); } catch { return false; }
        return toBool(engine.evaluate(crit.sheet, c.at, f)) === true;
      }
      const col = lr.start.col + c.off;
      const v = valueOf(engine, si, row, col);
      return criterionMatches(v, textOf(content, si, row, col, v), c.crit);
    }));
  };
  const unique = p.unique === true;
  const seen = new Set();
  const keep = [];
  for (let row = firstData; row <= lr.end.row; row++) {
    let ok = matchesRow(row);
    if (ok && unique) {
      const key = JSON.stringify(Array.from({length: lr.end.col - lr.start.col + 1}, (_, i) => textOf(content, si, row, lr.start.col + i, valueOf(engine, si, row, lr.start.col + i)).toLowerCase()));
      ok = !seen.has(key);
      seen.add(key);
    }
    keep.push([row, ok]);
  }
  const matched = keep.filter(([, k]) => k).length;
  if (typeof p.copyTo === 'string' && p.copyTo.trim()) {
    const dest = parseRangeText(content, p.copyTo, CMD, sel.sheet);
    const d0 = dest.range.start;
    const rowsOut = [lr.start.row, ...keep.filter(([, k]) => k).map(([r]) => r)];
    const w = lr.end.col - lr.start.col + 1;
    if (d0.row + rowsOut.length > 1_048_576 || d0.col + w > 16_384) throw bad(CMD, 'the extract range exceeds the worksheet');
    const out = rangeOf(d0.row, d0.col, d0.row + rowsOut.length - 1, d0.col + w - 1);
    if (dest.sheet === si && intersects(out, lr)) throw failed("The extract range can't overlap the list range.");
    // Values and the cells' styles; the old contents of the extract area go.
    const cells = [];
    rowsOut.forEach((row, i) => {
      for (let c = lr.start.col; c <= lr.end.col; c++) {
        const v = valueOf(engine, si, row, c);
        const st = styleIdAt(content.sheets[si], row, c);
        const cell = {};
        if (v !== null && v !== undefined) cell.v = v instanceof CellError ? {e: v.text} : v;
        if (st) cell.s = st;
        cells.push([d0.row + i, d0.col + c - lr.start.col, Object.keys(cell).length ? cell : null]);
      }
    });
    for (const [row, col, cell] of cells) writeCell(ctx.change, ctx.doc, dest.sheet, row, col, cell);
    return {matched, range: rangeA1(out)};
  }
  setRowsHidden(ctx.change, content, si, new Map(keep.map(([row, k]) => [row, !k])));
  return {matched, hiddenRows: keep.filter(([, k]) => !k).length};
}

class Agg {
  constructor() { this.count = 0; this.nums = 0; this.sum = 0; this.product = 1; this.min = 0; this.max = 0; }
  add(v) {
    if (v === null || v === undefined) return;
    this.count++;
    if (typeof v === 'number') {
      if (this.nums === 0) { this.min = v; this.max = v; this.product = 1; }
      this.nums++; this.sum += v; this.product *= v; this.min = Math.min(this.min, v); this.max = Math.max(this.max, v);
    }
  }
  result(func) {
    switch (func) {
      case 'count': return this.count;
      case 'countNums': case 'countnums': return this.nums;
      case 'average': return this.nums === 0 ? ERR.Div0 : this.sum / this.nums;
      case 'max': return this.nums === 0 ? 0 : this.max;
      case 'min': return this.nums === 0 ? 0 : this.min;
      case 'product': return this.nums === 0 ? 0 : this.product;
      default: return this.sum;
    }
  }
}
const FUNCS = ['sum', 'count', 'countNums', 'countnums', 'average', 'max', 'min', 'product'];
const MAX_CONSOLIDATE_CELLS = 5_000_000;

function consolidate(ctx, p) {
  const CMD = 'data.consolidate';
  const func = p.function ?? 'sum';
  if (!FUNCS.includes(func)) throw bad(CMD, `unknown function \`${func}\``);
  const top = p.topRow === true, left = p.leftColumn === true;
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const srcs = Array.isArray(p.sources) ? p.sources.filter(x => typeof x === 'string') : typeof p.sources === 'string' ? p.sources.split(';') : [];
  if (!srcs.length) throw bad(CMD, 'give at least one source range in `sources`');
  if (srcs.length > 255) throw bad(CMD, 'too many sources (255 max)');
  const dest = typeof p.destination === 'string' && p.destination.trim() ? parseRangeText(content, p.destination, CMD, sel.sheet) : {sheet: sel.sheet, range: {start: {...sel.active}, end: {...sel.active}}};
  const d0 = dest.range.start;
  const engine = engineFor(content);
  const rowKeys = [], colKeys = [];
  const rowLabel = new Map(), colLabel = new Map();
  const aggs = new Map();
  let total = 0;
  const index = (keys, k) => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
  for (const t of srcs) {
    const {sheet: si, range: r} = parseRangeText(content, t, CMD, sel.sheet);
    total += rangeCount(r);
    if (total > MAX_CONSOLIDATE_CELLS) throw bad(CMD, 'the sources are too large');
    const r0 = r.start.row + (top ? 1 : 0), c0 = r.start.col + (left ? 1 : 0);
    if (r0 > r.end.row || c0 > r.end.col) continue;
    const label = (row, col) => textOf(content, si, row, col, valueOf(engine, si, row, col)).trim();
    const cols = [];
    for (let col = c0; col <= r.end.col; col++) {
      let k;
      if (top) {
        const l = label(r.start.row, col);
        if (!l) continue;
        k = `L:${l.toLowerCase()}`;
        if (!colLabel.has(k)) colLabel.set(k, l);
      } else k = `P:${col - c0}`;
      cols.push([col, index(colKeys, k)]);
    }
    for (let row = r0; row <= r.end.row; row++) {
      let k;
      if (left) {
        const l = label(row, r.start.col);
        if (!l) continue;
        k = `L:${l.toLowerCase()}`;
        if (!rowLabel.has(k)) rowLabel.set(k, l);
      } else k = `P:${row - r0}`;
      const ri = index(rowKeys, k);
      for (const [col, ci] of cols) {
        const key = `${ri},${ci}`;
        let a = aggs.get(key);
        if (!a) { a = new Agg(); aggs.set(key, a); }
        a.add(valueOf(engine, si, row, col));
      }
    }
  }
  const outR0 = d0.row + (top ? 1 : 0), outC0 = d0.col + (left ? 1 : 0);
  if (outR0 + rowKeys.length > 1_048_576 || outC0 + colKeys.length > 16_384) throw failed("The consolidated data doesn't fit below and right of the destination.");
  const cells = [];
  if (top) colKeys.forEach((k, ci) => cells.push([d0.row, outC0 + ci, colLabel.get(k) ?? '']));
  if (left) rowKeys.forEach((k, ri) => cells.push([outR0 + ri, d0.col, rowLabel.get(k) ?? '']));
  for (let ri = 0; ri < rowKeys.length; ri++) for (let ci = 0; ci < colKeys.length; ci++) {
    const a = aggs.get(`${ri},${ci}`);
    cells.push([outR0 + ri, outC0 + ci, !a || a.count === 0 ? null : a.result(func)]);
  }
  for (const [row, col, v] of cells) {
    const st = styleIdAt(content.sheets[dest.sheet], row, col);
    const cell = {};
    if (v !== null && v !== undefined && v !== '') cell.v = v instanceof CellError ? {e: v.text} : v;
    else if (v === '') cell.v = '';
    if (st) cell.s = st;
    writeCell(ctx.change, ctx.doc, dest.sheet, row, col, Object.keys(cell).length ? cell : null);
  }
  const endRow = Math.max(outR0 + rowKeys.length - 1, d0.row), endCol = Math.max(outC0 + colKeys.length - 1, d0.col);
  return {range: rangeA1(rangeOf(d0.row, d0.col, endRow, endCol)), rows: rowKeys.length, columns: colKeys.length};
}

export default defineCommands({
  family: 'whatif/lists',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.advancedFilter', label: 'Advanced…', risk: 'edit', dialog: 'dialog.advancedFilter',
      description: 'Filter a list with a criteria range: `range` (list with headers; default the current region), `criteria` (header row of field names, rows OR\'ed, columns AND\'ed), `copyTo` (a place to copy the matches; else rows are hidden in place), `unique`.',
      params: s.object({range: s.optional(s.string({max: 600})), criteria: s.optional(s.string({max: 600})), copyTo: s.optional(s.string({max: 600})), unique: s.optional(s.boolean())}),
      state: hasDoc,
      run: advancedFilter,
    },
    {
      id: 'data.consolidate', label: 'Consolidate…', risk: 'edit', dialog: 'dialog.consolidate',
      description: 'Combine ranges (`sources`, e.g. "Sheet2!A1:C10") from `destination` with function sum|count|countNums|average|max|min|product, by position or by labels (topRow, leftColumn).',
      params: s.object({sources: s.union([s.array(s.string({max: 600}), {max: 255}), s.string({max: 100_000})]), destination: s.optional(s.string({max: 600})), function: s.optional(s.enum(FUNCS)), topRow: s.optional(s.boolean()), leftColumn: s.optional(s.boolean())}),
      state: hasDoc,
      run: consolidate,
    },
  ],
});
