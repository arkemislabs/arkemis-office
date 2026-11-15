// Lookup and reference functions over evaluated arrays: VLOOKUP, HLOOKUP, LOOKUP, MATCH, XLOOKUP,
// XMATCH, INDEX, ROWS, COLUMNS, TRANSPOSE, ADDRESS. Reference-returning forms (INDEX, XLOOKUP over
// references, OFFSET, ROW...) are the evaluator's (core/grid/model/calc/eval.mjs).
// Translated from gridcraft crates/functions/src/lookup.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {CellError, ERR, GArray, compare, scalar as scalarOf} from '../../lib/value.mjs';
import {colToLetters, sheetNeedsQuotes} from '../../lib/addr.mjs';
import {hasWildcards, lookupEqual} from './criteria.mjs';
import {f, register, S, A, arg, arrayVal, asArray, has, int, num, optBool, optInt, optNum, text} from './registry.mjs';

const isEmpty = v => v === null || v === undefined;
function needle(args, i) {
  const v = scalarOf(arg(args, i).value);
  if (v instanceof CellError) throw v;
  return isEmpty(v) ? 0 : v;
}
const lookupOrder = (a, b) => (typeof a === 'number' && typeof b === 'number' ? (a < b ? -1 : a > b ? 1 : 0) : compare(a, b));
const sameType = (a, b) => (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string') || (typeof a === 'boolean' && typeof b === 'boolean');
function findExact(x, hay, wild0, reverse) {
  const wild = wild0 && typeof x === 'string' && hasWildcards(x);
  if (reverse) { for (let i = hay.length - 1; i >= 0; i--) if (lookupEqual(x, hay[i], wild)) return i; return null; }
  for (let i = 0; i < hay.length; i++) if (lookupEqual(x, hay[i], wild)) return i;
  return null;
}
function bsearchLast(x, hay, desc) {
  if (!hay.length) return null;
  let hi = hay.length - 1, lo = 0, best = null;
  while (lo <= hi) {
    const mid = lo + ((hi - lo) >> 1);
    let j = -1;
    for (let k = mid; k >= lo; k--) if (sameType(x, hay[k])) { j = k; break; }
    if (j < 0) { lo = mid + 1; continue; }
    const o = lookupOrder(hay[j], x);
    if (o === 0) {
      let k = j;
      while (k + 1 < hay.length && sameType(x, hay[k + 1]) && lookupOrder(hay[k + 1], x) === 0) k++;
      return k;
    }
    const before = desc ? o > 0 : o < 0;
    if (before) { best = j; lo = mid + 1; } else if (j === 0) break; else hi = j - 1;
  }
  return best;
}
function binaryOrder(v, x, desc) {
  if (isEmpty(v)) return 1;
  return desc ? -lookupOrder(v, x) : lookupOrder(v, x);
}
function partitionPoint(hay, pred) {
  let lo = 0, hi = hay.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pred(hay[mid])) lo = mid + 1; else hi = mid; }
  return lo;
}
function bsearchFirst(x, hay, desc) { const p = partitionPoint(hay, v => binaryOrder(v, x, desc) < 0); return p < hay.length ? p : null; }
function bsearchUpto(x, hay, desc) { const p = partitionPoint(hay, v => binaryOrder(v, x, desc) <= 0); return p > 0 ? p - 1 : null; }
const vector = a => (a.rows === 1 || a.cols === 1 ? a.data.slice() : null);
const column = (a, c) => Array.from({length: a.rows}, (_, r) => a.get(r, c) ?? null);
const row = (a, r) => Array.from({length: a.cols}, (_, c) => a.get(r, c) ?? null);
const cellResult = v => (isEmpty(v) ? 0 : v);

