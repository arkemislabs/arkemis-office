// Dynamic-array functions: FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, RANDARRAY, VSTACK, HSTACK, TOROW,
// TOCOL, WRAPROWS, WRAPCOLS, TAKE, DROP, CHOOSEROWS, CHOOSECOLS, EXPAND.
// Translated from gridcraft crates/functions/src/dynamic.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// GROUPBY and PIVOTBY are not translated yet (not registered).

import {CellError, ERR, GArray, sortCompare, toNumber, toBool, num as numValue} from '../../lib/value.mjs';
import {f, register, VAR, A, MAX_CELLS, arg, arrayVal, asArray, has, num, optBool, scalar, ok} from './registry.mjs';

const isEmpty = v => v === null || v === undefined;
function arrArg(args, i) { const v = arg(args, i).value; if (v instanceof CellError) throw v; return asArray(v); }
const rowsOf = a => Array.from({length: a.rows}, (_, r) => a.data.slice(r * a.cols, (r + 1) * a.cols));
function checkOutputSize(h, w) { if (h * w > MAX_CELLS) throw ERR.Num; }
function fromRows(rows, pad) {
  const h = rows.length;
  let w = 0; for (const r of rows) w = Math.max(w, r.length);
  if (!h || !w) throw ERR.Calc;
  checkOutputSize(h, w);
  const data = [];
  for (const r of rows) { data.push(...r); for (let i = r.length; i < w; i++) data.push(pad); }
  return arrayVal(h, w, data);
}
function optCount(args, i) {
  if (!has(args, i)) return null;
  const n = num(args, i);
  if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw ERR.Num;
  return Math.trunc(n);
}
const padArg = (args, i) => (has(args, i) ? scalar(args[i]) : ERR.NA);
function keyOf(v) {
  if (isEmpty(v)) return 'e';
  if (typeof v === 'number') return 'n' + (v === 0 ? 0 : v);
  if (typeof v === 'string') return 't' + v.toLowerCase();
  if (typeof v === 'boolean') return 'b' + v;
  if (v instanceof CellError) return 'x' + v.code;
  return keyOf(v.data?.[0] ?? null);
}
const rowKey = r => r.map(v => { const k = keyOf(v); return `${k.length}:${k}`; }).join('');
function truthy(v) {
  if (v instanceof CellError) throw v;
  if (isEmpty(v)) return false;
  if (typeof v === 'string') throw ERR.Value;
  return ok(toBool(v));
}

