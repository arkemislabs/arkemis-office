// Cell formatting on Grid workbooks (U:grid/format): the style every targeted cell gets, whole rows
// and columns keeping their own line format, the active cell's style the toggles read, colour
// params, sheet protection and the automatic row heights a format change refits.
// Translated from gridcraft crates/engine/src/cmd/format.rs (`apply_style`, `active_style`,
// `color_param`), crates/engine/src/cmd.rs (`auto_row_height`, `wrapped_line_count`, `commit`'s
// fit_rows) and crates/engine/src/cmd/format/sizes.rs (`approx_text_width`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Schema 2 (core/grid/model/workbook.mjs): a cell's `s` is a style id interned in
// `content.styles`; whole lines carry `rows[r].s` / `cols[c].s` (Sheet::style_id order: cell, row,
// column). Schema-1 sheets (`sheets[i].cells[A1] = {value, bold?, ...}`, served by the legacy editor
// until Grid's gate) get the same style through their inline props.
// No DOM, no Node built-ins.

import {MAX_ROWS, MAX_COLS, isFullRows, isFullCols, count, height, a1} from './addr.mjs';
import {targetRanges, gridSel, bad, failed, baseDoc} from './edit-targets.mjs';
import {cellAt, writeCell, isLegacySheet, legacyStyle, hasContent, parseKey} from '../model/store.mjs';
import {styleIdAt} from '../model/workbook.mjs';
import {resolveStyle, styleById, sparseStyle, styleKey, DEFAULT_FONT_SIZE} from '../model/style.mjs';
import {colWidth, defaultRowHeight, merges, DEFAULT_ROW_HEIGHT} from '../model/sheet.mjs';
import {valueAt} from '../model/index.mjs';
import {formatValue} from './numfmt.mjs';

/** Excel's message for a change on a protected sheet (cmd.rs PROTECTED). */
export const PROTECTED = "The cell or chart you're trying to change is on a protected sheet.";
const FLAG_GUARD = "You can't change cell protection on a protected sheet. Unprotect it first.";
/** Gridcraft refuses to format more cells than this one by one. */
export const MAX_CELLS = 4_000_000;

/** The sheet's protection record when the sheet is protected, else null. */
export function protectionOf(sheet) {
  const p = sheet?.protection;
  return p && typeof p === 'object' && p.enabled !== false ? p : null;
}

// ---------------------------------------------------------------------------------------------
// Styles

/** A full style (style.mjs resolved shape) as a mutable copy. */
export const cloneStyle = st => ({font: {...st.font}, fill: {...st.fill}, borders: {...st.borders}, align: {...st.align},
  numFmt: st.numFmt, protection: {...st.protection}});

/** The style table as the transaction holds it now. */
const tableOf = ctx => ({styles: ctx.change.get(['styles']) ?? ctx.doc.styles});
/** Resolved style of a style id. */
export const styleOfId = (ctx, id) => resolveStyle(styleById(tableOf(ctx), id ?? 0));

// StyleTable::intern over the transaction's table. The foundation's `internStyle` caches its
// index per array object and reads the length after splicing; inside one transaction the kernel
// splices an owned array in place, so a second new style got a stale index (and an id one past the
// end). Until design note U-grid-format--F-grid--intern-style-in-place is done, this keeps
// its own index keyed by the array and its length.
const internIndex = new WeakMap();
function indexFor(table) {
  let e = internIndex.get(table);
  if (!e) { e = {len: 0, map: new Map()}; internIndex.set(table, e); }
  for (; e.len < table.length; e.len++) { const k = styleKey(table[e.len] ?? {}); if (!e.map.has(k)) e.map.set(k, e.len); }
  return e.map;
}
/** Interns a full style; returns its id (0 for Normal). */
export function internFull(ctx, full) {
  const sparse = sparseStyle(resolveStyle(full));
  const key = styleKey(sparse);
  if (key === '{}') return 0;
  const table = ctx.change.get(['styles']);
  if (Array.isArray(table) && table.length) {
    const hit = indexFor(table).get(key);
    if (hit !== undefined) return hit;
    const id = table.length;
    ctx.change.splice(['styles'], id, 0, sparse);
    return id;
  }
  ctx.change.set(['styles'], [{}, sparse]);
  return 1;
}

