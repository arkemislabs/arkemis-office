// Print pages: which pages, in what order and how they are laid on the sheets (one page to a sheet at a size, several pages to a sheet, or a booklet), written as a PDF
// of the sheets.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/print
//   range.rs      `select_pages` (a range such as "1-3, 6; 9-7": a range written backwards runs backwards; an empty range is every page), `narrow` (odd or even pages, reversed,
//                 "no pages to print" when nothing is left)
//   settings.rs   Layout (Size with Fit, Actual, Shrink or a custom scale; Multiple with columns, rows, order, border and auto-rotate; Booklet with its subset and binding),
//                 PAPERS, `Layout::multiple` (2, 4, 6, 9, 16 to a sheet, else a near-square grid), Orientation
//   sheets.rs     the sheets: each page drawn into its cell (centered, fitted)
// Not translated: Poster and Label, comments and form fields (only the pages' own content is printed), printing as an image, the system printers: the result is a PDF of the
// sheets, which can be sent to any printer from a viewer. The booklet's page order is the usual saddle-stitch imposition. No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, degrees} from 'pdf-lib';

export const PAPERS = [['US Letter', 612, 792], ['US Legal', 612, 1008], ['Tabloid', 792, 1224], ['A3', 841.89, 1190.55], ['A4', 595.28, 841.89], ['A5', 419.53, 595.28], ['A6', 297.64, 419.53],
  ['A2', 1190.55, 1683.78], ['A1', 1683.78, 2383.94], ['A0', 2383.94, 3370.39]];
export class PrintError extends Error {}

/** range.rs `select_pages` for page numbers: 0-based pages, in the order written. */
export function selectPages(count, range, {subset = 'all', reverse = false} = {}) {
  const pages = [];
  const r = String(range ?? '').trim();
  const pageOf = tok => {
    const t = tok.trim();
    if (!/^\d+$/.test(t)) throw new PrintError(`"${t}" is not a page`);
    const n = Number(t);
    if (n < 1 || n > count) throw new PrintError(`page ${n} is not in the document (${count} pages)`);
    return n - 1;
  };
  if (!r) for (let i = 0; i < count; i++) pages.push(i);
  else {
    for (const part of r.split(/[,;]/).map(x => x.trim()).filter(Boolean)) {
      const dash = part.indexOf('-');
      if (dash < 0) { pages.push(pageOf(part)); continue; }
      const a = part.slice(0, dash).trim(), b = part.slice(dash + 1).trim();
      const from = a ? pageOf(a) : 0, to = b ? pageOf(b) : count - 1;
      if (from <= to) for (let i = from; i <= to; i++) pages.push(i); else for (let i = from; i >= to; i--) pages.push(i);
    }
  }
  let out = subset === 'odd' ? pages.filter(p => p % 2 === 0) : subset === 'even' ? pages.filter(p => p % 2 === 1) : pages;
  if (reverse) out = [...out].reverse();
  if (!out.length) throw new PrintError('there are no pages to print');
  return out;
}

/** settings.rs `Layout::multiple`: the grid for `n` pages to a sheet. */
export function gridFor(n) {
  const known = {2: [1, 2], 4: [2, 2], 6: [2, 3], 9: [3, 3], 16: [4, 4]};
  if (known[n]) return known[n];
  const c = Math.max(1, Math.ceil(Math.sqrt(n)));
  return [c, Math.max(1, Math.ceil(n / c))];
}

/** The order the cells of a grid fill in: a list of [column, row] (row 0 at the top). */
export function cellOrder(cols, rows, order) {
  const cells = [];
  const horizontal = !order.startsWith('vertical') && order !== 'cut-stack';
  if (order === 'cut-stack') for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) cells.push([c, r]);
  else if (horizontal) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([c, r]);
  else for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) cells.push([c, r]);
  if (order === 'horizontal-reversed') return cells.map(([c, r]) => [cols - 1 - c, r]);
  if (order === 'vertical-reversed') return cells.map(([c, r]) => [c, rows - 1 - r]);
  return cells;
}

/** The sides of a booklet: each [left, right] holds a page (0-based among the printed ones) or null for a blank. Saddle-stitch: the first sheet's front has the last page and the first. */
export function bookletSides(count, binding = 'left') {
  const total = Math.ceil(count / 4) * 4;
  const page = i => (i < count ? i : null);
  const sides = [];
  for (let s = 0; s < total / 4; s++) {
    const front = [page(total - 1 - 2 * s), page(2 * s)];
    const back = [page(2 * s + 1), page(total - 2 - 2 * s)];
    sides.push(front, back);
  }
  return binding === 'right' ? sides.map(([a, b]) => [b, a]) : sides;
}