function vhLookup(args, vertical) {
  const x = needle(args, 0);
  const tv = arg(args, 1).value;
  const table = asArray(tv);
  if (tv instanceof CellError) throw tv;
  const idx0 = num(args, 2);
  if (Number.isNaN(idx0) || idx0 < 1) throw ERR.Value;
  const idx = Math.max(0, Math.trunc(idx0) - 1);
  const approx = optBool(args, 3, true);
  const keys = vertical ? column(table, 0) : row(table, 0);
  const len = vertical ? table.cols : table.rows;
  if (idx >= len) throw ERR.Ref;
  const pos = approx ? bsearchLast(x, keys, false) : findExact(x, keys, true, false);
  if (pos === null) throw ERR.NA;
  return cellResult((vertical ? table.get(pos, idx) : table.get(idx, pos)) ?? null);
}
function lookup(args) {
  const x = needle(args, 0);
  const lv = arg(args, 1).value;
  if (lv instanceof CellError) throw lv;
  const la = asArray(lv);
  if (args.length >= 3) {
    const keys = la.rows === 1 || la.cols === 1 ? la.data : column(la, 0);
    const pos = bsearchLast(x, keys, false);
    if (pos === null) throw ERR.NA;
    const rv = arg(args, 2).value;
    if (rv instanceof CellError) throw rv;
    const ra = asArray(rv);
    const v = ra.rows === 1 || ra.cols === 1 ? ra.data[pos] : ra.rows >= keys.length ? ra.get(pos, 0) : undefined;
    if (v === undefined) throw ERR.NA;
    return cellResult(v);
  }
  if (la.cols > la.rows) {
    const pos = bsearchLast(x, row(la, 0), false);
    if (pos === null) throw ERR.NA;
    return cellResult(la.get(la.rows - 1, pos) ?? null);
  }
  const pos = bsearchLast(x, column(la, 0), false);
  if (pos === null) throw ERR.NA;
  return cellResult(la.get(pos, la.cols - 1) ?? null);
}
function matchFn(args) {
  const x = needle(args, 0);
  const av = arg(args, 1).value;
  if (av instanceof CellError) throw av;
  const hay = vector(asArray(av));
  if (!hay) throw ERR.NA;
  const mt = optNum(args, 2, 1);
  const pos = mt === 0 ? findExact(x, hay, true, false) : mt > 0 ? bsearchLast(x, hay, false) : bsearchLast(x, hay, true);
  if (pos === null) throw ERR.NA;
  return pos + 1;
}
function bsearchExact(x, hay, desc) {
  const p = bsearchFirst(x, hay, desc);
  if (p === null) return null;
  return binaryOrder(hay[p], x, desc) === 0 ? p : null;
}
export function xsearch(x, hay, matchMode, searchMode) {
  if (!(matchMode >= -1 && matchMode <= 2) || ![-2, -1, 1, 2].includes(searchMode)) throw ERR.Value;
  if (Math.abs(searchMode) === 2) {
    const desc = searchMode === -2;
    if (matchMode === 2 || matchMode === 0) return bsearchExact(x, hay, desc);
    if (matchMode === -1) return desc ? bsearchFirst(x, hay, true) : bsearchUpto(x, hay, false);
    return desc ? bsearchUpto(x, hay, true) : bsearchFirst(x, hay, false);
  }
  const reverse = searchMode === -1;
  const p = findExact(x, hay, matchMode === 2, reverse);
  if (p !== null) return p;
  if (matchMode === 0 || matchMode === 2) return null;
  let best = null;
  for (let k = 0; k < hay.length; k++) {
    const i = reverse ? hay.length - 1 - k : k;
    const v = hay[i];
    if (!sameType(x, v)) continue;
    const o = lookupOrder(v, x);
    if (!(matchMode === -1 ? o < 0 : o > 0)) continue;
    const better = best === null || (matchMode === -1 ? lookupOrder(v, hay[best]) > 0 : lookupOrder(v, hay[best]) < 0);
    if (better) best = i;
  }
  return best;
}
function xlookup(args) {
  const x = needle(args, 0);
  const lv = arg(args, 1).value;
  if (lv instanceof CellError) throw lv;
  const rv = arg(args, 2).value;
  if (rv instanceof CellError) throw rv;
  const la = asArray(lv), ra = asArray(rv);
  const hay = vector(la);
  if (!hay) throw ERR.Value;
  const vertical = la.rows === 1 && la.cols === 1 ? ra.rows === 1 || ra.cols !== 1 : la.cols === 1;
  if ((vertical && ra.rows !== la.rows) || (!vertical && ra.cols !== la.cols)) throw ERR.Value;
  const mm = has(args, 4) ? optInt(args, 4, 0) : 0;
  const sm = has(args, 5) ? optInt(args, 5, 1) : 1;
  const p = xsearch(x, hay, mm, sm);
  if (p === null) { if (has(args, 3)) return arg(args, 3).value; throw ERR.NA; }
  if (vertical) { const r = row(ra, p); return r.length === 1 ? cellResult(r[0]) : arrayVal(1, r.length, r); }
  const c = column(ra, p);
  return c.length === 1 ? cellResult(c[0]) : arrayVal(c.length, 1, c);
}
function xmatch(args) {
  const x = needle(args, 0);
  const lv = arg(args, 1).value;
  if (lv instanceof CellError) throw lv;
  const hay = vector(asArray(lv));
  if (!hay) throw ERR.Value;
  const p = xsearch(x, hay, has(args, 2) ? int(args, 2) : 0, has(args, 3) ? int(args, 3) : 1);
  if (p === null) throw ERR.NA;
  return p + 1;
}
function index(args) {
  const av = arg(args, 0).value;
  if (av instanceof CellError) throw av;
  const a = asArray(av);
  let r = has(args, 1) ? num(args, 1) : 0, c = has(args, 2) ? num(args, 2) : 0;
  if (has(args, 3) && Math.trunc(num(args, 3)) !== 1) throw ERR.Ref;
  if (r < 0 || c < 0) throw ERR.Value;
  r = Math.trunc(r); c = Math.trunc(c);
  if (a.rows === 1 && args.length === 2 && a.cols > 1) { c = r; r = 1; }
  if (r > a.rows || c > a.cols) throw ERR.Ref;
  if (r === 0 && c === 0) return a;
  if (r === 0) { const v = column(a, c - 1); return v.length === 1 ? v[0] : arrayVal(v.length, 1, v); }
  if (c === 0) { const v = row(a, r - 1); return v.length === 1 ? v[0] : arrayVal(1, v.length, v); }
  const v = a.get(r - 1, c - 1);
  if (v === undefined) throw ERR.Ref;
  return v;
}
function quoteSheetName(s) {
  const bare = p => /^(true|false)$/i.test(p) || !sheetNeedsQuotes(p);
  const word = p => !!p && /^[\p{Alphabetic}\p{N}_.]+$/u.test(p);
  const m = /^\[([^\]]*)\](.*)$/s.exec(s);
  const plain = m ? word(m[1]) && bare(m[2]) : bare(s);
  return plain ? s : `'${s.replace(/'/g, "''")}'`;
}
function address(args) {
  const r = Math.trunc(num(args, 0)), c = Math.trunc(num(args, 1));
  const abs = has(args, 2) ? int(args, 2) : 1;
  const a1 = has(args, 3) ? optBool(args, 3, true) : true;
  if (!(r >= 1 && r <= 1_048_576) || !(c >= 1 && c <= 16_384) || !(abs >= 1 && abs <= 4)) throw ERR.Value;
  const [rowAbs, colAbs] = abs === 1 ? [true, true] : abs === 2 ? [true, false] : abs === 3 ? [false, true] : [false, false];
  const cell = a1 ? `${colAbs ? '$' : ''}${colToLetters(c - 1)}${rowAbs ? '$' : ''}${r}`
    : `${rowAbs ? `R${r}` : `R[${r}]`}${colAbs ? `C${c}` : `C[${c}]`}`;
  if (has(args, 4)) {
    const sheet = text(args, 4);
    return sheet === '' ? `!${cell}` : `${quoteSheetName(sheet)}!${cell}`;
  }
  return cell;
}

