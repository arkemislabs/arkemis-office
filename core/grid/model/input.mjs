// What typing into a cell stores: a constant or a formula, with the automatic number format, the
// Alt+Enter wrap and Excel's percent entry; and the writes that put it in the workbook.
// Translated from gridcraft crates/engine/src/cmd/edit/cell.rs (`input_to_cell`,
// `parse_typed_formula`, `check_arg_counts`, `json_to_input`) and crates/model/src/workbook.rs
// (`name_call_case`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Command units (U:grid/edit `cell.set`, `range.setValues`) call `inputToCell` + `putCell`
// through ctx.model; the surface never writes cells itself. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {parse, parseClosingParens, print, walk, mapExpr, FormulaError} from '../lib/formula.mjs';
import {parseInput, parseNumberText} from '../lib/parse.mjs';
import {toJSONValue, fromJSONValue, display, CellError} from '../lib/value.mjs';
import {parseFormat, formatValue} from '../lib/numfmt.mjs';
import {datetimeFromSerial} from '../lib/date.mjs';
import {lookup, accepts} from './functions/index.mjs';
import {resolveStyle, styleById, deriveStyle} from './style.mjs';
import {styleIdAt} from './workbook.mjs';
import {writeCell, writeLegacyCell, isLegacySheet, cellAt} from './store.mjs';
import {a1} from '../lib/addr.mjs';

const failed = message => new CommandError('failed', message);

/** Parses a formula as it is typed (without the `=`), closing missing parentheses as Excel does. */
export function parseTypedFormula(body) {
  try { return parseClosingParens(body, parse); } catch (e) {
    throw failed(`There's a problem with this formula: ${e instanceof FormulaError ? e.message : String(e?.message ?? e)}`);
  }
}

/**
 * Like Excel, a formula that calls a built-in function with too few or too many arguments is
 * refused when it's entered, rather than stored to show #VALUE!.
 */
export function checkArgCounts(expr) {
  let bad = null;
  walk(expr, e => {
    if (bad || e.t !== 'call') return;
    const spec = lookup(e.name);
    if (spec && !accepts(spec, e.args.length)) {
      const few = e.args.length < spec.minArgs;
      bad = `${spec.name} has too ${few ? 'few' : 'many'} arguments. Use ${spec.signature}`;
    }
  });
  if (bad) throw failed(bad);
}

/** Calls to a defined LAMBDA name take the name's own case (Workbook::name_call_case). */
export function nameCallCase(content, expr) {
  const names = content?.names ?? [];
  if (!names.length) return expr;
  return mapExpr(expr, e => {
    if (e.t !== 'call' || lookup(e.name)) return e;
    const n = names.find(x => x.name.toLowerCase() === String(e.name).toLowerCase());
    return n && n.name !== e.name ? {...e, name: n.name} : e;
  });
}