/** StyleTable::derive with a closure: the id of `f` applied to the style `id`. */
export function deriveWith(ctx, id, f) {
  const next = cloneStyle(styleOfId(ctx, id));
  f(next);
  return internFull(ctx, next);
}

/** The style id of the active cell (what toggles read). */
export function activeStyleId(ctx) {
  const sel = gridSel(ctx);
  return styleIdAt(ctx.doc.sheets[sel.sheet], sel.active.row, sel.active.col);
}
/** gridcraft `active_style`: the resolved style of the active cell (schema-1 inline styles included). */
export function activeStyle(ctx) {
  const sel = gridSel(ctx);
  const sheet = ctx.doc.sheets[sel.sheet];
  if (isLegacySheet(sheet)) return resolveStyle(legacyStyle(sheet.cells[a1(sel.active.row, sel.active.col)] ?? {}) ?? undefined);
  return styleOfId(ctx, styleIdAt(sheet, sel.active.row, sel.active.col));
}

// ---------------------------------------------------------------------------------------------
// Colours

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i;
/**
 * gridcraft `color_param`: "auto"/"automatic"/"none" -> null (Automatic), "#RRGGBB", or a theme
 * colour {theme: 0..11, tint: -1..1}. Returns undefined when the value is missing or not a colour.
 */
export function colorParam(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^(auto|automatic|none)$/i.test(t)) return null;
    const m = HEX.exec(t);
    if (!m) return undefined;
    return `#${m[1].slice(-6).toUpperCase()}`;
  }
  if (typeof v === 'object' && Number.isInteger(v.theme) && v.theme >= 0) {
    const tint = Number.isFinite(v.tint) ? Math.max(-1, Math.min(1, v.tint)) : 0;
    // The model keeps tints in thousandths (Color::Theme(i, i16)).
    const t = Math.trunc(tint * 1000) / 1000;
    return t ? {theme: Math.min(v.theme, 11), tint: t} : {theme: Math.min(v.theme, 11)};
  }
  return undefined;
}
/** The colour schema the commands accept (text or a theme colour object). */
export const COLOR_DESCRIPTION = '"#RRGGBB", "auto" (or "none"), or a theme colour {theme: 0-11, tint: -1..1}';

// ---------------------------------------------------------------------------------------------
// Reading cells of a sheet the command is writing

/**
 * Stored cells in rows r0..r1, columns c0..c1 as [row, col, cell], row-major. Unlike the
 * foundation's `forEachCell` this keeps no per-block cache: the kernel mutates a block it already
 * copied in this transaction in place, so a cached entry list of such a block would go stale
 * (and stay stale after the commit) once the command writes to it again.
 */
