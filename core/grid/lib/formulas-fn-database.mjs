// Database functions (DSUM, DAVERAGE, DCOUNT, DCOUNTA, DGET, DMAX, DMIN, DPRODUCT, DSTDEV,
// DSTDEVP, DVAR, DVARP): one field of the records of a table that satisfy a criteria table.
// Translated from gridcraft crates/functions/src/database.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/formulas (registered through
// the foundation's registry; design note U-grid-formulas--F-grid--register-function-categories).
//
// The database and the criteria are arrays whose first row holds labels. Each criteria row is a
// set of conditions that must all hold (AND); a record matches when any criteria row holds (OR).
// An empty criteria cell matches anything; plain text matches values that begin with it, as in
// Excel's advanced filter. A formula under a label that names no field is a computed criterion,
// which the evaluator works out for each record (eval.mjs FnCtx.computedCriterion).
// No DOM, no Node built-ins.

import {CellError, ERR, GArray, compareText, numberToText} from './value.mjs';
import {parseNumberText} from './parse.mjs';
import {parseError} from './value.mjs';
import {Criterion} from '../model/functions/criteria.mjs';
import {f, register, A, has, numVal, asArray} from '../model/functions/registry.mjs';

/** database.rs `find_column`: the column of a label in the header row. */
function findColumn(db, label) {
  const l = String(label).trim();
  for (let c = 0; c < db.cols; c++) {
    const h = db.get(0, c);
    if (typeof h === 'string' && compareText(h.trim(), l) === 0) return c;
    if (typeof h === 'number' && numberToText(h) === l) return c;
  }
  return null;
}

/** database.rs `field_index`: a label or a 1-based column number; null when omitted. */
function fieldIndex(db, args) {
  if (!has(args, 1)) return null;
  const v0 = args[1].value;
  const v = v0 instanceof GArray ? (v0.data[0] ?? null) : v0;
  if (typeof v === 'number') {
    const i = Math.trunc(v);
    if (Number.isNaN(i) || i < 1 || i > db.cols) throw ERR.Value;
    return i - 1;
  }
  if (typeof v === 'string') { const c = findColumn(db, v); if (c === null) throw ERR.Value; return c; }
  if (typeof v === 'boolean') throw ERR.Value;
  if (v instanceof CellError) throw v;
  return null;
}

/** database.rs `cell_criterion`: plain text becomes a "begins with" pattern. */
function cellCriterion(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const hasOp = /^[=<>]/.test(v);
    const plain = !hasOp && parseNumberText(v) === null && !/^true$/i.test(v) && !/^false$/i.test(v) && !parseError(v);
    return plain && !v.endsWith('*') ? Criterion.parse(`${v}*`) : Criterion.parse(v);
  }
  return Criterion.parse(v);
}

/** database.rs `matching_records`: rows (1-based within the database) of the matching records. */
function matchingRecords(db, crit, ctx) {
  const rows = [];
  for (let r = 1; r < crit.rows; r++) {
    const conds = [];
    for (let c = 0; c < crit.cols; c++) {
      const cr = cellCriterion(crit.get(r, c));
      if (!cr) continue;
      const h = crit.get(0, c);
      const col = typeof h === 'string' ? findColumn(db, h) : typeof h === 'number' ? findColumn(db, numberToText(h)) : null;
      conds.push([c, col, cr]);
    }
    rows.push([r, conds]);
  }
  const all = rows.length === 0;
  const out = [];
  for (let rec = 1; rec < db.rows; rec++) {
    if (all || rows.some(([r, conds]) => conds.every(([c, col, cr]) => (col !== null
      ? cr.matches(db.get(rec, col) ?? null)
      : (ctx?.computedCriterion?.(r, c, db, rec) ?? false))))) out.push(rec);
  }
  return out;
}

function select(args, ctx) {
  const dbv = args[0]?.value, critv = args[2]?.value;
  if (args.length < 3) throw ERR.Value;
  if (dbv instanceof CellError) throw dbv;
  if (critv instanceof CellError) throw critv;
  const db = asArray(dbv), crit = asArray(critv);
  const field = fieldIndex(db, args);
  return {db, field, records: matchingRecords(db, crit, ctx)};
}

/** The numbers of the field among the matching records (a field is required). */
function fieldNumbers(args, ctx) {
  const s = select(args, ctx);
  if (s.field === null) throw ERR.Value;
  const out = [];
  for (const r of s.records) { const v = s.db.get(r, s.field); if (typeof v === 'number') out.push(v); }
  return out;
}

