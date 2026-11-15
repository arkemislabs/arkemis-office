// Table styles: how a cell inside a table looks (our own palettes, keyed by the familiar
// TableStyleLight1..21 / Medium1..28 / Dark1..11 names so files round-trip).
// Translated from gridcraft crates/engine/src/tables.rs (`parse_style_name`, `accent_for`, `look`,
// `table_cell_style`, `gallery`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {mergeStyle} from '../model/style.mjs';
import {parseRange, contains} from './addr.mjs';

/** [family, number] from a style name, e.g. `TableStyleMedium2` is ['Medium', 2]. */
export function parseStyleName(name) {
  const rest = String(name ?? '').replace(/^TableStyle/, '');
  for (const fam of ['Light', 'Medium', 'Dark']) {
    if (rest.startsWith(fam)) return [fam, Math.max(1, parseInt(rest.slice(fam.length), 10) || 2)];
  }
  return ['Medium', 2];
}

/** Accent theme slot (4..9) for a style number; 1 and every 7th style are neutral (dk1). */
const accentFor = n => { const k = (n - 1) % 7; return k === 0 ? null : 3 + k; };
const theme = (slot, tint) => ({theme: slot, tint: tint / 1000});

/** Header/band/body colours of a table style. */
export function tableLook(style) {
  // Table Design > Table Styles > Clear: no style (the options still bold the first and last column).
  if (style === 'None') return {headerFill: null, headerFont: null, headerBold: false, bandFill: null, bodyFill: null, line: null, totalTop: null};
  const [fam, n] = parseStyleName(style);
  const acc = accentFor(n);
  const base = tint => (acc !== null ? theme(acc, tint) : theme(1, tint === 0 ? 0 : Math.max(-1000, Math.min(1000, tint))));
  const neutralLight = tint => (acc !== null ? theme(acc, tint) : theme(0, -Math.trunc(Math.max(0, Math.min(1000, 1000 - tint)) / 6)));
  if (fam === 'Light') {
    const group = Math.floor((n - 1) / 7);
    return {headerFill: null, headerFont: group === 0 ? base(-250) : null, headerBold: true, bandFill: neutralLight(800), bodyFill: null, line: base(0), totalTop: base(0)};
  }
  if (fam === 'Dark') return {headerFill: theme(1, 0), headerFont: theme(0, 0), headerBold: true, bandFill: base(-250), bodyFill: base(0), line: null, totalTop: theme(0, 0)};
  return {headerFill: base(0), headerFont: theme(0, 0), headerBold: true, bandFill: neutralLight(800), bodyFill: null, line: Math.floor((n - 1) / 7) === 0 ? null : base(400), totalTop: base(0)};
}

/** The table style names the gallery lists, Light 1-21, Medium 1-28, Dark 1-11. */
export function gallery() {
  const out = [];
  for (const [fam, count] of [['Light', 21], ['Medium', 28], ['Dark', 11]]) for (let n = 1; n <= count; n++) out.push(`TableStyle${fam}${n}`);
  return out;
}

const parsed = new WeakMap();
/** A sheet's tables with their ranges parsed, cached per tables array. */
export function tablesOf(sheet) {
  const list = sheet?.tables;
  if (!Array.isArray(list) || !list.length) return [];
  let c = parsed.get(list);
  if (!c) {
    c = list.map(t => { const range = typeof t.range === 'string' ? parseRange(t.range) : t.range; return range ? {table: t, range} : null; }).filter(Boolean);
    parsed.set(list, c);
  }
  return c;
}

/** The table holding a cell: {table, range} or null. */
export function tableAt(sheet, row, col) {
  const l = tablesOf(sheet);
  if (!l.length) return null;
  const at = {row, col};
  return l.find(t => contains(t.range, at)) ?? null;
}

/** The style options of a table: {name, showRowStripes, showColumnStripes, showFirstColumn, showLastColumn} (a plain style name is the name alone). */
export function styleInfo(t) {
  const s = t?.style;
  if (typeof s === 'string') return {name: s, showRowStripes: true, showColumnStripes: false, showFirstColumn: false, showLastColumn: false};
  if (!s) return {name: 'TableStyleMedium2', showRowStripes: true, showColumnStripes: false, showFirstColumn: false, showLastColumn: false};
  return {name: s.name === null ? 'None' : s.name ?? 'TableStyleMedium2', showRowStripes: !!s.showRowStripes, showColumnStripes: !!s.showColumnStripes, showFirstColumn: !!s.showFirstColumn, showLastColumn: !!s.showLastColumn};
}

/** The style a table gives a cell (merged over the cell's own: explicit fills and colours win). `own` is a resolved style. */
export function tableCellStyle(hit, row, col, own) {
  const {table: t, range} = hit;
  const st = styleInfo(t);
  const lk = tableLook(st.name);
  const headerRow = t.headerRow !== false, totalsRow = !!t.totalsRow;
  const isHeader = headerRow && row === range.start.row;
  const isTotal = totalsRow && row === range.end.row;
  const dataRow = Math.max(0, row - (range.start.row + (headerRow ? 1 : 0)));
  const dataCol = col - range.start.col;
  const explicitFill = own.fill.pattern !== 'none';
  const patch = {};
  const setFont = v => { patch.font = {...(patch.font ?? {}), ...v}; };
  const solid = c => ({pattern: 'solid', fg: c, bg: null});
  const darkStyle = st.name.startsWith('TableStyleDark');
  if (isHeader) {
    if (lk.headerFill && !explicitFill) patch.fill = solid(lk.headerFill);
    if (own.font.color === null && lk.headerFont) setFont({color: lk.headerFont});
    setFont({bold: own.font.bold || lk.headerBold});
    if (lk.line) patch.borders = {bottom: {style: 'thin', color: lk.line}};
  } else if (isTotal) {
    setFont({bold: true});
    if (lk.totalTop) patch.borders = {top: {style: 'double', color: lk.totalTop}};
  } else {
    const band = (st.showRowStripes && dataRow % 2 === 0) || (st.showColumnStripes && dataCol % 2 === 0);
    if (!explicitFill) {
      if (band) { if (lk.bandFill) patch.fill = solid(lk.bandFill); } else if (lk.bodyFill) patch.fill = solid(lk.bodyFill);
    }
    if (lk.line && st.name.includes('Light') && row === range.end.row) patch.borders = {bottom: {style: 'thin', color: lk.line}};
  }
  if ((st.showFirstColumn && col === range.start.col) || (st.showLastColumn && col === range.end.col)) setFont({bold: true});
  if (darkStyle && !isHeader && own.font.color === null) setFont({color: theme(0, 0)});
  return Object.keys(patch).length ? mergeStyle(own, patch) : own;
}
