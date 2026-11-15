// Cell and range addresses, sheet-name quoting, legacy indexed colours.
// Translated from gridcraft crates/core/src/addr.rs and crates/core/src/color.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Rows and columns are 0-based (A1 = row 0, col 0). The sheet is 1,048,576 rows by 16,384
// columns (XFD1048576), like Excel. A cell is `{row, col}`; a range `{start, end}` is always
// normalised (start <= end). No DOM, no Node built-ins.

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

/** A cell position (0-based). */
export const cellRef = (row, col) => ({row, col});
export const isValidCell = c => c.row >= 0 && c.col >= 0 && c.row < MAX_ROWS && c.col < MAX_COLS;
/** One integer per cell (row-major), safe in a double: row * MAX_COLS + col. */
export const cellKey = (row, col) => row * MAX_COLS + col;
export const keyRow = key => Math.floor(key / MAX_COLS);
export const keyCol = key => key % MAX_COLS;

/** `A1`-style text, e.g. `B7`. */
export const a1 = (row, col) => colToLetters(col) + String(row + 1);
export const cellA1 = c => a1(c.row, c.col);

/** Moved by (dr, dc); null when the result leaves the sheet. */
export function offset(c, dr, dc) {
  const r = c.row + dr, col = c.col + dc;
  return r >= 0 && r < MAX_ROWS && col >= 0 && col < MAX_COLS ? {row: r, col} : null;
}
/** Moved by (dr, dc) and clamped to the sheet. */
export function offsetClamped(c, dr, dc) {
  return {row: Math.min(MAX_ROWS - 1, Math.max(0, c.row + dr)), col: Math.min(MAX_COLS - 1, Math.max(0, c.col + dc))};
}

const isAlpha = ch => (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
const isDigit = ch => ch >= 48 && ch <= 57;

/**
 * Parses an A1 reference at the start of `s`: [col, row, colAbs, rowAbs, rest] or null
 * (gridcraft `parse_a1_prefix`).
 */
export function parseA1Prefix(s) {
  let i = 0;
  const colAbs = s.charCodeAt(0) === 36;
  if (colAbs) i++;
  const cs = i;
  while (i < s.length && isAlpha(s.charCodeAt(i))) i++;
  if (i === cs || i - cs > 3) return null;
  const col = lettersToCol(s.slice(cs, i));
  if (col === null) return null;
  const rowAbs = s.charCodeAt(i) === 36;
  if (rowAbs) i++;
  const rs = i;
  while (i < s.length && isDigit(s.charCodeAt(i))) i++;
  if (i === rs || i - rs > 7) return null;
  const row = Number(s.slice(rs, i));
  if (row === 0 || row > MAX_ROWS) return null;
  return [col, row - 1, colAbs, rowAbs, s.slice(i)];
}

/** Parses `A1`, `$A$1`, `xfd1048576` (case-insensitive). null if malformed or out of range. */
export function parseCell(s) {
  const p = parseA1Prefix(String(s));
  if (!p || p[4] !== '') return null;
  return {row: p[1], col: p[0]};
}

const letterCache = [];
/** 0 → `A`, 25 → `Z`, 26 → `AA`, 16383 → `XFD`. */
export function colToLetters(col) {
  if (col < 1024 && letterCache[col] !== undefined) return letterCache[col];
  let n = col + 1, out = '';
  while (n > 0) { const rem = (n - 1) % 26; out = String.fromCharCode(65 + rem) + out; n = Math.floor((n - 1) / 26); }
  if (col < 1024) letterCache[col] = out;
  return out;
}

/** `A` → 0, `xfd` → 16383. null for empty, non-letters or beyond `XFD`. */
export function lettersToCol(s) {
  if (!s || s.length > 3) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (!isAlpha(ch)) return null;
    n = n * 26 + ((ch & ~32) - 64);
  }
  if (n === 0 || n > MAX_COLS) return null;
  return n - 1;
}

// ---------------------------------------------------------------------------------------------
// Ranges

