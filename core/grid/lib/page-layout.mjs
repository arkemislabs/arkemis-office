// Pagination of a sheet: the print range split into pages the way Excel's default "down, then over" order does,
// honouring the paper, margins, scale or Fit To, manual breaks, repeated titles and printed headings. Used by
// Page Break Preview; the same rule decides the pages of printing.
// Translated from gridcraft crates/engine/src/cmd/print/layout.rs (`paper_size`, `print_range`, `bands`,
// `title_span`, `layout_sheet`, `split_bands`, `segments`) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {colWidth, rowHeight, colAt, rowAt, defaultRowHeight} from '../model/sheet.mjs';
import {usedBounds} from '../model/store.mjs';
import {parseRange} from './addr.mjs';
import {paperPoints, setupOf, fitsToPages, titlesParts} from './page-setup.mjs';
import {sheetObjects, objectRect} from './objects.mjs';

const MAX_ROWS = 1_048_576, MAX_COLS = 16_384;
/** Sheet geometry is in pixels at 96 dpi; paper is in points. */
export const PX_TO_PT = 0.75;
/** Most pages one layout produces. */
export const MAX_PAGES = 2000;

/** Whole rows or columns are trimmed to the used range (`trim_full`). */
function trimFull(sheet, r) {
  const fullCols = r.start.row === 0 && r.end.row === MAX_ROWS - 1, fullRows = r.start.col === 0 && r.end.col === MAX_COLS - 1;
  if (!fullCols && !fullRows) return r;
  const u = usedBounds(sheet);
  if (!u) return {start: {...r.start}, end: {...r.start}};
  const end = {row: Math.min(r.end.row, u.r1), col: Math.min(r.end.col, u.c1)};
  if (end.row < r.start.row || end.col < r.start.col) return {start: {...r.start}, end: {...r.start}};
  return {start: {...r.start}, end};
}

/** The ranges a sheet prints: its print area, else the used range grown to cover floating objects; [] when there is nothing. */
export function printRanges(sheet) {
  if (sheet?.printArea) {
    const out = String(sheet.printArea).split(',').map(x => parseRange(x.trim().replace(/\$/g, ''))).filter(Boolean).map(r => trimFull(sheet, r));
    if (out.length) return out;
  }
  const u = usedBounds(sheet);
  let r = u ? {start: {row: u.r0, col: u.c0}, end: {row: u.r1, col: u.c1}} : null;
  for (const {object} of sheetObjects(sheet)) {
    const b = objectRect(sheet, object.anchor ?? object);
    const a = {start: {row: rowAt(sheet, b.y), col: colAt(sheet, b.x)}, end: {row: rowAt(sheet, b.y + b.h), col: colAt(sheet, b.x + b.w)}};
    r = r ? {start: {row: Math.min(r.start.row, a.start.row), col: Math.min(r.start.col, a.start.col)}, end: {row: Math.max(r.end.row, a.end.row), col: Math.max(r.end.col, a.end.col)}} : a;
  }
  return r ? [r] : [];
}

/** Splits `start..=end` into bands whose sizes fit `avail(bandStart)`; `breaks` force a new band before a line. Stops after `cap` bands. */
export function bands(start, end, size, avail, breaks, cap) {
  const out = [];
  let cur = start, used = 0, room = avail(start), line = start;
  for (;;) {
    const sz = size(line);
    const manual = line > cur && breaks.includes(line);
    if (line > cur && (manual || used + sz > room + 0.01)) {
      out.push([cur, line - 1]);
      if (out.length >= cap) return out;
      cur = line; used = 0; room = avail(line);
    }
    used += sz;
    if (line >= end) break;
    line += 1;
  }
  out.push([cur, end]);
  return out;
}

/** The repeated title rows or columns as an inclusive span, capped like Excel's; null when there are none. */
function titleSpan(text, max) {
  const m = /^(\d+):(\d+)$/.exec(text) ?? null;
  if (!m) return null;
  const a = Math.min(m[1], m[2]) - 1, b = Math.max(m[1], m[2]) - 1;
  if (a >= max || a < 0) return null;
  return [a, Math.min(b, max - 1, a + 499)];
}
function titleColSpan(text) {
  const m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(text);
  if (!m) return null;
  const col = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const a = Math.min(col(m[1]), col(m[2])), b = Math.max(col(m[1]), col(m[2]));
  return a >= MAX_COLS ? null : [a, Math.min(b, MAX_COLS - 1, a + 499)];
}

/** Splits a layout's area into row and column bands that fit its pages, honouring manual breaks, printed headings and repeated titles. */
export function splitBands(sheet, lay, cap) {
  const k = lay.scale * PX_TO_PT;
  const [aw0, ah0] = lay.avail;
  const aw = aw0 / k, ah = ah0 / k;
  const rb = lay.manualBreaks ? [...(lay.setup.rowBreaks ?? [])].sort((x, y) => x - y) : [];
  const cb = lay.manualBreaks ? [...(lay.setup.colBreaks ?? [])].sort((x, y) => x - y) : [];
  const sum = (a, b, f) => { let t = 0; for (let i = a; i <= b; i++) t += f(sheet, i); return t; };
  const titleH = start => (lay.titleRows && lay.titleRows[0] < start ? sum(lay.titleRows[0], Math.min(lay.titleRows[1], start - 1), rowHeight) : 0);
  const titleW = start => (lay.titleCols && lay.titleCols[0] < start ? sum(lay.titleCols[0], Math.min(lay.titleCols[1], start - 1), colWidth) : 0);
  const area = lay.area;
  return {
    rowBands: bands(area.start.row, area.end.row, r => rowHeight(sheet, r), start => Math.max(1, ah - lay.headingH - titleH(start)), rb, cap),
    colBands: bands(area.start.col, area.end.col, c => colWidth(sheet, c), start => Math.max(1, aw - lay.headingW - titleW(start)), cb, cap),
  };
}

