// Clipboard text and HTML for Grid: the tab-separated text a copy puts on the system clipboard,
// the styled HTML table beside it, reading pasted text and the HTML flavour's numbers, and
// packing a multi-area copy into one block (U:grid/edit; other units may import, not edit).
// Translated from gridcraft crates/engine/src/display.rs (`range_text`, `clipboard_range`,
// `cell_text`, `value_text`), crates/engine/src/io.rs (`range_html`), crates/engine/src/clip_html.rs
// (`table_cells`, `normalized`, `format_for`, `decode`) and crates/engine/src/cmd/edit/clipboard.rs
// (`parse_tsv`, `slide_together`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {MAX_ROWS, MAX_COLS, a1, parseRange, rangeA1, count, height, width, intersects, intersection, containsRange, contains, offset, offsetClamped, rangeOf} from './addr.mjs';
import {textFunction} from './numfmt.mjs';
import {cellAt, forEachCell, blockOf} from '../model/store.mjs';
import {isRowHidden, merges} from '../model/sheet.mjs';
import {styleAt, sheetView} from '../model/workbook.mjs';
import {colorHex} from '../model/style.mjs';
import {engineFor} from '../model/calc.mjs';
import {toJSONValue} from './value.mjs';
import {displayAt} from '../model/index.mjs';
import {colToLetters} from './addr.mjs';

/** display.rs `clipboard_range`: the plain-text clipboard limit. */
export function clipboardRange(r) {
  return count(r) > 2_000_000 ? {start: {...r.start}, end: offsetClamped(r.start, 1999, 999)} : r;
}

/** display.rs `cell_text`: what a cell shows, full precision (formula text with Show Formulas). */
export function cellText(content, si, row, col) {
  const sheet = content.sheets[si];
  if (sheetView(sheet).showFormulas) {
    const c = cellAt(sheet, row, col);
    if (c?.f !== undefined && !formulaHidden(content, si, row, col)) return `=${c.f}`;
  }
  return displayAt(content, si, row, col).text;
}

/** display.rs `formula_hidden`: a Hidden formula on a protected sheet (a spilled cell follows its anchor). */
export function formulaHidden(content, si, row, col) {
  const sheet = content.sheets[si];
  if (!sheet?.protection || sheet.protection.enabled === false) return false;
  let at = {row, col};
  const c = cellAt(sheet, row, col);
  if (!(c && c.f !== undefined)) {
    const a = engineFor(content).spillAnchorOf(si, row, col);
    if (!a) return false;
    at = a;
  }
  return !!styleAt(content, sheet, at.row, at.col).protection.hidden;
}

/** display.rs `range_text`: tab-separated, hidden rows left out, Excel quoting. */
export function rangeText(content, si, r0) {
  const sheet = content.sheets[si];
  if (!sheet) return '';
  const r = clipboardRange(r0);
  let out = '';
  for (let row = r.start.row; row <= r.end.row; row++) {
    if (isRowHidden(sheet, row)) continue;
    for (let col = r.start.col; col <= r.end.col; col++) {
      if (col > r.start.col) out += '\t';
      const t = cellText(content, si, row, col);
      out += /[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    }
    out += '\n';
  }
  return out;
}

const HTML_MAX_BYTES = 4 * 1024 * 1024;
const HTML_MAX_CELLS = 10_000;
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r?\n/g, '<br>');

