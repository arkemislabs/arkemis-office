// PivotTable timelines: the periods a timeline shows for a date field, what a selection of them filters, and how a timeline is laid out.
// Not in gridcraft (it has no timelines): Excel's behaviour, not checked against upstream. No DOM, no Node built-ins.
//
// A timeline is stored with the slicers of its sheet (sheet.slicers[], `timeline: true`): {id, timeline, pivot, pivots, field, caption, anchor, level, from, until, scroll,
// style}. `level` is years, quarters, months or days; `from` and `until` are serials (the filter keeps dates from `from` up to, not including, `until`), both null while it
// shows all periods. The filter is written to each connected PivotTable as `dateFilters` ([{field, from, until}]), which the report reads (lib/pivot.mjs).

import {datetimeFromSerial, serialFromYmd} from './date.mjs';
import {pivotByName} from './slicer.mjs';
import {readSource} from './pivot.mjs';

export const TIME_LEVELS = Object.freeze(['years', 'quarters', 'months', 'days']);
export const TIME_LEVEL_LABEL = Object.freeze({years: 'YEARS', quarters: 'QUARTERS', months: 'MONTHS', days: 'DAYS'});
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MAX_PERIODS = 5000;
const sysOf = content => (content.dateSystem === 1904 ? 1904 : 1900);

/** The serial of the start of the period of `level` that holds `serial`. */
export function periodStart(sys, serial, level) {
  const d = datetimeFromSerial(sys, Math.floor(serial));
  if (!d) return null;
  switch (level) {
    case 'years': return serialFromYmd(sys, d.year, 1, 1);
    case 'quarters': return serialFromYmd(sys, d.year, Math.floor((d.month - 1) / 3) * 3 + 1, 1);
    case 'months': return serialFromYmd(sys, d.year, d.month, 1);
    default: return Math.floor(serial);
  }
}
/** The start of the period after the one that starts at `start`. */
export function nextStart(sys, start, level) {
  const d = datetimeFromSerial(sys, start);
  if (!d) return null;
  switch (level) {
    case 'years': return serialFromYmd(sys, d.year + 1, 1, 1);
    case 'quarters': return serialFromYmd(sys, d.year, d.month + 3, 1);
    case 'months': return serialFromYmd(sys, d.year, d.month + 1, 1);
    default: return start + 1;
  }
}

/** The label of a period and the heading above it (its year; its month for days). */
function labelOf(sys, start, level) {
  const d = datetimeFromSerial(sys, start);
  switch (level) {
    case 'years': return {label: String(d.year), group: ''};
    case 'quarters': return {label: `Qtr ${Math.floor((d.month - 1) / 3) + 1}`, group: String(d.year)};
    case 'months': return {label: MONTHS[d.month - 1], group: String(d.year)};
    default: return {label: String(d.day), group: `${MONTHS[d.month - 1]} ${d.year}`};
  }
}

/** The date values of a PivotTable's source field: {min, max} (serials), or null when it holds no dates. */
export function dateSpan(content, pivotName, field) {
  const hit = pivotByName(content, pivotName);
  if (!hit) return null;
  try {
    const src = readSource(content, hit[2].source, hit[0]);
    const c = src.col(field);
    if (c < 0 || !src.dates[c]) return null;
    let min = Infinity, max = -Infinity;
    for (const rec of src.rows) { const v = rec[c]; if (typeof v === 'number') { if (v < min) min = v; if (v > max) max = v; } }
    return Number.isFinite(min) ? {min, max} : null;
  } catch { return null; }
}

/** The periods of a timeline at its level, from the first date's to the last date's: [{start, end (exclusive), label, group}]. */
export function timelinePeriods(content, tl) {
  const span = dateSpan(content, tl.pivot, tl.field);
  if (!span) return [];
  const sys = sysOf(content);
  const level = TIME_LEVELS.includes(tl.level) ? tl.level : 'months';
  const out = [];
  let start = periodStart(sys, span.min, level);
  while (start !== null && start <= span.max && out.length < MAX_PERIODS) {
    const end = nextStart(sys, start, level);
    out.push({start, end, ...labelOf(sys, start, level)});
    start = end;
  }
  return out;
}

/** Whether a period is inside a timeline's selection. */
export const periodOn = (tl, p) => (tl.from === null || tl.from === undefined ? true : p.start >= tl.from && (tl.until === null || tl.until === undefined || p.end <= tl.until));

/** The text of a timeline's selection: "All Periods", or "Jan - Mar 2026". */
export function selectionLabel(periods, tl) {
  if (tl.from === null || tl.from === undefined) return 'All Periods';
  const on = periods.filter(p => periodOn(tl, p));
  if (!on.length) return 'No periods';
  const a = on[0], b = on[on.length - 1];
  const name = p => (p.group && tl.level !== 'days' ? `${p.label} ${p.group}` : tl.level === 'days' ? `${p.label} ${p.group}` : p.label);
  return a === b ? name(a) : `${name(a)} - ${name(b)}`;
}

/** The layout of a timeline drawn in `rect` (pixels at zoom `z`) over `periods`. */
export function timelineLayout(rect, tl, periods, z) {
  const head = 28 * z, pad = 6 * z, row = 20 * z, arrow = 14 * z, cell = 44 * z;
  const header = {x: rect.x, y: rect.y, w: rect.w, h: head};
  const btn = 20 * z;
  const clear = {x: rect.x + rect.w - btn - 4 * z, y: rect.y + (head - btn) / 2, w: btn, h: btn};
  const level = {x: rect.x + rect.w - 78 * z - pad, y: rect.y + head + 3 * z, w: 78 * z, h: row - 6 * z};
  const label = {x: rect.x + pad, y: rect.y + head, w: Math.max(0, rect.w - 78 * z - pad * 3), h: row};
  const barY = rect.y + head + row + pad;
  const barH = Math.max(0, Math.min(52 * z, rect.y + rect.h - barY - pad));
  const left = {x: rect.x + pad, y: barY, w: arrow, h: barH}, right = {x: rect.x + rect.w - pad - arrow, y: barY, w: arrow, h: barH};
  const inner = {x: left.x + arrow + 2 * z, y: barY, w: Math.max(0, right.x - 2 * z - (left.x + arrow + 2 * z)), h: barH};
  const fit = Math.max(1, Math.floor(inner.w / cell));
  const first = Math.min(Math.max(0, tl.scroll ?? 0), Math.max(0, periods.length - fit));
  const cells = [];
  for (let i = first; i < Math.min(periods.length, first + fit); i++) cells.push({i, rect: {x: inner.x + (i - first) * cell, y: inner.y, w: cell, h: inner.h}});
  return {header, clear, level, label, left, right, inner, cells, first, fit};
}

/** What a point hits in a timeline: {clear}, {level}, {scroll: -1|1}, {period: index}, or null (the header and frame move it). */
export function timelineHit(layout, x, y) {
  const inside = r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  if (inside(layout.clear)) return {clear: true};
  if (inside(layout.level)) return {level: true};
  if (inside(layout.left)) return {scroll: -1};
  if (inside(layout.right)) return {scroll: 1};
  for (const c of layout.cells) if (inside(c.rect)) return {period: c.i};
  return null;
}