/** A JSON param as typed input (both `input` and `value` spellings take string, number or boolean). */
export function jsonToInput(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

const AUTO_FORMULA_FORMATS = [
  [/^(TODAY|DATE|EDATE|EOMONTH|WORKDAY)\(/, 'm/d/yyyy'],
  [/^NOW\(/, 'm/d/yyyy h:mm'],
  [/^TIME\(/, 'h:mm AM/PM'],
];

/**
 * What typing `input` into (si, row, col) produces: a stored cell {v?, f?, s?} or null (blank).
 * Inherits the destination's cell, row or column style, including its number format, before
 * parsing; new styles are interned through `change`. Throws `failed` when the formula can't be
 * parsed or calls a function with the wrong number of arguments.
 */
export function inputToCell(change, content, si, row, col, input) {
  const sheet = content.sheets[si];
  let style = styleIdAt(sheet, row, col);
  const fmtOf = id => resolveStyle(styleById({styles: change?.get?.(['styles']) ?? content.styles}, id)).numFmt;
  if (input === '') return style ? {s: style} : null;
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  if (fmtOf(style) === '@') return {v: input, ...(style ? {s: style} : {})};
  const isFormula = input.startsWith('=')
    || (input.length > 1 && (input[0] === '+' || input[0] === '-') && parseNumberText(input) === null && /^[A-Za-z(]$/.test(input[1]));
  if (isFormula) {
    const body = input.startsWith('=') ? input.slice(1) : input;
    const expr = nameCallCase(content, parseTypedFormula(body));
    checkArgCounts(expr);
    const cell = {f: print(expr)};
    if (fmtOf(style) === 'General') {
      const text = cell.f.toUpperCase();
      const auto = AUTO_FORMULA_FORMATS.find(([re]) => re.test(text));
      if (auto) style = deriveStyle(change, content, style, {numFmt: auto[1]});
    }
    if (style) cell.s = style;
    return cell;
  }
  const parsed = parseInput(input, sys);
  let value = parsed.value;
  // Excel's automatic percent entry: 3 typed into a percent cell is 3%; smaller numbers are fractions.
  if (!parsed.format && !input.includes('%') && fmtOf(style).endsWith('%') && typeof value === 'number' && Math.abs(value) >= 1) value /= 100;
  if (parsed.format && fmtOf(style) === 'General') style = deriveStyle(change, content, style, {numFmt: parsed.format});
  // Wrap text automatically when the input has line breaks (Alt+Enter).
  const cur = resolveStyle(styleById({styles: change?.get?.(['styles']) ?? content.styles}, style));
  if (input.includes('\n') && !cur.align.wrap) style = deriveStyle(change, content, style, {align: {wrap: true}});
  const cell = {};
  if (value !== null && value !== undefined) cell.v = value instanceof CellError ? toJSONValue(value) : value;
  if (style) cell.s = style;
  return Object.keys(cell).length ? cell : null;
}

/**
 * Stores a cell (null removes it) at (si, row, col) through the change API. Schema-1 sheets keep
 * schema 1: the input text and inline style keys of the existing cell.
 */
export function putCell(change, content, si, row, col, cell, input) {
  const sheet = content.sheets[si];
  if (isLegacySheet(sheet)) {
    const old = sheet.cells[a1(row, col)];
    if (!cell && (!old || Object.keys(old).length <= 1)) { if (old) writeLegacyCell(change, si, row, col, null); return; }
    const text = input ?? (cell?.f !== undefined ? `=${cell.f}` : cell?.v === undefined ? '' : String(cell.v));
    writeLegacyCell(change, si, row, col, {...(old ?? {}), value: text});
    return;
  }
  writeCell(change, content, si, row, col, cell);
}

/** Types `input` into one cell (cell.set without the array form). Returns the stored cell. */
export function enterInput(change, content, si, row, col, input) {
  const cell = inputToCell(change, content, si, row, col, input);
  putCell(change, content, si, row, col, cell, input);
  return cell;
}

/** Text that would read back as something else is edited with an apostrophe (display.rs). */
export function textNeedsQuotePrefix(t, sys = 1900) {
  if (!t) return false;
  if (t[0] === '=' || t[0] === "'") return true;
  if ((t[0] === '+' || t[0] === '-') && t.length > 1 && /^[A-Za-z(]$/.test(t[1])) return true;
  const v = parseInput(t, sys).value;
  return !(typeof v === 'string' && v === t);
}

/**
 * The text the cell editor starts from (gridcraft display.rs `edit_text` over cell.rs
 * `input_text`): `=formula`, text (with an apostrophe when it would read as something else),
 * dates in their shown form when that reads back (else ISO), other values as typed.
 */
export function editText(content, si, row, col) {
  const sheet = content.sheets[si];
  const c = cellAt(sheet, row, col);
  if (!c) return '';
  if (c.f !== undefined) return `=${c.f}`;
  const sys = content.dateSystem === 1904 ? 1904 : 1900;
  const v = fromJSONValue(c.v);
  const code = c.style ? resolveStyle(c.style).numFmt : c.autoFmt && !c.s ? c.autoFmt : resolveStyle(styleById(content, c.s ?? 0)).numFmt;
  if (typeof v === 'string') return code !== '@' && textNeedsQuotePrefix(v, sys) ? `'${v}` : v;
  if (typeof v !== 'number') return v === null || v === undefined ? '' : display(v);
  const raw = display(v);
  const fmt = parseFormat(code);
  if (!fmt.isDate()) return raw;
  const readsBack = text => { const p = parseInput(text, sys).value; return typeof p === 'number' && Math.abs(p - v) < 1e-9; };
  const shown = formatValue(v, code, sys).text;
  if (readsBack(shown)) return shown;
  const dt = datetimeFromSerial(sys, v);
  if (!dt) return raw;
  const p2 = n => String(n).padStart(2, '0');
  const time = `${p2(dt.hour)}:${p2(dt.minute)}:${p2(dt.second)}`, date = `${String(dt.year).padStart(4, '0')}-${p2(dt.month)}-${p2(dt.day)}`;
  const iso = v < 1 ? time : Number.isInteger(v) ? date : `${date} ${time}`;
  return readsBack(iso) ? iso : raw;
}