function filter(args) {
  const a = arrArg(args, 0), inc = arrArg(args, 1);
  const keepRows = inc.cols === 1 && inc.rows === a.rows;
  const keepCols = !keepRows && inc.rows === 1 && inc.cols === a.cols;
  if (!keepRows && !keepCols) throw ERR.Value;
  const flags = inc.data.map(truthy);
  const grid = rowsOf(a);
  const out = keepRows ? grid.filter((_, i) => flags[i]) : grid.map(r => r.filter((_, i) => flags[i]));
  if (!out.length || out.every(r => !r.length)) { if (has(args, 2)) return arg(args, 2).value; throw ERR.Calc; }
  return fromRows(out, null);
}
function cmpKeys(a, b, orders) {
  for (let i = 0; i < orders.length; i++) {
    const x = a[i], y = b[i];
    if (x === undefined || y === undefined) continue;
    let o = sortCompare(x, y);
    if (orders[i] < 0) {
      if (isEmpty(x) && isEmpty(y)) o = 0;
      else if (isEmpty(x)) o = 1;
      else if (isEmpty(y)) o = -1;
      else o = -o;
    }
    if (o) return o;
  }
  return 0;
}
function intList(v) {
  return asArray(v).data.map(x => { const n = ok(toNumber(x)); if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw ERR.Value; return Math.trunc(n); });
}
function stableSort(lines, cmp) { return lines.map((l, i) => [l, i]).sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]).map(p => p[0]); }
function sort(args) {
  let a = arrArg(args, 0);
  const byCol = optBool(args, 3, false);
  if (byCol) a = a.transpose();
  const idx = has(args, 1) ? intList(arg(args, 1).value) : [1];
  const ord = has(args, 2) ? intList(arg(args, 2).value) : [1];
  if (!idx.length || idx.some(i => i < 1 || i > a.cols) || ord.some(o => o !== 1 && o !== -1)) throw ERR.Value;
  if (ord.length > 1 && ord.length !== idx.length) throw ERR.Value;
  const orders = idx.map((_, i) => ord[i] ?? ord[0] ?? 1);
  const lines = stableSort(rowsOf(a).map(r => [idx.map(i => r[i - 1] ?? null), r]), (x, y) => cmpKeys(x[0], y[0], orders));
  const out = GArray.new(a.rows, a.cols, lines.flatMap(l => l[1]));
  if (!out) throw ERR.Calc;
  return byCol ? out.transpose() : out;
}
function sortby(args) {
  const a = arrArg(args, 0);
  const keys = [], orders = [];
  for (let i = 1; i < args.length; i += 2) {
    keys.push(arrArg(args, i));
    const o = has(args, i + 1) ? Math.trunc(num(args, i + 1)) : 1;
    if (o !== 1 && o !== -1) throw ERR.Value;
    orders.push(o);
  }
  const first = keys[0];
  if (!first) throw ERR.Value;
  const byRows = first.cols === 1 && first.rows === a.rows;
  const byCols = !byRows && first.rows === 1 && first.cols === a.cols;
  if (!byRows && !byCols) throw ERR.Value;
  for (const k of keys) if (!(byRows ? k.cols === 1 && k.rows === a.rows : k.rows === 1 && k.cols === a.cols)) throw ERR.Value;
  const base = byRows ? a : a.transpose();
  const lines = stableSort(rowsOf(base).map((row, r) => [keys.map(k => k.data[r] ?? null), row]), (x, y) => cmpKeys(x[0], y[0], orders));
  const out = GArray.new(base.rows, base.cols, lines.flatMap(l => l[1]));
  if (!out) throw ERR.Calc;
  return byRows ? out : out.transpose();
}
function unique(args) {
  const a = arrArg(args, 0);
  const byCol = optBool(args, 1, false), once = optBool(args, 2, false);
  const lines = rowsOf(byCol ? a.transpose() : a);
  const counts = new Map();
  for (const l of lines) { const k = rowKey(l); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const seen = new Set(), out = [];
  for (const l of lines) {
    const k = rowKey(l);
    if (once && counts.get(k) !== 1) continue;
    if (!seen.has(k)) { seen.add(k); out.push(l); }
  }
  if (!out.length) throw ERR.Calc;
  const v = fromRows(out, null);
  return byCol ? v.transpose() : v;
}
function dims(args, ri, ci) {
  const r = has(args, ri) ? Math.trunc(num(args, ri)) : 1, c = has(args, ci) ? Math.trunc(num(args, ci)) : 1;
  if (r < 0 || c < 0 || !Number.isFinite(r) || !Number.isFinite(c)) throw ERR.Value;
  if (r === 0 || c === 0) throw ERR.Calc;
  if (r > 1_048_576 || c > 16_384 || r * c > MAX_CELLS) throw ERR.Num;
  return [r, c];
}
function sequence(args) {
  const [r, c] = dims(args, 0, 1);
  const start = has(args, 2) ? num(args, 2) : 1, step = has(args, 3) ? num(args, 3) : 1;
  const data = new Array(r * c);
  for (let i = 0; i < r * c; i++) data[i] = numValue(start + step * i);
  return arrayVal(r, c, data);
}
function randarray(args, ctx) {
  const [r, c] = dims(args, 0, 1);
  const lo = has(args, 2) ? num(args, 2) : 0, hi = has(args, 3) ? num(args, 3) : 1;
  const whole = has(args, 4) ? optBool(args, 4, false) : false;
  if (lo > hi) throw ERR.Value;
  const data = [];
  if (whole) {
    const l = Math.ceil(lo), h = Math.floor(hi);
    if (l > h) throw ERR.Value;
    for (let i = 0; i < r * c; i++) data.push(numValue(Math.min(l + Math.floor(ctx.random() * (h - l + 1)), h)));
  } else for (let i = 0; i < r * c; i++) data.push(numValue(lo + ctx.random() * (hi - lo)));
  return arrayVal(r, c, data);
}
function vstack(args) {
  const rows = [];
  let total = 0;
  for (let i = 0; i < args.length; i++) {
    const a = arrArg(args, i);
    total += a.data.length;
    if (total > MAX_CELLS) throw ERR.Num;
    rows.push(...rowsOf(a));
  }
  return fromRows(rows, ERR.NA);
}
function hstack(args) {
  const arrays = [];
  let h = 0, w = 0, total = 0;
  for (let i = 0; i < args.length; i++) {
    const a = arrArg(args, i);
    h = Math.max(h, a.rows); w += a.cols; total += a.data.length;
    if (total > MAX_CELLS) throw ERR.Num;
    arrays.push(a);
  }
  checkOutputSize(h, w);
  const rows = Array.from({length: h}, () => []);
  for (const a of arrays) rows.forEach((row, r) => { for (let c = 0; c < a.cols; c++) row.push(a.get(r, c) ?? ERR.NA); });
  return fromRows(rows, ERR.NA);
}
function flatFiltered(args) {
  let a = arrArg(args, 0);
  const ignore = has(args, 1) ? Math.trunc(num(args, 1)) : 0;
  if (!(ignore >= 0 && ignore <= 3)) throw ERR.Value;
  if (optBool(args, 2, false)) a = a.transpose();
  return a.data.filter(v => (isEmpty(v) ? (ignore & 1) === 0 : v instanceof CellError ? (ignore & 2) === 0 : true));
}
function wrap(args, rows) {
  const a = arrArg(args, 0);
  if (a.rows !== 1 && a.cols !== 1) throw ERR.Value;
  const n0 = Math.trunc(num(args, 1));
  if (n0 < 1 || !Number.isFinite(n0)) throw ERR.Num;
  const pad = padArg(args, 2);
  const len = a.data.length, n = Math.min(n0, Math.max(len, 1));
  const out = [];
  for (let l = 0; l < Math.ceil(len / n); l++) {
    const line = a.data.slice(l * n, l * n + n);
    while (line.length < n) line.push(pad);
    out.push(line);
  }
  const v = fromRows(out, pad);
  return rows ? v : v.transpose();
}
function span(len, n, take) {
  if (n === null) return [0, len];
  const k = Math.min(Math.abs(n), len);
  if (take) { if (n === 0) throw ERR.Calc; return n > 0 ? [0, k] : [len - k, len]; }
  const r = n >= 0 ? [k, len] : [0, len - k];
  if (r[0] >= r[1]) throw ERR.Calc;
  return r;
}
function takeDrop(args, take) {
  const a = arrArg(args, 0);
  const [r0, r1] = span(a.rows, optCount(args, 1), take), [c0, c1] = span(a.cols, optCount(args, 2), take);
  const rows = [];
  for (let r = r0; r < r1; r++) { const row = []; for (let c = c0; c < c1; c++) row.push(a.get(r, c) ?? null); rows.push(row); }
  return fromRows(rows, null);
}
function chooseLines(args, rows) {
  const a = arrArg(args, 0);
  const base = rows ? a : a.transpose();
  const grid = rowsOf(base), out = [];
  for (let i = 1; i < args.length; i++) for (const k of intList(arg(args, i).value)) {
    const len = grid.length;
    const idx = k > 0 && k <= len ? k - 1 : k < 0 && -k <= len ? len + k : -1;
    if (idx < 0) throw ERR.Value;
    out.push(grid[idx]);
    if (out.length * base.cols > MAX_CELLS) throw ERR.Num;
  }
  const v = fromRows(out, null);
  return rows ? v : v.transpose();
}
function expand(args) {
  const a = arrArg(args, 0);
  const r = optCount(args, 1) ?? a.rows, c = optCount(args, 2) ?? a.cols;
  if (r < a.rows || c < a.cols) throw ERR.Value;
  if (r > 1_048_576 || c > 16_384 || r * c > MAX_CELLS) throw ERR.Num;
  const pad = padArg(args, 3);
  const data = [];
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) { const v = a.get(i, j); data.push(v === undefined ? pad : v); }
  return arrayVal(r, c, data);
}

