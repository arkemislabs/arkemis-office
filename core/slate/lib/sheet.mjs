// The embedded spreadsheet of a page (Insert > Files > Spreadsheet, Table Layout > Convert to Spreadsheet; U:slate/rest).
//
// OneNote embeds an Excel worksheet. The app has no Excel, so the page holds a small worksheet of its
// own: a rectangle of cells whose text is typed as in a worksheet (a number, text, or a formula that
// starts with =), calculated by the spreadsheet engine of this suite (core/grid: the same parser,
// functions and number formats as the Grid app, imported and not edited). Not checked against
// upstream (there is none).
//
// A spreadsheet node stores what was typed (`cells`: {A1: "=SUM(B1:B3)"}) and, beside it, what each
// cell shows (`shown`: {A1: "6"}), written whenever a cell changes, so the page draws it without the
// engine. Formulas that refer to a cell outside the rectangle read it as empty.
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {createWorkbook, inputToCell, engineFor, displayAt, cellAt, usedBounds} from '../../grid/model/index.mjs';
import {blockOf} from '../../grid/model/store.mjs';
import {colToLetters, lettersToCol} from '../../grid/lib/addr.mjs';

export const SHEET_MAX_ROWS = 100;
export const SHEET_MAX_COLS = 26;
export const SHEET_MAX_TEXT = 500;
export const SHEET_DEFAULT = Object.freeze({rows: 6, cols: 5});

/** The text of cell (row, col), zero-based: "A1". */
export const refOf = (row, col) => `${colToLetters(col)}${row + 1}`;
/** {row, col} of "A1" (zero-based), or null when it is not a cell name. */
export function parseRef(ref) {
  const m = /^([A-Z]{1,2})([1-9]\d{0,2})$/.exec(String(ref ?? '').toUpperCase());
  return m ? {row: Number(m[2]) - 1, col: lettersToCol(m[1])} : null;
}

/** A change object over a bare workbook content, so typing a formula can intern its number format. */
function stubChange(content) {
  const read = path => content[path[0]];
  return {
    get: read,
    set(path, value) { content[path[0]] = value; },
    splice(path, at, del, ...items) { content[path[0]].splice(at, del, ...items); },
  };
}

/** What each cell of a sheet shows: {A1: "6"} for the cells that hold something. Throws `failed` for a formula that cannot be read. */
export function showCells({rows, cols, cells}) {
  const content = createWorkbook(() => 'sheet1');
  const change = stubChange(content);
  const sheet = content.sheets[0];
  const refs = [];
  for (const [ref, raw] of Object.entries(cells ?? {})) {
    const at = parseRef(ref);
    if (!at || at.row >= rows || at.col >= cols || raw === '' || raw === undefined || raw === null) continue;
    let cell;
    try { cell = inputToCell(change, content, 0, at.row, at.col, String(raw)); } catch (e) { throw new CommandError('invalid_params', `${ref}: ${e?.message ?? e}`, {path: `/cells/${ref}`}); }
    if (!cell) continue;
    ((sheet.blocks[blockOf(at.row)] ??= {})[ref] = cell);
    refs.push([ref, at]);
  }
  const engine = engineFor(content);
  const shown = {};
  for (const [ref, at] of refs) {
    const text = displayAt(content, 0, at.row, at.col, engine.sheetValue(0, at.row, at.col)).text;
    if (text !== '') shown[ref] = text;
  }
  return shown;
}

/** Clean the cells of a sheet: known names inside the rectangle, text only, no longer than a cell holds. */
export function cleanCells({rows, cols, cells}) {
  const out = {};
  for (const [ref, raw] of Object.entries(cells ?? {})) {
    const at = parseRef(ref);
    if (!at || at.row >= rows || at.col >= cols) continue;
    const text = String(raw ?? '').slice(0, SHEET_MAX_TEXT);
    if (text !== '') out[refOf(at.row, at.col)] = text;
  }
  return out;
}

/** The attributes of a spreadsheet node from its size and typed cells (what each cell shows is calculated). */
export function sheetAttrs({rows = SHEET_DEFAULT.rows, cols = SHEET_DEFAULT.cols, cells = {}, title = ''} = {}) {
  const r = Math.max(1, Math.min(SHEET_MAX_ROWS, Math.round(rows)));
  const c = Math.max(1, Math.min(SHEET_MAX_COLS, Math.round(cols)));
  const typed = cleanCells({rows: r, cols: c, cells});
  return {rows: r, cols: c, cells: typed, shown: showCells({rows: r, cols: c, cells: typed}), title: String(title ?? '').slice(0, 120)};
}

/** The sheet with one cell typed (an empty text clears it). */
export function withCell(attrs, ref, text) {
  const at = parseRef(ref);
  if (!at || at.row >= attrs.rows || at.col >= attrs.cols) throw new CommandError('invalid_params', `${ref} is outside this spreadsheet (A1 to ${refOf(attrs.rows - 1, attrs.cols - 1)})`, {path: '/ref'});
  const cells = {...attrs.cells};
  const t = String(text ?? '');
  if (t.length > SHEET_MAX_TEXT) throw new CommandError('invalid_params', `A cell holds at most ${SHEET_MAX_TEXT} characters`, {path: '/text'});
  if (t === '') delete cells[refOf(at.row, at.col)]; else cells[refOf(at.row, at.col)] = t;
  return sheetAttrs({...attrs, cells});
}

/** What a worksheet file's first sheet holds: {rows, cols, cells} with formulas as typed (=...), at most the size a page spreadsheet holds. */
export function cellsOfWorkbook(content) {
  const sheet = content.sheets?.[0];
  const used = sheet ? usedBounds(sheet) : null;
  if (!used) return {rows: SHEET_DEFAULT.rows, cols: SHEET_DEFAULT.cols, cells: {}, clipped: false};
  const cells = {};
  const engine = engineFor(content);
  const rows = Math.min(SHEET_MAX_ROWS, used.r1 + 1), cols = Math.min(SHEET_MAX_COLS, used.c1 + 1);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cell = cellAt(sheet, r, c);
    if (!cell) continue;
    let raw = '';
    if (cell.f !== undefined) raw = `=${cell.f}`;
    else {
      const v = engine.sheetValue(0, r, c);
      raw = v === null || v === undefined ? '' : typeof v === 'object' ? displayAt(content, 0, r, c, v).text : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
      // Text that would read back as a number or formula keeps its apostrophe.
      if (typeof v === 'string' && /^[=+\-@]/.test(raw)) raw = `'${raw}`;
    }
    if (raw !== '') cells[refOf(r, c)] = raw.slice(0, SHEET_MAX_TEXT);
  }
  return {rows: Math.max(rows, 1), cols: Math.max(cols, 1), cells, clipped: used.r1 + 1 > SHEET_MAX_ROWS || used.c1 + 1 > SHEET_MAX_COLS};
}

/** A table of text (rows of cells) as a spreadsheet's size and cells. */
export function cellsOfRows(rowsOfText) {
  const cells = {};
  const rows = Math.min(SHEET_MAX_ROWS, rowsOfText.length), cols = Math.min(SHEET_MAX_COLS, Math.max(1, ...rowsOfText.map(r => r.length)));
  for (let r = 0; r < rows; r++) for (let c = 0; c < Math.min(cols, rowsOfText[r].length); c++) {
    const t = String(rowsOfText[r][c] ?? '').trim();
    if (t) cells[refOf(r, c)] = t.slice(0, SHEET_MAX_TEXT);
  }
  return {rows: Math.max(rows, 1), cols, cells};
}