/**
 * Paginates one print range of a sheet (`layout_sheet`): {area, scale, rowBands, colBands, pages: [{n, range}] in print order
 * (down, then over), page and printable size in points, repeated title spans, manualBreaks (off when fitted to pages)}.
 */
export function layoutRange(sheet, area, opts = {}) {
  const setup = setupOf(sheet);
  let [pw, ph] = paperPoints(setup.paper);
  if (setup.orientation === 'landscape') [pw, ph] = [ph, pw];
  const inch = k => { const v = setup.margins?.[k]; return (Number.isFinite(v) ? Math.min(20, Math.max(0, v)) : 0.5) * 72; };
  const margins = [inch('left'), inch('right'), inch('top'), inch('bottom'), inch('header'), inch('footer')];
  // Keep at least an inch of printable space.
  for (const [a, b, total] of [[0, 1, pw], [2, 3, ph]]) {
    const s = margins[a] + margins[b];
    if (total - s < 72) { const f = Math.max(0, total - 72) / Math.max(1, s); margins[a] *= f; margins[b] *= f; }
  }
  const avail = [Math.max(36, pw - margins[0] - margins[1]), Math.max(36, ph - margins[2] - margins[3])];
  const parts = titlesParts(sheet?.printTitles);
  const digits = String(area.end.row + 1).length;
  const printHeadings = !!setup.printHeadings;
  const headingW = printHeadings ? 10 + 7 * digits : 0;
  const headingH = printHeadings ? Math.min(60, Math.max(10, defaultRowHeight(sheet))) : 0;
  let fit = null;
  if (opts.fitToPage === true) fit = [1, 1]; else if (opts.fitToPage === false) fit = null; else if (fitsToPages(setup)) fit = [setup.fitWidth ?? 0, setup.fitHeight ?? 0];
  const lay = {sheet, setup, area, pageW: pw, pageH: ph, margins, avail, scale: Math.min(400, Math.max(10, setup.scale ?? 100)) / 100,
    titleRows: titleSpan(parts.rows, MAX_ROWS), titleCols: titleColSpan(parts.cols), headingW, headingH, manualBreaks: !fit, rowBands: [], colBands: [], pages: []};
  const paginate = manual => {
    lay.manualBreaks = manual;
    Object.assign(lay, splitBands(sheet, lay, MAX_PAGES));
    lay.pages = [];
    outer: for (let ci = 0; ci < lay.colBands.length; ci++) {
      for (let ri = 0; ri < lay.rowBands.length; ri++) {
        if (lay.pages.length >= MAX_PAGES) break outer;
        const [r0, r1] = lay.rowBands[ri], [c0, c1] = lay.colBands[ci];
        lay.pages.push({range: {start: {row: r0, col: c0}, end: {row: r1, col: c1}}});
      }
    }
    lay.pages.forEach((p, i) => { p.n = i + 1; });
  };
  if (fit) {
    const [fw, fh] = fit;
    let totalW = headingW, totalH = headingH;
    for (let c = area.start.col; c <= area.end.col; c++) totalW += colWidth(sheet, c);
    if (area.end.row - area.start.row + 1 > 200_000) totalH = Infinity; else for (let r = area.start.row; r <= area.end.row; r++) totalH += rowHeight(sheet, r);
    const sw = fw > 0 ? avail[0] * fw / Math.max(1, totalW * PX_TO_PT) : Infinity;
    const shh = fh > 0 ? avail[1] * fh / Math.max(1, totalH * PX_TO_PT) : Infinity;
    lay.scale = Math.min(1, Math.max(0.1, Math.min(sw, shh)));
    for (let i = 0; i < 40; i++) {
      paginate(false);
      const okW = fw === 0 || lay.colBands.length <= fw, okH = fh === 0 || lay.rowBands.length <= fh;
      if ((okW && okH) || lay.scale <= 0.1) break;
      lay.scale = Math.max(0.1, lay.scale * 0.97);
    }
  } else paginate(true);
  return lay;
}

/** Every page of a sheet: its print ranges laid out one after the other, the pages numbered through (`file.printPreview` pageList). */
export function layoutSheet(sheet, opts = {}) {
  const out = {areas: [], pages: []};
  let n = 0;
  for (const area of printRanges(sheet)) {
    const lay = layoutRange(sheet, area, opts);
    for (const p of lay.pages) { n += 1; out.pages.push({n, range: p.range, area: out.areas.length}); }
    out.areas.push(lay);
  }
  return out;
}