/** The CSS a copied cell carries (io.rs `html_cell_css`): font, colour, fill, alignment, wrap. */
function cellCss(content, sheet, row, col) {
  const st = styleAt(content, sheet, row, col);
  const css = [];
  if (st.font.bold) css.push('font-weight:bold');
  if (st.font.italic) css.push('font-style:italic');
  const deco = [st.font.underline && st.font.underline !== 'none' ? 'underline' : '', st.font.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css.push(`text-decoration:${deco}`);
  if (st.font.name && st.font.name !== 'Calibri') css.push(`font-family:${st.font.name.replace(/[;"<>]/g, '')}`);
  if (st.font.size && st.font.size !== 11) css.push(`font-size:${st.font.size}pt`);
  const fg = colorHex(st.font.color);
  if (fg) css.push(`color:${fg}`);
  if (st.fill.pattern && st.fill.pattern !== 'none') { const bg = colorHex(st.fill.fg); if (bg) css.push(`background:${bg}`); }
  if (st.align.h && st.align.h !== 'general') css.push(`text-align:${st.align.h === 'centerContinuous' ? 'center' : st.align.h}`);
  if (st.align.v && st.align.v !== 'bottom') css.push(`vertical-align:${st.align.v === 'center' ? 'middle' : st.align.v}`);
  return css.join(';');
}

/**
 * io.rs `range_html`: an HTML table for the same range as `plainText` (hidden rows left out,
 * merges as spans). null for large copies (never a partial table).
 */
export function rangeHtml(content, si, r0, plainText) {
  const r = clipboardRange(r0);
  if (count(r) > HTML_MAX_CELLS || plainText.length > HTML_MAX_BYTES) return null;
  const sheet = content.sheets[si];
  if (!sheet) return null;
  const ms = merges(sheet);
  let out = `<table${sheet.rightToLeft ? ' dir="rtl"' : ''} style="border-collapse:collapse;font-family:Calibri,Carlito,Arial,sans-serif;font-size:11pt">`;
  for (let row = r.start.row; row <= r.end.row; row++) {
    if (isRowHidden(sheet, row)) continue;
    out += '<tr>';
    for (let col = r.start.col; col <= r.end.col; col++) {
      let span = '';
      const m = ms.find(x => contains(x, {row, col}));
      if (m) {
        const part = intersection(m, r);
        let first = null;
        for (let rr = part.start.row; rr <= part.end.row; rr++) if (!isRowHidden(sheet, rr)) { first = rr; break; }
        if (first === null || row !== first || col !== part.start.col) continue;
        let rows = 0;
        for (let rr = first; rr <= part.end.row; rr++) if (!isRowHidden(sheet, rr)) rows++;
        span = ` rowspan="${rows}" colspan="${width(m)}"`;
      }
      const text = cellText(content, si, row, col);
      const v = engineFor(content).sheetValue(si, row, col);
      const num = typeof v === 'number' ? ` x:num="${v}"` : '';
      out += `<td style="border:1px solid #d4d4d4;padding:2px 4px;white-space:pre-wrap;${cellCss(content, sheet, row, col)}"${num}${span}>${esc(text)}</td>`;
      if (out.length > HTML_MAX_BYTES) return null;
    }
    out += '</tr>';
  }
  return `${out}</table>`;
}

/** clipboard.rs `parse_tsv`: tab-separated text with Excel-style quoting. */
export function parseTsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, atStart = true;
  const chars = [...String(text)];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (quoted) {
      if (c === '"') {
        if (chars[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && atStart) { quoted = true; atStart = false; continue; }
    if (c === '\t') { row.push(field); field = ''; atStart = true; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; atStart = true; continue; }
    field += c;
    atStart = false;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// clip_html.rs

const MAX_HTML = 16 * 1024 * 1024;
const MAX_HTML_CELLS = 1_000_000;

/** Same-looking text: non-breaking spaces as spaces, whitespace runs collapsed, trimmed. */
export const normalized = s => String(s).replace(/ /g, ' ').split(/\s+/).filter(Boolean).join(' ');

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
/** HTML entities inside a 12-character window (clip_html.rs `decode`). */
export function decode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '&') { out += c; continue; }
    const win = s.slice(i + 1, i + 13);
    const semi = win.indexOf(';');
    if (semi < 0) { out += c; continue; }
    const name = win.slice(0, semi);
    let rep = null;
    if (/^#\d{1,7}$/.test(name)) { const n = Number(name.slice(1)); if (n <= 0x10ffff) rep = String.fromCodePoint(n); }
    else if (/^#x[0-9a-f]{1,6}$/i.test(name)) { const n = parseInt(name.slice(2), 16); if (n <= 0x10ffff) rep = String.fromCodePoint(n); }
    else if (Object.hasOwn(ENTITIES, name)) rep = ENTITIES[name];
    if (rep === null) { out += c; continue; }
    out += rep;
    i += semi + 1;
  }
  return out;
}
const attr = (attrs, name) => {
  const re = new RegExp(`(?:^|\\s)${name.replace(/[:]/g, '\\:')}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const spanOf = (attrs, name, max) => { const v = Number.parseInt(attr(attrs, name) ?? '1', 10); return Number.isFinite(v) ? Math.min(Math.max(v, 1), max) : 1; };

/** The end of a tag starting at `<`, skipping quoted attribute values. */
function tagEnd(s) {
  let q = null;
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * clip_html.rs `table_cells`: the first table's cells, row by row, no further than the pasted
 * text's shape. {text, num} where num is the source's `x:num` (Excel) or `sdval` (LibreOffice).
 */
export function tableCells(html, maxRows, maxCols) {
  const rows = [];
  if (typeof html !== 'string' || html.length > MAX_HTML) return rows;
  const pending = new Map(); // col -> remaining rowspan rows
  let cell = null, inTable = false, total = 0, full = false;
  let rest = html;
  const finish = () => {
    if (!cell) return;
    const row = rows[rows.length - 1];
    if (row) {
      while (pending.get(row.length) > 0 && row.length < maxCols) { pending.set(row.length, pending.get(row.length) - 1); row.push({text: '', num: null}); total++; }
      if (row.length < maxCols) {
        const col = row.length;
        row.push({text: normalized(decode(cell.text)), num: cell.num});
        total++;
        for (let k = 1; k < cell.colspan && row.length < maxCols; k++) { row.push({text: '', num: null}); total++; }
        if (cell.rowspan > 1) for (let k = 0; k < cell.colspan; k++) pending.set(col + k, cell.rowspan - 1);
      }
    }
    cell = null;
    if (total >= MAX_HTML_CELLS) full = true;
  };
  while (rest && !full) {
    const lt = rest.indexOf('<');
    if (lt < 0) { if (cell) cell.text += rest; break; }
    if (cell) cell.text += rest.slice(0, lt);
    rest = rest.slice(lt);
    if (rest.startsWith('<!--')) { const e = rest.indexOf('-->'); rest = e < 0 ? '' : rest.slice(e + 3); continue; }
    const gt = tagEnd(rest);
    if (gt < 0) break;
    const tag = rest.slice(1, gt);
    rest = rest.slice(gt + 1);
    const closing = tag.startsWith('/');
    const body = tag.replace(/^\/+/, '');
    const nameEnd = body.search(/[\s/]/);
    const name = (nameEnd < 0 ? body : body.slice(0, nameEnd)).toLowerCase();
    const attrs = nameEnd < 0 ? '' : body.slice(nameEnd);
    if ((name === 'style' || name === 'script') && !closing) {
      const i = rest.toLowerCase().indexOf(`</${name}`);
      rest = i < 0 ? '' : rest.slice(i);
    } else if (name === 'table' && !closing) {
      if (inTable) break;
      inTable = true;
    } else if (name === 'table' && closing) {
      finish();
      if (rows.length) break;
      inTable = false;
    } else if (name === 'tr' && !closing && inTable) {
      finish();
      if (rows.length >= maxRows) break;
      rows.push([]);
    } else if ((name === 'td' || name === 'th') && !closing && inTable) {
      finish();
      if (!rows.length) rows.push([]);
      const raw = attr(attrs, 'x:num') ?? attr(attrs, 'sdval');
      const n = raw === null ? NaN : Number(raw.trim());
      cell = {text: '', num: Number.isFinite(n) && raw.trim() !== '' ? n : null, colspan: spanOf(attrs, 'colspan', MAX_COLS), rowspan: spanOf(attrs, 'rowspan', MAX_ROWS)};
    } else if (((name === 'td' || name === 'th') && closing) || (name === 'tr' && closing)) {
      finish();
    } else if (name === 'br' && cell) cell.text += ' ';
  }
  finish();
  return rows;
}

/**
 * clip_html.rs `format_for`: a number format that shows `n` exactly as `shown` ("Rp10,000.00"
 * → `"Rp"#,##0.00`), or null unless it renders `shown` back character for character.
 */
export function formatFor(shown0, n) {
  const shown = normalized(shown0);
  const start = shown.search(/[0-9]/);
  if (start < 0) return null;
  let end = -1;
  for (let i = shown.length - 1; i >= 0; i--) if (shown[i] >= '0' && shown[i] <= '9') { end = i + 1; break; }
  const core = shown.slice(start, end);
  let prefix = shown.slice(0, start);
  const suffix = shown.slice(end);
  if (/[^0-9,.]/.test(core)) return null;
  if (n < 0) { if (!prefix.startsWith('-')) return null; prefix = prefix.slice(1); }
  const dot = core.indexOf('.');
  const decimals = dot < 0 ? 0 : core.length - dot - 1;
  const quote = s => (s ? `"${s.replace(/"/g, '')}"` : '');
  let code = quote(prefix) + (core.includes(',') ? '#,##0' : '0');
  if (decimals > 0) code += '.' + '0'.repeat(Math.min(decimals, 30));
  code += quote(suffix);
  let rendered;
  try { rendered = textFunction(n, code, 1900); } catch { return null; }
  if (typeof rendered !== 'string') return null;
  return normalized(rendered) === shown ? code : null;
}

// ---------------------------------------------------------------------------------------------
// clipboard.rs `slide_together`

const putBlockCell = (blocks, row, col, cell) => {
  const b = blockOf(row);
  blocks[b] = {...(blocks[b] ?? {}), [colToLetters(col) + (row + 1)]: cell};
};
const dropBlockCell = (blocks, row, col) => {
  const b = blockOf(row);
  if (!blocks[b]) return;
  const k = colToLetters(col) + (row + 1);
  if (!(k in blocks[b])) return;
  const next = {...blocks[b]};
  delete next[k];
  blocks[b] = next;
};
const keyRange = (map, r) => Object.keys(map ?? {}).filter(k => { const c = parseRange(k)?.start; return c && contains(r, c); });

/**
 * Excel copies a multi-area selection only when the areas line up: all on the same rows (side by
 * side) or the same columns (stacked), without overlapping. Returns {content, block}: a copy of the
 * workbook whose sheet holds the areas packed into one block at the first area's place (formulas
 * travel as their values), or null when they don't line up.
 */
export function slideTogether(content, si, areas) {
  const first = areas[0];
  if (!first) return null;
  const across = areas.every(a => a.start.row === first.start.row && a.end.row === first.end.row);
  const down = areas.every(a => a.start.col === first.start.col && a.end.col === first.end.col);
  const sorted = [...areas];
  if (across) sorted.sort((a, b) => a.start.col - b.start.col);
  else if (down) sorted.sort((a, b) => a.start.row - b.start.row);
  else return null;
  for (let i = 1; i < sorted.length; i++) if (intersects(sorted[i - 1], sorted[i])) return null;
  const anchor = sorted[0].start;
  const h = across ? height(first) : sorted.reduce((n, a) => n + height(a), 0);
  const w = across ? sorted.reduce((n, a) => n + width(a), 0) : width(first);
  const end = offset(anchor, h - 1, w - 1);
  if (!end) return null;
  const block = {start: {...anchor}, end};
  const src = content.sheets[si];
  const eng = engineFor(content);
  const blocks = {...(src.blocks ?? {})};
  forEachCell(src, block.start.row, block.start.col, block.end.row, block.end.col, (row, col) => { dropBlockCell(blocks, row, col); });
  const notes = Object.fromEntries(Object.entries(src.notes ?? {}).filter(([k]) => !contains(block, parseRange(k).start)));
  const comments = Object.fromEntries(Object.entries(src.comments ?? {}).filter(([k]) => !contains(block, parseRange(k).start)));
  const ms = (src.merges ?? []).filter(m => !intersects(parseRange(m), block));
  const lines = {...((across ? src.cols : src.rows) ?? {})};
  for (const k of Object.keys(lines)) { const n = Number(k); if (across ? n >= block.start.col && n <= block.end.col : n >= block.start.row && n <= block.end.row) delete lines[k]; }
  let next = across ? anchor.col : anchor.row;
  for (const a of sorted) {
    const dr = across ? 0 : next - a.start.row, dc = across ? next - a.start.col : 0;
    const seen = new Set();
    const place = (row, col) => {
      const k = `${row},${col}`;
      if (seen.has(k)) return;
      seen.add(k);
      const to = offset({row, col}, dr, dc);
      if (!to) return;
      const style = cellAt(src, row, col)?.s;
      const v = eng.sheetValue(si, row, col);
      const json = toJSONValue(v);
      const cell = {};
      if (json !== null) cell.v = json;
      if (style) cell.s = style;
      if (Object.keys(cell).length) putBlockCell(blocks, to.row, to.col, cell);
    };
    forEachCell(src, a.start.row, a.start.col, a.end.row, a.end.col, (row, col) => { place(row, col); });
    for (const [ak, rr] of eng.spillRanges) {
      void ak;
      const part = intersects(rr, a) ? intersection(rr, a) : null;
      if (!part) continue;
      for (let row = part.start.row; row <= part.end.row; row++) for (let col = part.start.col; col <= part.end.col; col++) if (eng.sheetValue(si, row, col) !== null) place(row, col);
    }
    for (const k of keyRange(src.notes, a)) { const c = parseRange(k).start; const to = offset(c, dr, dc); if (to) notes[a1(to.row, to.col)] = src.notes[k]; }
    for (const k of keyRange(src.comments, a)) { const c = parseRange(k).start; const to = offset(c, dr, dc); if (to) comments[a1(to.row, to.col)] = src.comments[k]; }
    for (const m of (src.merges ?? []).map(parseRange)) {
      if (!containsRange(a, m)) continue;
      const s = offset(m.start, dr, dc), e = offset(m.end, dr, dc);
      if (s && e) ms.push(rangeA1({start: s, end: e}));
    }
    const lineMap = (across ? src.cols : src.rows) ?? {};
    for (const [k, info] of Object.entries(lineMap)) {
      const n = Number(k);
      const lo = across ? a.start.col : a.start.row, hi = across ? a.end.col : a.end.row;
      if (n >= lo && n <= hi) lines[next + n - lo] = info;
    }
    next += across ? width(a) : height(a);
  }
  const sheet = {...src, blocks, notes, comments, merges: ms, [across ? 'cols' : 'rows']: lines};
  return {content: {...content, sheets: content.sheets.map((s, i) => (i === si ? sheet : s))}, block};
}

export {rangeOf, MAX_ROWS};
