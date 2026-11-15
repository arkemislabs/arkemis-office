// What floating objects do when rows or columns are inserted or deleted: charts, pictures, shapes and
// slicers follow their anchor cell by their anchor mode, charts and sparklines follow the cells they
// plot.
// Translated from gridcraft crates/engine/src/cmd/sheet.rs (`anchor_corner`, `shift_anchor`, the
// object part of `shift_sheet_features`, and the chart and sparkline source rewrite in `rewrite`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {parse, print, adjust} from './formula.mjs';
import {parseCell, a1} from './addr.mjs';
import {colLeft, rowTop, colAt, rowAt} from '../model/sheet.mjs';

/** A reference text moved for `edit` on the sheet named `target`, as written on the sheet named `host`. */
export function fixRef(text, host, target, edit) {
  try { return print(adjust(parse(String(text)), host, target, edit)); } catch { return text; }
}

/** Where an object's bottom-right corner is on the sheet as it was: its column, row and the offsets in them. */
function corner(sheet, a) {
  const c = parseCell(a.cell) ?? {row: 0, col: 0};
  const x2 = colLeft(sheet, c.col) + (a.dx ?? 0) + Math.max(0, a.width ?? 0);
  const y2 = rowTop(sheet, c.row) + (a.dy ?? 0) + Math.max(0, a.height ?? 0);
  const tc = colAt(sheet, x2), tr = rowAt(sheet, y2);
  return {tc, tr, tdx: x2 - colLeft(sheet, tc), tdy: y2 - rowTop(sheet, tr)};
}

/**
 * One anchor after an insert or delete of lines: absolute objects stay put; "move but do not size" follows its
 * cell and keeps its size; "move and size" is re-fitted to the lines it lands on. A line deleted out from under an
 * edge collapses that edge onto `at`. `post` is the sheet after the edit (it measures the re-fitted size).
 */
export function shiftAnchor(post, a, cn, edit) {
  if (a.mode === 'absolute') return a;
  const {axis, at, count} = edit;
  const rows = axis === 'rows';
  const mapLine = v => (edit.type === 'insert' ? (v >= at ? v + count : v) : v < at ? v : v >= at + count ? v - count : null);
  const c = parseCell(a.cell) ?? {row: 0, col: 0};
  const main = rows ? c.row : c.col;
  const nmain = mapLine(main) ?? at;
  const [nr, nc] = rows ? [nmain, c.col] : [c.row, nmain];
  if (a.mode === 'moveOnly') return {...a, cell: a1(nr, nc)};
  const far = rows ? cn.tr : cn.tc;
  const nfar = mapLine(far) ?? nmain;
  const [nbr, nbc] = rows ? [nfar, cn.tc] : [cn.tr, nfar];
  const x1 = colLeft(post, nc) + (a.dx ?? 0), y1 = rowTop(post, nr) + (a.dy ?? 0);
  const xn = colLeft(post, nbc) + cn.tdx, yn = rowTop(post, nbr) + cn.tdy;
  return {...a, cell: a1(nr, nc), width: Math.max(0, Math.round(xn - x1)), height: Math.max(0, Math.round(yn - y1))};
}

const LISTS = ['charts', 'images', 'shapes', 'slicers'];

/**
 * The objects of the edited sheet `post` moved for a whole-line `edit` (type insert or delete), measured
 * against the sheet as it was (`before`). Returns {charts?, images?, shapes?, slicers?} for the lists that changed.
 */
export function shiftObjects(post, before, edit) {
  const out = {};
  if (edit.type !== 'insert' && edit.type !== 'delete') return out;
  for (const k of LISTS) {
    const list = before[k];
    if (!Array.isArray(list) || !list.length) continue;
    const moved = list.map(o => (o.anchor ? {...o, anchor: shiftAnchor(post, o.anchor, corner(before, o.anchor), edit)} : o));
    if (JSON.stringify(moved) !== JSON.stringify(list)) out[k] = moved;
  }
  return out;
}

/** Charts, sparklines and PivotTable sources of `sheet` (named `host`) with their sources moved for an edit on the sheet named `target`. */
export function rewriteSources(sheet, host, target, edit, withSparklines = true) {
  const out = {};
  if (Array.isArray(sheet.charts) && sheet.charts.length) {
    const fix = t => (t === undefined || t === null ? t : fixRef(t, host, target, edit));
    const charts = sheet.charts.map(c => {
      const next = {...c, series: (c.series ?? []).map(s => {
        const o = {...s, values: fix(s.values)};
        for (const k of ['name', 'categories', 'bubbleSizes']) if (s[k] !== undefined) o[k] = fix(s[k]);
        return o;
      })};
      // The source block moves with its cells; one that was deleted is dropped.
      if (c.source !== undefined) { const src = fix(c.source); if (String(src).includes('#REF!')) delete next.source; else next.source = src; }
      return next;
    });
    if (JSON.stringify(charts) !== JSON.stringify(sheet.charts)) out.charts = charts;
  }
  if (withSparklines && Array.isArray(sheet.sparklines) && sheet.sparklines.length) {
    const sparklines = sheet.sparklines.map(sp => (sp.source ? {...sp, source: fixRef(sp.source, host, target, edit)} : sp));
    if (JSON.stringify(sparklines) !== JSON.stringify(sheet.sparklines)) out.sparklines = sparklines;
  }
  if (withSparklines && Array.isArray(sheet.pivots) && sheet.pivots.length) {
    const pivots = sheet.pivots.map(pt => (typeof pt.source === 'string' && /[!:]/.test(pt.source) ? {...pt, source: fixRef(pt.source, host, target, edit)} : pt));
    if (JSON.stringify(pivots) !== JSON.stringify(sheet.pivots)) out.pivots = pivots;
  }
  return out;
}
