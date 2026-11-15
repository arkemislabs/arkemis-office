// The cell editor's text model: formula reference spans and colours, pointing (inserting a
// reference by clicking or with the arrow keys while typing a formula), function autocomplete and
// the argument hint.
// Translated from gridcraft crates/ui-egui/src/editor.rs (`EditState::is_formula`, `can_point`,
// `point_at_caret`, `insert_ref`, `append_ref`, `update_autocomplete`, `accept_autocomplete`,
// `current_function`, `formula_refs`, `ref_is_on_sheet`, `completion_rest`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Offsets are UTF-16 code units (the browser's caret units) instead of upstream's byte and char
// offsets. The state is a plain object; every function returns a new one. No DOM, no Node built-ins.

import {tokenize} from './formula.mjs';
import {parseRange, parseCell} from './addr.mjs';

export const REF_COLOR_COUNT = 8;
/** Reference colours on the sheet and in the editor (theme.rs SHEET_REF_COLORS). */
export const SHEET_REF_COLORS = Object.freeze(['#2E6FD8', '#D03C3C', '#7A4FC9', '#23803D', '#B5531A', '#16798A', '#B83B8E', '#77681A']);

/**
 * A new edit (`caret` defaults to the end of the text).
 * @param {{sheet: number, cell: {row: number, col: number}, text?: string, enterMode?: boolean, fromFormulaBar?: boolean, caret?: number}} o
 * `enterMode`: started by typing (arrow keys commit and move); otherwise Edit mode
 * (F2, double-click, formula bar: arrows move the caret).
 */
export function editState({sheet, cell, text = '', enterMode = false, fromFormulaBar = false, caret}) {
  return {sheet, cell: {...cell}, text, caret: caret ?? text.length, enterMode, fromFormulaBar, point: null, autocomplete: [], acIndex: 0};
}