register([
  f('FILTER', 2, 3, 'Lookup', A, 'FILTER(array, include, [if_empty])', 'Keeps the rows or columns of an array whose include flag is TRUE.', filter),
  f('SORT', 1, 4, 'Lookup', A, 'SORT(array, [sort_index], [sort_order], [by_col])', 'Sorts the rows (or columns) of an array by one or more of its columns.', sort),
  f('SORTBY', 2, VAR, 'Lookup', A, 'SORTBY(array, by_array1, [sort_order1], ...)', 'Sorts an array by the values of other arrays of matching size.', sortby),
  f('UNIQUE', 1, 3, 'Lookup', A, 'UNIQUE(array, [by_col], [exactly_once])', 'Returns the distinct rows or columns of an array.', unique),
  f('SEQUENCE', 1, 4, 'MathTrig', A, 'SEQUENCE(rows, [columns], [start], [step])', 'Builds an array of evenly stepped numbers.', sequence),
  f('RANDARRAY', 0, 5, 'MathTrig', A, 'RANDARRAY([rows], [columns], [min], [max], [whole_number])', 'Builds an array of random numbers in a range.', randarray, {volatile: true}),
  f('VSTACK', 1, VAR, 'Lookup', A, 'VSTACK(array1, [array2], ...)', 'Stacks arrays on top of each other.', vstack),
  f('HSTACK', 1, VAR, 'Lookup', A, 'HSTACK(array1, [array2], ...)', 'Places arrays side by side.', hstack),
  f('TOROW', 1, 3, 'Lookup', A, 'TOROW(array, [ignore], [scan_by_column])', 'Flattens an array into a single row, optionally skipping blanks or errors.', a => { const v = flatFiltered(a); if (!v.length) throw ERR.Calc; return arrayVal(1, v.length, v); }),
  f('TOCOL', 1, 3, 'Lookup', A, 'TOCOL(array, [ignore], [scan_by_column])', 'Flattens an array into a single column, optionally skipping blanks or errors.', a => { const v = flatFiltered(a); if (!v.length) throw ERR.Calc; return arrayVal(v.length, 1, v); }),
  f('WRAPROWS', 2, 3, 'Lookup', A, 'WRAPROWS(vector, wrap_count, [pad_with])', 'Breaks a row or column into rows of the given length.', a => wrap(a, true)),
  f('WRAPCOLS', 2, 3, 'Lookup', A, 'WRAPCOLS(vector, wrap_count, [pad_with])', 'Breaks a row or column into columns of the given length.', a => wrap(a, false)),
  f('TAKE', 2, 3, 'Lookup', A, 'TAKE(array, rows, [columns])', 'Keeps rows or columns from the start (or end) of an array.', a => takeDrop(a, true)),
  f('DROP', 2, 3, 'Lookup', A, 'DROP(array, rows, [columns])', 'Removes rows or columns from the start (or end) of an array.', a => takeDrop(a, false)),
  f('CHOOSEROWS', 2, VAR, 'Lookup', A, 'CHOOSEROWS(array, row_num1, [row_num2], ...)', 'Picks rows of an array by position (negative counts from the end).', a => chooseLines(a, true)),
  f('CHOOSECOLS', 2, VAR, 'Lookup', A, 'CHOOSECOLS(array, col_num1, [col_num2], ...)', 'Picks columns of an array by position (negative counts from the end).', a => chooseLines(a, false)),
  f('EXPAND', 2, 4, 'Lookup', A, 'EXPAND(array, rows, [columns], [pad_with])', 'Grows an array to the given size, filling new cells with a pad value.', expand),
]);