const XL = [true, false, false, false, false, false], VL = [true, false, true, true], ML = [true, false, true, true], IDX = [false, true, true, true];
register([
  f('VLOOKUP', 3, 4, 'Lookup', VL, 'VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])', 'Finds a value in the first column of a table and returns the value in the same row of another column.', a => vhLookup(a, true)),
  f('HLOOKUP', 3, 4, 'Lookup', VL, 'HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])', 'Finds a value in the first row of a table and returns the value in the same column of another row.', a => vhLookup(a, false)),
  f('LOOKUP', 2, 3, 'Lookup', [true, false, false], 'LOOKUP(lookup_value, lookup_vector, [result_vector])', 'Approximate lookup in a sorted vector or the first row/column of an array.', lookup),
  f('MATCH', 2, 3, 'Lookup', [true, false, true], 'MATCH(lookup_value, lookup_array, [match_type])', 'Returns the 1-based position of a value in a row or column.', matchFn),
  f('XLOOKUP', 3, 6, 'Lookup', XL, 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])', 'Searches a row or column and returns the matching item, row or column from another array.', xlookup),
  f('XMATCH', 2, 4, 'Lookup', ML, 'XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])', 'Returns the position of a value in a row or column with flexible match and search modes.', xmatch),
  f('INDEX', 2, 4, 'Lookup', IDX, 'INDEX(array, row_num, [column_num], [area_num])', 'Returns the element, row or column of an array at the given position.', index),
  f('ROWS', 1, 1, 'Lookup', A, 'ROWS(array)', 'Counts the rows in an array or range.', a => { const v = arg(a, 0).value; if (v instanceof GArray) return v.rows; if (v instanceof CellError) throw v; return 1; }),
  f('COLUMNS', 1, 1, 'Lookup', A, 'COLUMNS(array)', 'Counts the columns in an array or range.', a => { const v = arg(a, 0).value; if (v instanceof GArray) return v.cols; if (v instanceof CellError) throw v; return 1; }),
  f('TRANSPOSE', 1, 1, 'Lookup', A, 'TRANSPOSE(array)', 'Swaps the rows and columns of an array.', a => { const v = arg(a, 0).value; return v instanceof GArray ? v.transpose() : v; }),
  f('ADDRESS', 2, 5, 'Lookup', S, 'ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text])', 'Builds a cell address as text from row and column numbers.', address),
]);