const viewOf = page => {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  return {w: rot % 180 ? box.height : box.width, h: rot % 180 ? box.width : box.height, rot, box};
};

/** Draw `page` (an embedded page of the output) into the cell [x, y, w, h] at `scale` (null: fit), centered; /Rotate is honoured. */
function drawInto(out, sheet, embedded, view, cell, {scale = null, shrink = false, border = false}) {
  const [x, y, w, h] = cell;
  let k = scale ?? Math.min(w / view.w, h / view.h);
  if (shrink) k = Math.min(1, k);
  const dw = view.w * k, dh = view.h * k;
  const ox = x + (w - dw) / 2, oy = y + (h - dh) / 2;
  const {rot} = view;
  // The embedded page is drawn from its crop box origin: turn it by /Rotate about that origin and move it where the rotated page's corner is.
  const pos = rot === 0 ? [ox, oy] : rot === 90 ? [ox, oy + dh] : rot === 180 ? [ox + dw, oy + dh] : [ox + dw, oy];
  sheet.drawPage(embedded, {x: pos[0], y: pos[1], xScale: k, yScale: k, rotate: degrees(-rot)});
  if (border) for (const [a, b] of [[[ox, oy], [ox + dw, oy]], [[ox + dw, oy], [ox + dw, oy + dh]], [[ox + dw, oy + dh], [ox, oy + dh]], [[ox, oy + dh], [ox, oy]]]) sheet.drawLine({start: {x: a[0], y: a[1]}, end: {x: b[0], y: b[1]}, thickness: 0.5});
}

/**
 * The sheets for `pages` (0-based, in the order to print) of `source`, as PDF bytes.
 * @param {{paper: string, orientation: 'auto'|'portrait'|'landscape', handling: 'size'|'multiple'|'booklet', fit: 'fit'|'actual'|'shrink'|'custom', scale: number,
 *   perSheet: number, order: string, border: boolean, booklet: 'both'|'front'|'back', binding: 'left'|'right'}} o
 */
export async function buildSheets(sourceBytes, pages, o) {
  const src = await PDFDocument.load(sourceBytes, {updateMetadata: false, ignoreEncryption: true});
  const out = await PDFDocument.create();
  const srcPages = src.getPages();
  const embeddedPages = await out.embedPages(pages.map(i => srcPages[i]));
  const views = pages.map(i => viewOf(srcPages[i]));
  const paper = PAPERS.find(p => p[0] === o.paper);
  const sizeOf = (landscape, base) => (landscape ? [Math.max(base[0], base[1]), Math.min(base[0], base[1])] : [Math.min(base[0], base[1]), Math.max(base[0], base[1])]);
  if (o.handling === 'size') {
    pages.forEach((_, k) => {
      const v = views[k];
      const base = paper ? [paper[1], paper[2]] : [v.w, v.h];
      const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && v.w > v.h);
      const [W, H] = o.orientation === 'portrait' ? sizeOf(false, base) : sizeOf(landscape, base);
      const sheet = out.addPage([W, H]);
      const scale = o.fit === 'actual' ? 1 : o.fit === 'custom' ? Math.max(0.01, (o.scale || 100) / 100) : null;
      drawInto(out, sheet, embeddedPages[k], v, [0, 0, W, H], {scale, shrink: o.fit === 'shrink'});
    });
  } else if (o.handling === 'multiple') {
    const [cols, rows] = gridFor(o.perSheet);
    const per = cols * rows;
    const base = paper ? [paper[1], paper[2]] : [595.28, 841.89];
    const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && views.filter(v => v.w > v.h).length > views.length / 2);
    const [W, H] = sizeOf(landscape, base);
    const cells = cellOrder(cols, rows, o.order || 'horizontal');
    const margin = 18;
    const cw = (W - 2 * margin) / cols, ch = (H - 2 * margin) / rows;
    for (let s = 0; s < pages.length; s += per) {
      const sheet = out.addPage([W, H]);
      for (let n = 0; n < per && s + n < pages.length; n++) {
        const [c, r] = cells[n];
        drawInto(out, sheet, embeddedPages[s + n], views[s + n], [margin + c * cw + 2, H - margin - (r + 1) * ch + 2, cw - 4, ch - 4], {border: o.border});
      }
    }
  } else {
    const base = paper ? [paper[1], paper[2]] : [595.28, 841.89];
    const [W, H] = sizeOf(true, base);
    const sides = bookletSides(pages.length, o.binding);
    sides.forEach((side, i) => {
      const front = i % 2 === 0;
      if ((o.booklet === 'front' && !front) || (o.booklet === 'back' && front)) return;
      const sheet = out.addPage([W, H]);
      side.forEach((p, k) => { if (p !== null) drawInto(out, sheet, embeddedPages[p], views[p], [k * W / 2 + 6, 6, W / 2 - 12, H - 12], {}); });
    });
  }
  out.setProducer('Arkemis PDF');
  return {bytes: await out.save(), sheets: out.getPageCount()};
}