function variance(v, sample) {
  const n = v.length;
  if (n < (sample ? 2 : 1)) throw ERR.Div0;
  const mean = v.reduce((x, y) => x + y, 0) / n;
  const ss = v.reduce((x, y) => x + (y - mean) * (y - mean), 0);
  return ss / (sample ? n - 1 : n);
}

const dsum = (a, c) => numVal(fieldNumbers(a, c).reduce((x, y) => x + y, 0));
function daverage(a, c) { const v = fieldNumbers(a, c); if (!v.length) throw ERR.Div0; return numVal(v.reduce((x, y) => x + y, 0) / v.length); }
function dcount(a, c) {
  const s = select(a, c);
  return s.field === null ? s.records.length : s.records.filter(r => typeof s.db.get(r, s.field) === 'number').length;
}
function dcounta(a, c) {
  const s = select(a, c);
  return s.field === null ? s.records.length : s.records.filter(r => { const v = s.db.get(r, s.field); return v !== null && v !== undefined; }).length;
}
function dget(a, c) {
  const s = select(a, c);
  if (s.field === null) throw ERR.Value;
  // Records whose field is blank (or "") don't count, as in Excel.
  const found = s.records.map(r => s.db.get(r, s.field)).filter(v => v !== null && v !== undefined && v !== '');
  if (!found.length) throw ERR.Value;
  if (found.length > 1) throw ERR.Num;
  return found[0];
}
function dmax(a, c) { const v = fieldNumbers(a, c); return numVal(v.length ? Math.max(...v) : 0); }
function dmin(a, c) { const v = fieldNumbers(a, c); return numVal(v.length ? Math.min(...v) : 0); }
function dproduct(a, c) { const v = fieldNumbers(a, c); return v.length ? numVal(v.reduce((x, y) => x * y, 1)) : 0; }
const dvar = (a, c) => numVal(variance(fieldNumbers(a, c), true));
const dvarp = (a, c) => numVal(variance(fieldNumbers(a, c), false));
const dstdev = (a, c) => numVal(Math.sqrt(variance(fieldNumbers(a, c), true)));
const dstdevp = (a, c) => numVal(Math.sqrt(variance(fieldNumbers(a, c), false)));

export const specs = [
  f('DSUM', 3, 3, 'Database', A, 'DSUM(database, field, criteria)', 'Adds the numbers in a field of the records that meet the criteria.', dsum),
  f('DAVERAGE', 3, 3, 'Database', A, 'DAVERAGE(database, field, criteria)', 'Averages the numbers in a field of the records that meet the criteria.', daverage),
  f('DCOUNT', 3, 3, 'Database', A, 'DCOUNT(database, [field], criteria)', 'Counts numeric cells in a field of the matching records (or the matching records).', dcount),
  f('DCOUNTA', 3, 3, 'Database', A, 'DCOUNTA(database, [field], criteria)', 'Counts non-blank cells in a field of the matching records (or the matching records).', dcounta),
  f('DGET', 3, 3, 'Database', A, 'DGET(database, field, criteria)', 'Extracts the single value of a field that matches the criteria.', dget),
  f('DMAX', 3, 3, 'Database', A, 'DMAX(database, field, criteria)', 'Largest number in a field of the records that meet the criteria.', dmax),
  f('DMIN', 3, 3, 'Database', A, 'DMIN(database, field, criteria)', 'Smallest number in a field of the records that meet the criteria.', dmin),
  f('DPRODUCT', 3, 3, 'Database', A, 'DPRODUCT(database, field, criteria)', 'Multiplies the numbers in a field of the records that meet the criteria.', dproduct),
  f('DSTDEV', 3, 3, 'Database', A, 'DSTDEV(database, field, criteria)', 'Sample standard deviation of a field of the matching records.', dstdev),
  f('DSTDEVP', 3, 3, 'Database', A, 'DSTDEVP(database, field, criteria)', 'Population standard deviation of a field of the matching records.', dstdevp),
  f('DVAR', 3, 3, 'Database', A, 'DVAR(database, field, criteria)', 'Sample variance of a field of the matching records.', dvar),
  f('DVARP', 3, 3, 'Database', A, 'DVARP(database, field, criteria)', 'Population variance of a field of the matching records.', dvarp),
];
register(specs);