/** A normalised rectangular block, inclusive on both ends. */
export function range(a, b = a) {
  return {start: {row: Math.min(a.row, b.row), col: Math.min(a.col, b.col)}, end: {row: Math.max(a.row, b.row), col: Math.max(a.col, b.col)}};
}
export const rangeOf = (r0, c0, r1, c1) => range({row: r0, col: c0}, {row: r1, col: c1});
export const rangeCell = c => ({start: {row: c.row, col: c.col}, end: {row: c.row, col: c.col}});
/** Whole rows r0..=r1. */
export const rowsRange = (r0, r1) => rangeOf(r0, 0, r1, MAX_COLS - 1);
/** Whole columns c0..=c1. */
export const colsRange = (c0, c1) => rangeOf(0, c0, MAX_ROWS - 1, c1);
export const allRange = () => rangeOf(0, 0, MAX_ROWS - 1, MAX_COLS - 1);
export const height = r => r.end.row - r.start.row + 1;
export const width = r => r.end.col - r.start.col + 1;
export const count = r => height(r) * width(r);
export const isSingle = r => r.start.row === r.end.row && r.start.col === r.end.col;
export const isFullRows = r => r.start.col === 0 && r.end.col === MAX_COLS - 1;
export const isFullCols = r => r.start.row === 0 && r.end.row === MAX_ROWS - 1;
export const contains = (r, c) => c.row >= r.start.row && c.row <= r.end.row && c.col >= r.start.col && c.col <= r.end.col;
export const containsRC = (r, row, col) => row >= r.start.row && row <= r.end.row && col >= r.start.col && col <= r.end.col;
export const containsRange = (r, o) => contains(r, o.start) && contains(r, o.end);
export const intersects = (r, o) => r.start.row <= o.end.row && o.start.row <= r.end.row && r.start.col <= o.end.col && o.start.col <= r.end.col;
export function intersection(r, o) {
  if (!intersects(r, o)) return null;
  return {start: {row: Math.max(r.start.row, o.start.row), col: Math.max(r.start.col, o.start.col)},
    end: {row: Math.min(r.end.row, o.end.row), col: Math.min(r.end.col, o.end.col)}};
}
export function union(r, o) {
  return {start: {row: Math.min(r.start.row, o.start.row), col: Math.min(r.start.col, o.start.col)},
    end: {row: Math.max(r.end.row, o.end.row), col: Math.max(r.end.col, o.end.col)}};
}
export const rangeEquals = (a, b) => a.start.row === b.start.row && a.start.col === b.start.col && a.end.row === b.end.row && a.end.col === b.end.col;

/** Row-major cells. Callers must bound huge ranges themselves. */
export function* iterRange(r) {
  for (let row = r.start.row; row <= r.end.row; row++) for (let col = r.start.col; col <= r.end.col; col++) yield {row, col};
}

/** `A1:B2`, `A1` for single cells, `1:3` for full rows, `A:C` for full columns. */
export function rangeA1(r) {
  if (isFullRows(r) && !isFullCols(r)) return `${r.start.row + 1}:${r.end.row + 1}`;
  if (isFullCols(r) && !isFullRows(r)) return `${colToLetters(r.start.col)}:${colToLetters(r.end.col)}`;
  return isSingle(r) ? cellA1(r.start) : `${cellA1(r.start)}:${cellA1(r.end)}`;
}

/** Parses `A1`, `A1:B2`, `$A$1:$B$2`, `A:C`, `3:5` (no sheet prefix). null when malformed. */
export function parseRange(text) {
  const s = String(text).trim();
  const i = s.indexOf(':');
  if (i >= 0) {
    const a = s.slice(0, i), b = s.slice(i + 1);
    const x = parseCell(a), y = parseCell(b);
    if (x && y) return range(x, y);
    const strip = t => (t.startsWith('$') ? t.slice(1) : t);
    const ca = lettersToCol(strip(a)), cb = lettersToCol(strip(b));
    if (ca !== null && cb !== null) return colsRange(Math.min(ca, cb), Math.max(ca, cb));
    const rowNum = t => {
      const u = t.startsWith('$') ? t.slice(1) : t;
      if (!u || !/^\d+$/.test(u)) return null;
      return Number(u);
    };
    const pa = rowNum(a), pb = rowNum(b);
    if (pa === null || pb === null || pa === 0 || pb === 0 || pa > MAX_ROWS || pb > MAX_ROWS) return null;
    return rowsRange(Math.min(pa, pb) - 1, Math.max(pa, pb) - 1);
  }
  const c = parseCell(s);
  return c ? rangeCell(c) : null;
}