export const isFormula = st => st.text.startsWith('=') || ((st.text.startsWith('+') || st.text.startsWith('-')) && st.text.length > 1 && /^[A-Za-z(]$/.test(st.text[1]));

/** The reference last pointed ends at the caret. */
export const pointAtCaret = st => !!st.point && st.point[1] === st.caret && st.point[0] <= st.text.length && st.point[1] <= st.text.length;

/** Whether a click or an arrow key now inserts a reference instead of committing. */
export function canPoint(st) {
  if (!isFormula(st)) return false;
  if (pointAtCaret(st)) return true;
  const before = st.text.slice(0, st.caret).trimEnd();
  const last = before[before.length - 1];
  return last !== undefined && '=(,+-*/^&<>:;{'.includes(last);
}

/** Inserts (or replaces the last pointed) reference text at the caret. */
export function insertRef(st, r) {
  const [start, end] = st.point && st.point[1] === st.caret ? st.point : [st.caret, st.caret];
  const text = st.text.slice(0, start) + r + st.text.slice(end);
  const newEnd = start + r.length;
  return {...st, text, point: [start, newEnd], caret: newEnd};
}
/** Ctrl+click while pointing: adds another reference after a list separator. */
export function appendRef(st, r) {
  const sep = pointAtCaret(st) ? ',' : '';
  const next = insertRef({...st, point: null}, sep + r);
  return {...next, point: [next.point[0] + sep.length, next.point[1]]};
}

/** Typing or moving the caret: the text and caret change, pointing ends. */
export const setText = (st, text, caret = text.length) => ({...st, text, caret: Math.max(0, Math.min(caret, text.length)), point: st.point && st.point[1] === caret && text === st.text ? st.point : null});

const WORD_CHAR = /[A-Za-z0-9._]/;
function wordBefore(text, caret) {
  let i = caret;
  while (i > 0 && WORD_CHAR.test(text[i - 1])) i--;
  return [i, text.slice(i, caret)];
}

/** Function autocomplete for the word before the caret (`names` upper-case, sorted). */
export function updateAutocomplete(st, names) {
  if (!isFormula(st)) return {...st, autocomplete: [], acIndex: 0};
  const [, word] = wordBefore(st.text, st.caret);
  if (!word || /^[0-9]/.test(word)) return {...st, autocomplete: [], acIndex: 0};
  // Inside a text literal nothing completes.
  if ((st.text.slice(0, st.caret).match(/"/g) ?? []).length % 2 === 1) return {...st, autocomplete: [], acIndex: 0};
  const u = word.toUpperCase();
  let list = names.filter(n => n.startsWith(u)).slice(0, 12);
  if (list.length === 1 && list[0] === u) list = [];
  return {...st, autocomplete: list, acIndex: Math.min(st.acIndex, Math.max(0, list.length - 1))};
}

/** Accepts the highlighted autocomplete entry: replaces the word and adds `(`. */
export function acceptAutocomplete(st) {
  const name = st.autocomplete[st.acIndex];
  if (!name) return null;
  const [start] = wordBefore(st.text, st.caret);
  const text = `${st.text.slice(0, start)}${name}(${st.text.slice(st.caret)}`;
  return {...st, text, caret: start + name.length + 1, autocomplete: [], acIndex: 0, point: null};
}

/** The function call the caret is inside and the argument index (for the hint tooltip). */
export function currentFunction(st) {
  if (!isFormula(st)) return null;
  const before = st.text.slice(0, st.caret);
  let depth = 0, arg = 0, inStr = false;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === ')' || c === '}' || c === ']') depth++;
    else if (c === '{' || c === '[') depth--;
    else if (c === '(') {
      if (depth === 0) {
        const [, name] = wordBefore(before, i);
        return name ? {name: name.toUpperCase(), arg} : null;
      }
      depth--;
    } else if (c === ',' && depth === 0) arg++;
  }
  return null;
}

/**
 * References in formula text with their spans and colour index (same reference text, same
 * colour): [{start, end, range, sheet, color}], for colouring the editor and outlining ranges.
 */
export function formulaRefs(text) {
  const body = text.startsWith('=') || text.startsWith('+') ? text.slice(1) : text;
  const offset = text.length - body.length;
  let toks;
  try { toks = tokenize(body); } catch { return []; }
  const out = [], seen = [];
  let i = 0;
  while (i < toks.length) {
    const sheetTok = toks[i].tok === 'sheet' ? toks[i] : null;
    const start = toks[i].start, j = sheetTok ? i + 1 : i;
    const w = toks[j];
    if (w && w.tok === 'word') {
      let range = null, end = 0;
      const nx = toks[j + 1];
      if (nx && (nx.tok === 'colon' || nx.tok === 'trim')) {
        const t2 = toks[j + 2];
        const e2 = t2?.tok === 'word' ? t2.v : t2?.tok === 'num' && Number.isInteger(t2.v) && t2.v >= 1 ? String(t2.v) : null;
        const r = e2 !== null ? parseRange(`${String(w.v).replace(/\$/g, '')}:${e2.replace(/\$/g, '')}`) : null;
        if (r) { range = r; end = t2.end; i = j + 3; }
      }
      if (!range) {
        const c = parseCell(String(w.v).replace(/\$/g, ''));
        if (c) { range = {start: c, end: {...c}}; end = w.end; i = j + 1; }
      }
      if (!range) { i++; continue; }
      const key = body.slice(start, end).replace(/\$/g, '').toUpperCase();
      let idx = seen.indexOf(key);
      if (idx < 0) { seen.push(key); idx = seen.length - 1; }
      out.push({start: start + offset, end: end + offset, range, sheet: sheetTok ? sheetTok.v : null, color: idx % REF_COLOR_COUNT});
      continue;
    }
    i++;
  }
  return out;
}

/** A reference with a sheet name is on that sheet; one without is on the sheet the edit started on. */
export const refIsOnSheet = (refSheet, origin, shown) => String(refSheet ?? origin).toLowerCase() === String(shown).toLowerCase();

/** AutoComplete for text: the rest of `full` after `typed` when `full` starts with it (case-insensitive). */
export function completionRest(full, typed) {
  if (!typed || full.length <= typed.length) return null;
  return full.toLowerCase().startsWith(typed.toLowerCase()) ? full.slice(typed.length) : null;
}
