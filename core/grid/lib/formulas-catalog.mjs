// The function catalogue the Formulas tab, Insert Function and Function Arguments show: every
// registered worksheet function plus the evaluator's special forms, their categories, signatures
// split into arguments, and the Most Recently Used list.
// Translated from gridcraft crates/engine/src/cmd/formulas.rs (`function_list` and its `specials`
// table) and crates/ui-egui/src/dialogs/insert_function.rs (`function_category_label`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Insert Function's category list and the default Most Recently Used functions follow Excel.
// U:grid/formulas owns this file; other units may import it. No DOM, no Node built-ins.

import {all} from '../model/functions/index.mjs';
import './formulas-functions.mjs';

/** formulas.rs `function_list` specials: functions the evaluator implements itself. */
const SPECIALS = [
  ['IF', 'Logical', 'IF(logical_test, [value_if_true], [value_if_false])', "Returns one value if a condition is true and another if it's false."],
  ['IFS', 'Logical', 'IFS(test1, value1, ...)', 'Returns the value of the first true condition.'],
  ['IFERROR', 'Logical', 'IFERROR(value, value_if_error)', 'Returns a fallback when a value is an error.'],
  ['IFNA', 'Logical', 'IFNA(value, value_if_na)', 'Returns a fallback when a value is #N/A.'],
  ['CHOOSE', 'Lookup', 'CHOOSE(index_num, value1, [value2], ...)', 'Picks a value from a list by position.'],
  ['SWITCH', 'Logical', 'SWITCH(expression, value1, result1, ..., [default])', 'Matches a value against a list of cases.'],
  ['ROW', 'Lookup', 'ROW([reference])', 'Row number of a reference.'],
  ['COLUMN', 'Lookup', 'COLUMN([reference])', 'Column number of a reference.'],
  ['ROWS', 'Lookup', 'ROWS(array)', 'Number of rows in a reference or array.'],
  ['COLUMNS', 'Lookup', 'COLUMNS(array)', 'Number of columns in a reference or array.'],
  ['OFFSET', 'Lookup', 'OFFSET(reference, rows, cols, [height], [width])', 'A reference shifted from a starting point.'],
  ['INDIRECT', 'Lookup', 'INDIRECT(ref_text, [a1])', 'The reference named by a text string.'],
  ['INDEX', 'Lookup', 'INDEX(array, row_num, [column_num], [area_num])', 'The value or reference at a position.'],
  ['SUBTOTAL', 'MathTrig', 'SUBTOTAL(function_num, ref1, ...)', 'A subtotal that can skip hidden rows.'],
  ['AGGREGATE', 'MathTrig', 'AGGREGATE(function_num, options, ref1, ...)', 'An aggregate that can skip hidden rows and errors.'],
  ['TEXT', 'Text', 'TEXT(value, format_text)', 'Formats a number as text.'],
  ['LET', 'Logical', 'LET(name1, value1, ..., calculation)', 'Names intermediate results.'],
  ['LAMBDA', 'Logical', 'LAMBDA([parameter1, ...], calculation)', 'Creates a reusable custom function.'],
  ['MAP', 'Logical', 'MAP(array1, ..., lambda)', 'Applies a LAMBDA to each value.'],
  ['REDUCE', 'Logical', 'REDUCE(initial_value, array, lambda)', 'Accumulates an array into one value.'],
  ['SCAN', 'Logical', 'SCAN(initial_value, array, lambda)', 'Running accumulation of an array.'],
  ['BYROW', 'Logical', 'BYROW(array, lambda)', 'Applies a LAMBDA to each row.'],
  ['BYCOL', 'Logical', 'BYCOL(array, lambda)', 'Applies a LAMBDA to each column.'],
  ['MAKEARRAY', 'Logical', 'MAKEARRAY(rows, cols, lambda)', 'Builds an array from a LAMBDA.'],
  ['CELL', 'Information', 'CELL(info_type, [reference])', 'Information about a cell.'],
  ['ISREF', 'Information', 'ISREF(value)', 'TRUE for references.'],
  ['ISFORMULA', 'Information', 'ISFORMULA(reference)', 'TRUE when the cell has a formula.'],
  ['FORMULATEXT', 'Lookup', 'FORMULATEXT(reference)', 'The formula of a cell as text.'],
  ['SHEET', 'Information', 'SHEET([value])', 'Sheet number.'],
  ['SHEETS', 'Information', 'SHEETS([reference])', 'Number of sheets.'],
  ['AREAS', 'Lookup', 'AREAS(reference)', 'Number of areas in a reference.'],
  ['TRIMRANGE', 'Lookup', 'TRIMRANGE(range, [trim_rows], [trim_cols])', 'A range or array without its blank outer rows and columns.'],
  ['ISOMITTED', 'Information', 'ISOMITTED(argument)', 'TRUE when a LAMBDA argument was left out.'],
];