/**
 * Where each page goes on each sheet, for the Print dialog's preview: the same geometry buildSheets draws (paper, orientation, grid, margins, centring), without the pages.
 * `views` are the {w, h} the printed pages show (after /Rotate), in print order. Returns {total, sheets: [{size: [W, H], cells: [{n, rect: [x, y, w, h]}]}]} with rects in points from
 * the sheet's top left; `n` is the index in `views`, or null for the blank half of a booklet sheet. At most `limit` sheets are laid out; `total` counts them all.
 */
export function sheetPlan(views, o, limit = 60) {
  const paper = PAPERS.find(p => p[0] === o.paper);
  const sizeOf = (landscape, base) => (landscape ? [Math.max(base[0], base[1]), Math.min(base[0], base[1])] : [Math.min(base[0], base[1]), Math.max(base[0], base[1])]);
  const sheets = [];
  let total = 0;
  const add = (size, cells) => { total++; if (sheets.length < limit) sheets.push({size, cells}); };
  const top = (H, x, y, w, h) => [x, H - y - h, w, h];
  if (o.handling === 'multiple') {
    const [cols, rows] = gridFor(o.perSheet);
    const per = cols * rows;
    const base = paper ? [paper[1], paper[2]] : [595.28, 841.89];
    const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && views.filter(v => v.w > v.h).length > views.length / 2);
    const [W, H] = sizeOf(landscape, base);
    const order = cellOrder(cols, rows, o.order || 'horizontal');
    const margin = 18, cw = (W - 2 * margin) / cols, ch = (H - 2 * margin) / rows;
    for (let s = 0; s < views.length; s += per) {
      const cells = [];
      for (let k = 0; k < per && s + k < views.length; k++) {
        const [c, r] = order[k];
        const [x, y, w, h] = [margin + c * cw + 2, margin + r * ch + 2, cw - 4, ch - 4];
        const f = Math.min(w / views[s + k].w, h / views[s + k].h);
        cells.push({n: s + k, rect: [x + (w - views[s + k].w * f) / 2, y + (h - views[s + k].h * f) / 2, views[s + k].w * f, views[s + k].h * f]});
      }
      add([W, H], cells);
    }
  } else if (o.handling === 'booklet') {
    const base = paper ? [paper[1], paper[2]] : [595.28, 841.89];
    const [W, H] = sizeOf(true, base);
    bookletSides(views.length, o.binding).forEach((side, i) => {
      const front = i % 2 === 0;
      if ((o.booklet === 'front' && !front) || (o.booklet === 'back' && front)) return;
      const cells = [];
      side.forEach((p, k) => {
        const [x, y, w, h] = [k * W / 2 + 6, 6, W / 2 - 12, H - 12];
        if (p === null) { cells.push({n: null, rect: [x, y, w, h]}); return; }
        const f = Math.min(w / views[p].w, h / views[p].h);
        cells.push({n: p, rect: [x + (w - views[p].w * f) / 2, y + (h - views[p].h * f) / 2, views[p].w * f, views[p].h * f]});
      });
      add([W, H], cells);
    });
  } else {
    views.forEach((v, n) => {
      const base = paper ? [paper[1], paper[2]] : [v.w, v.h];
      const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && v.w > v.h);
      const [W, H] = o.orientation === 'portrait' ? sizeOf(false, base) : sizeOf(landscape, base);
      if (sheets.length >= limit) { total++; return; }
      let k = o.fit === 'actual' ? 1 : o.fit === 'custom' ? Math.max(0.01, (o.scale || 100) / 100) : Math.min(W / v.w, H / v.h);
      if (o.fit === 'shrink') k = Math.min(1, k);
      add([W, H], [{n, rect: [(W - v.w * k) / 2, (H - v.h * k) / 2, v.w * k, v.h * k]}]);
    });
  }
  return {total, sheets};
}