// ---------------------------------------------------------------------------------------------
// Sheet names

/** `R`, `C`, `RC`, `R1`, `C1`, `R1C`, `RC1`, `R1C1` in any case. */
function isR1C1Token(name) {
  let i = 0, letters = 0;
  for (const letter of ['r', 'c']) {
    if (i < name.length && name[i].toLowerCase() === letter) {
      i++; letters++;
      while (i < name.length && isDigit(name.charCodeAt(i))) i++;
    }
  }
  return letters > 0 && i === name.length;
}

const NAME_CHAR = /^[\p{L}\p{N}_.]$/u;
/**
 * Whether Excel quotes a sheet name in a reference ('My Sheet'!A1): it starts with a digit or
 * `.`, holds anything but letters (any script), digits, `_` and `.`, reads as an A1 cell or as
 * an R1C1 reference, or is a boolean.
 */
export function sheetNeedsQuotes(name) {
  if (!name) return true;
  const first = name[0];
  if ((first >= '0' && first <= '9') || first === '.') return true;
  for (const ch of name) if (!NAME_CHAR.test(ch)) return true;
  return parseCell(name) !== null || isR1C1Token(name) || /^(true|false)$/i.test(name);
}

/** A sheet name as written in a reference: quoted, with `'` doubled, when Excel quotes it. */
export const quoteSheet = name => (sheetNeedsQuotes(name) ? `'${name.replace(/'/g, "''")}'` : name);

/** Takes the quotes off a sheet name and reads `''` as `'`. Unquoted text is returned trimmed. */
export function unquoteSheet(text) {
  const t = String(text).trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** `'My Sheet'!A1` → [`My Sheet`, `A1`]; splits at the last `!`. */
export function splitSheet(reference) {
  const i = reference.lastIndexOf('!');
  return i < 0 ? [null, reference] : [unquoteSheet(reference.slice(0, i)), reference.slice(i + 1)];
}

// ---------------------------------------------------------------------------------------------
// Multi-level chart categories (addr.rs category_levels)

/** How `categories` lays its labels out beside `values`; null for a plain list. */
export function categoryLevels(categories, values) {
  if (isFullRows(categories) || isFullCols(categories)) return null;
  const w = width(categories), h = height(categories);
  const vertical = values ? height(values) >= width(values) : h >= w;
  const outer = vertical ? Math.max(0, w - 1) : Math.max(0, h - 1);
  return outer > 0 ? {byColumns: vertical, outer: Math.min(outer, 3)} : null;
}

// ---------------------------------------------------------------------------------------------
// color.rs: the 64-entry legacy indexed colour palette (RRGGBB)

export const INDEXED = Object.freeze([
  0x000000, 0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0xFF00FF, 0x00FFFF, 0x000000, 0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00,
  0xFF00FF, 0x00FFFF, 0x800000, 0x008000, 0x000080, 0x808000, 0x800080, 0x008080, 0xC0C0C0, 0x808080, 0x9999FF, 0x993366, 0xFFFFCC, 0xCCFFFF,
  0x660066, 0xFF8080, 0x0066CC, 0xCCCCFF, 0x000080, 0xFF00FF, 0xFFFF00, 0x00FFFF, 0x800080, 0x800000, 0x008080, 0x0000FF, 0x00CCFF, 0xCCFFFF,
  0xCCFFCC, 0xFFFF99, 0x99CCFF, 0xFF99CC, 0xCC99FF, 0xFFCC99, 0x3366FF, 0x33CCCC, 0x99CC00, 0xFFCC00, 0xFF9900, 0xFF6600, 0x666699, 0x969696,
  0x003366, 0x339966, 0x003300, 0x333300, 0x993300, 0x993366, 0x333399, 0x333333,
]);

/** Number-format colour `Color1`..`Color56` → [r, g, b], or null. */
export function indexedColor(index) {
  if (!(index >= 1 && index <= 56)) return null;
  const rgb = INDEXED[index + 7];
  return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
}