let cached = null, cachedCount = -1;
/** formulas.rs `function_list`: [{name, category, signature, description}] sorted by name. */
export function functionList() {
  const specs = all();
  if (cached && cachedCount === specs.length) return cached;
  const v = specs.map(f => ({name: f.name, category: f.category, signature: f.signature, description: f.description}));
  const have = new Set(v.map(f => f.name));
  for (const [name, category, signature, description] of SPECIALS) if (!have.has(name)) v.push({name, category, signature, description});
  v.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  cached = Object.freeze(v.map(Object.freeze));
  cachedCount = specs.length;
  return cached;
}
/** One function's catalogue entry (case-insensitive), or null. */
export function functionInfo(name) {
  const n = String(name ?? '').toUpperCase().replace(/^_XLFN\./, '');
  return functionList().find(f => f.name === n) ?? null;
}

/** insert_function.rs `function_category_label`: Excel's name for a catalogue category. */
export function categoryLabel(id) {
  switch (id) {
    case 'DateTime': return 'Date & Time';
    case 'Lookup': return 'Lookup & Reference';
    case 'MathTrig': return 'Math & Trig';
    case 'AddIn': return 'Add-in and Automation';
    default: return id;
  }
}
/** Insert Function's "Or select a category" list (Excel). */
export const INSERT_FUNCTION_CATEGORIES = Object.freeze(['Most Recently Used', 'All', 'Financial', 'Date & Time', 'Math & Trig', 'Statistical',
  'Lookup & Reference', 'Database', 'Text', 'Logical', 'Information', 'Engineering', 'Cube', 'Compatibility', 'Web']);
const LABEL_TO_ID = {'Date & Time': 'DateTime', 'Lookup & Reference': 'Lookup', 'Math & Trig': 'MathTrig', 'Add-in and Automation': 'AddIn'};
export const categoryId = label => LABEL_TO_ID[label] ?? label;

/** Excel's Most Recently Used list before anything is inserted. */
export const DEFAULT_RECENT = Object.freeze(['SUM', 'AVERAGE', 'IF', 'HYPERLINK', 'COUNT', 'MAX', 'SIN', 'SUMIF', 'PMT', 'STDEV']);
export const RECENT_LIMIT = 10;
/** The Most Recently Used functions (prefs, newest first). */
export const recentFunctions = prefs => (Array.isArray(prefs?.gridRecentFunctions) ? prefs.gridRecentFunctions : DEFAULT_RECENT);
/** Puts `name` first in the Most Recently Used list. */
export function recordRecent(ctx, name) {
  if (typeof ctx.updatePrefs !== 'function') return;
  const list = recentFunctions(ctx.prefs).filter(n => n !== name);
  ctx.updatePrefs({gridRecentFunctions: [name, ...list].slice(0, RECENT_LIMIT)});
}

/**
 * The functions Insert Function lists for a category label and search text (Excel: search wins).
 * @param {{category?: string, search?: string, prefs?: {gridRecentFunctions?: string[]} | null}} [o]
 */
export function functionsFor({category = 'Most Recently Used', search = '', prefs = null} = {}) {
  const list = functionList();
  const q = String(search).trim().toLowerCase();
  if (q) return list.filter(f => f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)).slice(0, 300);
  if (category === 'Most Recently Used') return recentFunctions(prefs).map(functionInfo).filter(Boolean);
  if (category === 'All') return list;
  const id = categoryId(category);
  return list.filter(f => f.category === id);
}

/**
 * The arguments of a signature `VLOOKUP(lookup_value, table_array, [range_lookup])`:
 * [{name, optional, repeat}] where `repeat` marks `...` (more like the one before).
 */
export function signatureArgs(signature) {
  const m = /\((.*)\)\s*$/.exec(String(signature ?? ''));
  if (!m || !m[1].trim()) return [];
  const out = [];
  for (let part of m[1].split(',')) {
    part = part.trim();
    if (!part) continue;
    if (part === '...' || part === '[...]' || /^\.\.\.$/.test(part)) { if (out.length) out[out.length - 1].repeat = true; continue; }
    const optional = part.startsWith('[') && part.endsWith(']');
    out.push({name: optional ? part.slice(1, -1).trim() : part, optional, repeat: false});
  }
  return out;
}
