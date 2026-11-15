// What a slicer shows: the distinct values of its table column and which of them are on.
// Translated from gridcraft crates/engine/src/cmd/slicer.rs (`column_values`, `slicer_items`) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {displayAt} from '../model/index.mjs';
import {tableByName, tableRanges} from '../model/sheet.mjs';
import {readSource, distinctLabels} from './pivot.mjs';

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Distinct, non-blank display values of a table column, first seen first. */
export function columnValues(content, si, tableName, column) {
  const tb = tableByName(content, tableName);
  if (!tb) return [];
  const [tsi, t] = tb;
  const ci = (t.columns ?? []).findIndex(c => eq(c.name, column));
  const {data} = tableRanges(t);
  if (ci < 0 || !data) return [];
  const col = data.start.col + ci;
  const seen = new Set(), out = [];
  for (let row = data.start.row; row <= data.end.row; row++) {
    const text = displayAt(content, tsi, row, col).text;
    if (text === '' || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

/** [sheet index, pivot index, pivot] of the PivotTable named `name` (names are unique in a workbook), or null. */
export function pivotByName(content, name) {
  for (let si = 0; si < content.sheets.length; si++) {
    const pi = (content.sheets[si].pivots ?? []).findIndex(pt => eq(pt.name, name));
    if (pi >= 0) return [si, pi, content.sheets[si].pivots[pi]];
  }
  return null;
}

/** A slicer on a PivotTable field (Excel's PivotTable slicer): its PivotTables are `sl.pivots` (the first is `sl.pivot`), its field `sl.field`. */
export const isPivotSlicer = sl => typeof sl?.pivot === 'string';
export const slicerPivots = sl => (Array.isArray(sl.pivots) && sl.pivots.length ? sl.pivots : isPivotSlicer(sl) ? [sl.pivot] : []);

/** The items (labels, as the PivotTable filters them) of a source field of a PivotTable: [] when it cannot be read. */
export function pivotFieldItems(content, name, field) {
  const hit = pivotByName(content, name);
  if (!hit) return [];
  const [si, , pt] = hit;
  try {
    const src = readSource(content, pt.source, si);
    const c = src.col(field);
    if (c < 0) return [];
    const axis = [...pt.rows, ...pt.columns].find(f => eq(f.sourceCol, field));
    return distinctLabels(content, src, c, axis?.dateGroup ?? 'none', 10_000);
  } catch { return []; }
}

/** A slicer's tiles as [{value, on}]; every tile is on when the slicer has no filter. */
export function slicerItems(content, si, sl) {
  const values = isPivotSlicer(sl) ? pivotFieldItems(content, sl.pivot, sl.field) : columnValues(content, si, sl.table, sl.column);
  return values.map(value => ({value, on: sl.selected === null || sl.selected === undefined || sl.selected.some(x => eq(x, value))}));
}

// ---------------------------------------------------------------- Slicer Styles

/** Excel's slicer style names in gallery order. */
export const SLICER_STYLES = Object.freeze([...Array.from({length: 6}, (_, i) => `SlicerStyleLight${i + 1}`), ...Array.from({length: 6}, (_, i) => `SlicerStyleDark${i + 1}`), 'SlicerStyleOther1', 'SlicerStyleOther2']);
export const SLICER_DEFAULT_STYLE = 'SlicerStyleLight1';
/** Excel's timeline style names (the Timeline tab's gallery): the slicer looks under their own names. */
export const TIME_STYLES = Object.freeze(SLICER_STYLES.filter(n => /Light|Dark/.test(n)).map(n => n.replace('SlicerStyle', 'TimeSlicerStyle')));
export const TIME_DEFAULT_STYLE = 'TimeSlicerStyleLight1';
const HUES = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];

/** The colours a slicer style draws with: {frame, body, header, headerText, on, onLine, onText, off, offLine, offText}. */
export function slicerLook(style0) {
  const style = String(style0 ?? '').replace('TimeSlicerStyle', 'SlicerStyle');
  const name = SLICER_STYLES.includes(style) ? style : SLICER_DEFAULT_STYLE;
  const n = Number(name.slice(-1)) - 1;
  if (name.startsWith('SlicerStyleLight')) {
    const h = HUES[n];
    return {frame: h, body: '#ffffff', header: h, headerText: '#ffffff', on: mix(h, 0.7), onLine: h, onText: '#1d2b3a', off: '#f4f4f6', offLine: '#d6d6dc', offText: '#7a7a82'};
  }
  if (name.startsWith('SlicerStyleDark')) {
    const h = HUES[n];
    return {frame: '#404040', body: '#595959', header: '#404040', headerText: '#ffffff', on: h, onLine: h, onText: '#ffffff', off: '#6e6e6e', offLine: '#7a7a7a', offText: '#c8c8c8'};
  }
  return name === 'SlicerStyleOther1'
    ? {frame: '#7f7f7f', body: '#ffffff', header: '#f2f2f2', headerText: '#262626', on: '#d9d9d9', onLine: '#7f7f7f', onText: '#262626', off: '#ffffff', offLine: '#d0d0d0', offText: '#8a8a8a'}
    : {frame: '#2f5597', body: '#ffffff', header: '#dae3f3', headerText: '#1f3864', on: '#8faadc', onLine: '#2f5597', onText: '#1f3864', off: '#f2f2f2', offLine: '#d0d0d0', offText: '#8a8a8a'};
}
/** A colour lightened toward white by `t` (0 keeps it, 1 is white). */
function mix(hex, t) {
  const c = Number.parseInt(hex.slice(1), 16);
  const f = v => Math.round(v + (255 - v) * t);
  return '#' + [(c >> 16) & 255, (c >> 8) & 255, c & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join('');
}

/** The layout of a slicer drawn in `rect` (pixels at zoom `z`): the header, the clear-filter button and the tiles in `columns` columns. */
export function slicerLayout(rect, sl, items, z) {
  const head = 28 * z, pad = 6 * z, gap = 4 * z, tileH = 22 * z;
  const cols = Math.max(1, Math.min(10, sl.columns ?? 1));
  const innerW = Math.max(0, rect.w - pad * 2);
  const tileW = Math.max(1, (innerW - gap * (cols - 1)) / cols);
  const tiles = items.map((it, i) => ({value: it.value, on: it.on, rect: {x: rect.x + pad + (i % cols) * (tileW + gap), y: rect.y + head + pad + Math.floor(i / cols) * (tileH + gap), w: tileW, h: tileH}}));
  const btn = 20 * z;
  return {header: {x: rect.x, y: rect.y, w: rect.w, h: head}, clear: {x: rect.x + rect.w - btn - 4 * z, y: rect.y + (head - btn) / 2, w: btn, h: btn}, tiles};
}

/** What a point hits in a slicer: {clear: true}, {value} of a tile, or null (header and frame move the slicer). */
export function slicerHit(layout, rect, x, y) {
  const inside = r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  if (inside(layout.clear)) return {clear: true};
  for (const t of layout.tiles) if (t.rect.y + t.rect.h <= rect.y + rect.h && inside(t.rect)) return {value: t.value};
  return null;
}