export function cellsIn(sheet, r0, c0, r1, c1) {
  const out = [];
  const blocks = sheet?.blocks;
  if (!blocks) return out;
  const b0 = Math.floor(r0 / 256), b1 = Math.floor(Math.min(r1, MAX_ROWS - 1) / 256);
  const keys = b1 - b0 < 64 ? Array.from({length: b1 - b0 + 1}, (_, i) => b0 + i).filter(b => blocks[b] !== undefined)
    : Object.keys(blocks).map(Number).filter(b => b >= b0 && b <= b1);
  for (const bk of keys) {
    const block = blocks[bk];
    for (const k of Object.keys(block)) {
      const p = parseKey(k);
      if (!p) continue;
      const [row, col] = p;
      if (row < r0 || row > r1 || col < c0 || col > c1) continue;
      out.push([row, col, block[k]]);
    }
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

// ---------------------------------------------------------------------------------------------
// apply_style

function setLineStyle(ctx, si, key, line, id) {
  const sheet = ctx.doc.sheets[si];
  const info = sheet[key]?.[line];
  const next = {...(info ?? {})};
  if (id) next.s = id; else delete next.s;
  if (!sheet[key]) { if (Object.keys(next).length) ctx.change.set(['sheets', si, key], {[line]: next}); return; }
  if (!Object.keys(next).length) { if (info) ctx.change.delete(['sheets', si, key, String(line)]); return; }
  ctx.change.set(['sheets', si, key, String(line)], next);
}

/**
 * gridcraft `apply_style`: applies `f` (a mutation of a full style) to every targeted cell of the
 * `range` param (default: the selection). Whole rows and columns set their line format and the
 * cells already in them; other areas restyle cell by cell. On a protected sheet formatting needs
 * the Format cells permission and may not change the cells' Locked/Hidden flags. Rows whose
 * content was restyled refit their automatic height (Excel auto-fits).
 * Returns {sheet, areas}.
 */
export function applyStyle(ctx, p, f) {
  baseDoc(ctx);
  const {sheet: si, areas} = targetRanges(ctx, p);
  const sheet0 = ctx.doc.sheets[si];
  const prot = protectionOf(sheet0);
  if (prot && !prot.formatCells) throw failed(PROTECTED);
  if (isLegacySheet(sheet0)) { applyLegacy(ctx, si, areas, f); return {sheet: si, areas}; }
  const cache = new Map();
  const derive = id => {
    let n = cache.get(id);
    if (n === undefined) {
      n = deriveWith(ctx, id, f);
      if (prot) {
        const a = styleOfId(ctx, id).protection, b = styleOfId(ctx, n).protection;
        if (a.locked !== b.locked || a.hidden !== b.hidden) throw failed(FLAG_GUARD);
      }
      cache.set(id, n);
    }
    return n;
  };
  const fit = new Set();
  for (const r of areas) {
    const fullRows = isFullRows(r), fullCols = isFullCols(r);
    if (fullRows || fullCols) {
      // Line formats.
      const rowsMode = fullRows && !fullCols;
      const key = rowsMode ? 'rows' : 'cols';
      const lo = rowsMode ? r.start.row : r.start.col, hi = rowsMode ? r.end.row : r.end.col;
      for (let line = lo; line <= hi; line++) {
        const cur = ctx.doc.sheets[si][key]?.[line]?.s ?? 0;
        const n = derive(cur);
        if (n !== cur) setLineStyle(ctx, si, key, line, n);
      }
      // Existing cells in those lines.
      const cells = cellsIn(ctx.doc.sheets[si], r.start.row, r.start.col, r.end.row, r.end.col);
      for (const [row, col, cell] of cells) {
        const st = cell.s ?? 0;
        const n = derive(st);
        if (n !== st) writeCell(ctx.change, ctx.doc, si, row, col, {...cell, s: n});
        fit.add(row);
      }
      continue;
    }
    if (count(r) > MAX_CELLS) throw bad('format', 'selection too large to format cell by cell');
    if (height(r) <= 100_000) for (let row = r.start.row; row <= r.end.row; row++) fit.add(row);
    for (let row = r.start.row; row <= r.end.row; row++) {
      for (let col = r.start.col; col <= r.end.col; col++) {
        const sh = ctx.doc.sheets[si];
        const st = styleIdAt(sh, row, col);
        const n = derive(st);
        if (n !== st) writeCell(ctx.change, ctx.doc, si, row, col, {...(cellAt(sh, row, col) ?? {}), s: n});
      }
    }
  }
  fitRows(ctx, si, fit);
  return {sheet: si, areas};
}

// Schema-1 cells: the same style through their inline props.
const LEGACY_KEYS = ['fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strike', 'color', 'background', 'align', 'verticalAlign',
  'wrap', 'rotation', 'indent', 'numFmt', 'borders'];
function toLegacy(st) {
  const out = {};
  const f = st.font;
  if (f.name && f.name !== 'Calibri') out.fontFamily = f.name;
  if (f.size && f.size !== DEFAULT_FONT_SIZE) out.fontSize = f.size;
  if (f.bold) out.bold = true;
  if (f.italic) out.italic = true;
  if (f.underline && f.underline !== 'none') out.underline = f.underline;
  if (f.strike) out.strike = true;
  if (typeof f.color === 'string') out.color = f.color;
  if (st.fill.pattern === 'solid' && typeof st.fill.fg === 'string') out.background = st.fill.fg;
  if (st.align.h && st.align.h !== 'general') out.align = st.align.h;
  if (st.align.v && st.align.v !== 'bottom') out.verticalAlign = st.align.v === 'center' ? 'middle' : st.align.v;
  if (st.align.wrap) out.wrap = true;
  if (st.align.rotation) out.rotation = st.align.rotation;
  if (st.align.indent) out.indent = st.align.indent;
  if (st.numFmt && st.numFmt !== 'General') out.numFmt = st.numFmt;
  const b = Object.entries(st.borders).filter(([, x]) => x && x.style && x.style !== 'none');
  if (b.length) out.borders = Object.fromEntries(b.map(([k, x]) => [k, x.color ? {style: x.style, color: x.color} : {style: x.style}]));
  return out;
}
function applyLegacy(ctx, si, areas, f) {
  for (const r of areas) {
    const sheet = ctx.doc.sheets[si];
    const r1 = Math.min(r.end.row, Math.max(r.start.row, (sheet.rows ?? 0) - 1, r.start.row));
    const c1 = Math.min(r.end.col, Math.max(r.start.col, (sheet.columns ?? 0) - 1, r.start.col));
    if ((r1 - r.start.row + 1) * (c1 - r.start.col + 1) > MAX_CELLS) throw bad('format', 'selection too large to format cell by cell');
    for (let row = r.start.row; row <= r1; row++) {
      for (let col = r.start.col; col <= c1; col++) {
        const key = a1(row, col);
        const old = ctx.doc.sheets[si].cells[key];
        const st = cloneStyle(resolveStyle(legacyStyle(old ?? {}) ?? undefined));
        f(st);
        const props = toLegacy(st);
        const next = {};
        for (const [k, v] of Object.entries(old ?? {value: ''})) if (!LEGACY_KEYS.includes(k)) next[k] = v;
        Object.assign(next, props);
        const keep = Object.keys(next).some(k => k !== 'value') || (next.value ?? '') !== '';
        if (!keep) { if (old) ctx.change.delete(['sheets', si, 'cells', key]); continue; }
        if (JSON.stringify(next) !== JSON.stringify(old)) ctx.change.set(['sheets', si, 'cells', key], next);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Automatic row heights (cmd.rs `auto_row_height`)

/** sizes.rs `approx_text_width`: text width in pixels from average glyph widths of the default font. */
export function approxTextWidth(text, size, bold) {
  let w = 0;
  for (const c of String(text)) {
    if ("ilj'.,:;!|".includes(c)) w += 0.28;
    else if ('ftrI ()-'.includes(c)) w += 0.38;
    else if ('mwMW'.includes(c)) w += 0.85;
    else if (c >= 'A' && c <= 'Z') w += 0.65;
    else if (c >= '0' && c <= '9') w += 0.56;
    else if (c.charCodeAt(0) < 128) w += 0.52;
    else w += 1.0;
  }
  return w * size * (bold ? 1.07 : 1) * 96 / 72;
}

/** cmd.rs `wrapped_line_count`: lines a wrapping cell's text takes at a column width. */
export function wrappedLineCount(line, width, size, bold) {
  const wordW = w => approxTextWidth(w, size, bold);
  const spaceW = wordW(' ');
  let lines = 1, used = 0;
  for (const word of String(line).split(/\s+/).filter(Boolean)) {
    const w = wordW(word);
    if (w > width) {
      if (used > 0) lines += 1;
      const chunks = Math.ceil(w / width);
      lines += chunks - 1;
      used = w - (chunks - 1) * width;
      continue;
    }
    const gap = used > 0 ? spaceW : 0;
    if (used + gap + w > width) { lines += 1; used = w; } else used += gap + w;
  }
  return lines;
}

/** The text a cell shows (its value from the content as the command found it, in the cell's current format). */
function shownText(ctx, si, row, col, st) {
  let v;
  try { v = valueAt(baseDoc(ctx), si, row, col); } catch { v = null; }
  if (v === null || v === undefined) return '';
  try { return formatValue(v, st.numFmt, ctx.doc.dateSystem === 1904 ? 1904 : 1900).text ?? ''; } catch { return String(v); }
}

/**
 * cmd.rs `auto_row_height`: recomputes an automatic row height from its content (the largest font,
 * wrapped text). Rows with a user-set height keep it; merged cells never fit their rows.
 */
export function autoRowHeight(ctx, si, row) {
  const sh = ctx.doc.sheets[si];
  if (!sh || isLegacySheet(sh)) return;
  const info = sh.rows?.[row];
  if (info?.custom) return;
  const deflt = defaultRowHeight(sh);
  const cells = cellsIn(sh, row, 0, row, MAX_COLS - 1).map(([, col, cell]) => [col, cell]);
  const styleOf = cell => styleOfId(ctx, cell.s ?? 0);
  const plain = cells.every(([, cell]) => { const st = styleOf(cell); return st.font.size <= DEFAULT_FONT_SIZE && !st.align.wrap; });
  const write = size => {
    const cur = ctx.doc.sheets[si].rows?.[row];
    const next = {...(cur ?? {})};
    if (size === undefined) delete next.size; else next.size = size;
    if (cur?.size === next.size) return;
    if (!Object.keys(next).length) { if (cur) ctx.change.delete(['sheets', si, 'rows', String(row)]); return; }
    if (!ctx.doc.sheets[si].rows) ctx.change.set(['sheets', si, 'rows'], {[row]: next});
    else ctx.change.set(['sheets', si, 'rows', String(row)], next);
  };
  if (plain) { if (info?.size !== undefined) write(undefined); return; }
  let need = deflt, skipped = false;
  const rowMerges = merges(sh).filter(m => !(m.start.row === m.end.row && m.start.col === m.end.col) && m.start.row <= row && row <= m.end.row);
  for (const [col, cell] of cells) {
    if (rowMerges.some(m => m.start.col <= col && col <= m.end.col)) { skipped = true; continue; }
    const st = styleOf(cell);
    const size = st.font.size;
    const line = Math.max(Math.round(size * 1.8), DEFAULT_ROW_HEIGHT * size / DEFAULT_FONT_SIZE);
    let lines = 1;
    if (hasContent(cell)) {
      if (st.align.wrap) {
        const text = shownText(ctx, si, row, col, st);
        const w = Math.max(colWidth(sh, col), 1) - 6;
        lines = Math.max(1, String(text).split(/\r?\n/).reduce((n, l) => n + wrappedLineCount(l, Math.max(w, 1), size, st.font.bold), 0));
      }
    } else if (size <= DEFAULT_FONT_SIZE) continue;
    const h = lines > 1 ? Math.ceil(size * 96 / 72 * 1.22 * lines + 5) : line;
    need = Math.max(need, Math.min(h, 546));
  }
  // Excel never fits a row to its merged cells, and merging does not shrink a row either: a row
  // that already grew for a big title keeps its height when the title is merged across.
  if (skipped && info?.size !== undefined && info.size > need) return;
  write(Math.abs(need - deflt) < 0.5 ? undefined : need);
}

/** Refits the automatic heights of `rows` (a Set or array of row indexes) on sheet si. */
export function fitRows(ctx, si, rows) {
  const list = [...rows].filter(r => r >= 0 && r < MAX_ROWS).sort((a, b) => a - b);
  for (const row of list) autoRowHeight(ctx, si, row);
}

export {MAX_ROWS, MAX_COLS};
