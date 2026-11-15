// The active sheet as a PDF (Excel's Export > PDF, and Save As > PDF): the pages of the print layout (paper, margins, scale or Fit To,
// print area, manual breaks, repeated title rows and columns, centring, gridlines, header and footer), each cell drawn with its
// fill, borders, number format, font (Helvetica; bold and italic), colour and alignment, merged cells as one, text running over
// empty neighbours as it does on screen. Not in gridcraft (its PDF export is its print crate and is not checked against upstream).
// Fonts: a system font read at export time and embedded as a subset (common/lib/pdf-fonts.mjs), with a fallback font for each run of text the
// first one lacks, so Latin, Cyrillic, Greek, Indic and CJK text prints; only a character no installed font has prints as "?". Pictures,
// charts and plain shapes are drawn (lib/pdf-objects.mjs). Limits, said plainly:
// icons, WordArt, ink and slicers are not drawn; printed row and column headings are not drawn.
// U:grid/formats-pdf. No DOM, no Node built-ins.

import {PDFDocument, rgb} from 'pdf-lib';
import {systemFonts} from '../../common/lib/pdf-fonts.mjs';
import {layoutSheet, PX_TO_PT} from '../lib/page-layout.mjs';
import {setupOf, expandHeaderFooter, hfDateTime, hfPageKind, hfText, HF_FIXED_SIDE_MARGIN} from '../lib/page-setup.mjs';
import {colWidth, rowHeight, merges, activeSheetIndex} from '../model/sheet.mjs';
import {cellAt, hasContent} from '../model/store.mjs';
import {styleAt} from '../model/workbook.mjs';
import {resolveColor, BORDER_WIDTH} from '../model/style.mjs';
import {displayAt} from '../model/index.mjs';
import {tableAt, tableCellStyle} from '../lib/table-style.mjs';
import {engineFor} from '../model/calc.mjs';
import {contains} from '../lib/addr.mjs';
import {formatColorRgb} from '../lib/numfmt.mjs';
import {drawObjects, objectTexts} from '../lib/pdf-objects.mjs';

const MAX_PDF_PAGES = 500;
const rgbOf = (c, theme, fallback = null) => { const v = resolveColor(c, theme); return v ? rgb(v[0] / 255, v[1] / 255, v[2] / 255) : fallback; };

/** The rows or columns one page prints: the repeated titles first (when the page starts after them), then its own band. */
function lines(from, to, titleSpan) {
  const out = [];
  if (titleSpan && titleSpan[0] < from) for (let i = titleSpan[0]; i <= Math.min(titleSpan[1], from - 1); i++) out.push(i);
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

export async function write(file) {
  const content = file.content ?? file;
  const si = activeSheetIndex(content);
  const sheet = content.sheets[si];
  const lay = layoutSheet(sheet);
  if (!lay.pages.length) throw new Error('There is nothing to print: the sheet has no data.');
  if (lay.pages.length > MAX_PDF_PAGES) throw new Error(`The sheet would print ${lay.pages.length} pages; set a print area to export at most ${MAX_PDF_PAGES}.`);
  const setup = setupOf(sheet);
  const theme = content.theme ?? undefined;
  const eng = engineFor(content);
  const pdf = await PDFDocument.create();
  const fonts = await systemFonts(pdf);
  const images = new Map();
  const faces = {};
  const pick = (bold, italic) => (faces[(bold ? 1 : 0) + (italic ? 2 : 0)] ??= fonts.face({bold: !!bold, italic: !!italic}));
  const fontFor = bold => pick(bold, false);
  const title = sheet.name ?? 'Sheet';
  pdf.setTitle(String(file.title ?? title));
  const when = hfDateTime(new Date(file.updatedAt ?? Date.now()));
  const mergeList = merges(sheet);
  const total = lay.pages.length;

  for (const page of lay.pages) {
    const L = lay.areas[page.area];
    const pg = pdf.addPage([L.pageW, L.pageH]);
    const k = L.scale * PX_TO_PT;
    const rows = lines(page.range.start.row, page.range.end.row, L.titleRows);
    const cols = lines(page.range.start.col, page.range.end.col, L.titleCols);
    const widthPt = cols.reduce((a, c) => a + colWidth(sheet, c), 0) * k, heightPt = rows.reduce((a, r) => a + rowHeight(sheet, r), 0) * k;
    const [mL, mR, mT, mB] = L.margins;
    const x0 = mL + (setup.centerH ? Math.max(0, (L.pageW - mL - mR - widthPt) / 2) : 0);
    const top = L.pageH - mT - (setup.centerV ? Math.max(0, (L.pageH - mT - mB - heightPt) / 2) : 0);
    const xs = [x0], ys = [top];
    cols.forEach(c => xs.push(xs[xs.length - 1] + colWidth(sheet, c) * k));
    rows.forEach(r => ys.push(ys[ys.length - 1] - rowHeight(sheet, r) * k));
    const colIndex = new Map(cols.map((c, i) => [c, i])), rowIndex = new Map(rows.map((r, i) => [r, i]));

    const look = (r, c) => {
      const st = styleAt(content, sheet, r, c);
      const hit = tableAt(sheet, r, c);
      return hit ? tableCellStyle(hit, r, c, st) : st;
    };
    const stroke = (xa, ya, xb, yb, color, w, style) => {
      const opts = {start: {x: xa, y: ya}, end: {x: xb, y: yb}, thickness: Math.max(0.25, w * k), color};
      if (/dash|slant/i.test(style)) opts.dashArray = [4 * k, 2.5 * k];
      else if (style === 'dotted' || style === 'hair') opts.dashArray = [1 * k, 1 * k];
      pg.drawLine(opts);
    };

    // Fills first, so a neighbour's fill never covers a border.
    const cells = [];
    for (let ri = 0; ri < rows.length; ri++) {
      for (let ci = 0; ci < cols.length; ci++) {
        const r = rows[ri], c = cols[ci];
        const m = mergeList.find(x => contains(x, {row: r, col: c}));
        // A merged area is drawn once, from its first cell on this page.
        if (m && ((m.start.row !== r && rowIndex.has(m.start.row)) || (m.start.col !== c && colIndex.has(m.start.col)))) continue;
        let x1 = xs[ci + 1], y1 = ys[ri + 1];
        if (m) {
          let ce = ci, re = ri;
          while (ce + 1 < cols.length && cols[ce + 1] <= m.end.col) ce++;
          while (re + 1 < rows.length && rows[re + 1] <= m.end.row) re++;
          x1 = xs[ce + 1]; y1 = ys[re + 1];
        }
        const st = look(r, c);
        const fill = st.fill.pattern !== 'none' ? rgbOf(st.fill.fg, theme) : null;
        if (fill && x1 > xs[ci] && y1 < ys[ri]) pg.drawRectangle({x: xs[ci], y: y1, width: x1 - xs[ci], height: ys[ri] - y1, color: fill});
        cells.push({r, c, ci, ri, x1, y1, st, m});
      }
    }
    if (setup.printGridlines) {
      const grey = rgb(0.78, 0.78, 0.78);
      for (const x of xs) pg.drawLine({start: {x, y: top}, end: {x, y: ys[ys.length - 1]}, thickness: 0.25, color: grey});
      for (const y of ys) pg.drawLine({start: {x: x0, y}, end: {x: xs[xs.length - 1], y}, thickness: 0.25, color: grey});
    }

    // Every text this page prints, so the fonts that have its characters are found and embedded first.
    const kind = hfPageKind(setup, page.n);
    const cx = {page: page.n, pages: total, sheet: title, file: String(file.title ?? title), path: '', date: when.date, time: when.time};
    const shownOf = new Map();
    const texts = [];
    for (const d of cells) {
      const v = eng.sheetValue(si, d.r, d.c);
      const shown = displayAt(content, si, d.r, d.c, v);
      shownOf.set(d, {v, shown});
      texts.push(shown.text);
    }
    for (const footer of [false, true]) { const hf = hfText(setup, kind, footer); if (hf) for (const p of expandHeaderFooter(hf, cx)) texts.push(p.text); }
    texts.push(...objectTexts(content, si, sheet, eng));
    await fonts.prepare(texts);

    // Text, a left-aligned value running over the empty cells beside it.
    for (const d of cells) {
      const {r, c, ci, ri, st} = d;
      const {v, shown} = shownOf.get(d);
      const font = pick(st.font.bold, st.font.italic);
      const text = font.clean(shown.text);
      if (!text) continue;
      const fc = shown.color ? formatColorRgb(shown.color) : null;
      const colour = fc ? rgb(fc[0] / 255, fc[1] / 255, fc[2] / 255) : rgbOf(st.font.color, theme, rgb(0, 0, 0));
      const size = Math.max(4, (st.font.size ?? 11) * L.scale);
      const pad = 1.5 * k;
      const cellW = d.x1 - xs[ci], cellH = ys[ri] - d.y1;
      const h = st.align.h === 'general' ? (typeof v === 'number' ? 'right' : 'left') : st.align.h;
      let avail = cellW - 2 * pad;
      let parts = [text];
      if (st.align.wrap) {
        parts = [];
        let cur = '';
        for (const w of text.split(' ')) {
          const next = cur ? `${cur} ${w}` : w;
          if (cur && font.widthOfTextAtSize(next, size) > avail) { parts.push(cur); cur = w; } else cur = next;
        }
        parts.push(cur);
      } else if (!d.m && h === 'left') {
        let cj = ci + 1;
        while (cj < cols.length && font.widthOfTextAtSize(text, size) > avail && !hasContent(cellAt(sheet, r, cols[cj]))) { avail += xs[cj + 1] - xs[cj]; cj++; }
      }
      const lineH = size * 1.2;
      const blockH = parts.length * lineH;
      const yTop = st.align.v === 'top' ? ys[ri] - 1 * k : st.align.v === 'center' ? ys[ri] - (cellH - blockH) / 2 : d.y1 + blockH + 1 * k;
      parts.forEach((w, n) => {
        const width = font.widthOfTextAtSize(w, size);
        const x = h === 'right' ? xs[ci] + cellW - pad - width : h === 'center' || h === 'centerContinuous' ? xs[ci] + (cellW - width) / 2 : xs[ci] + pad;
        const y = yTop - (n + 1) * lineH + size * 0.25;
        if (y < d.y1 - lineH || y > ys[ri] + 1) return;
        font.draw(pg, w, {x, y, size, color: colour});
        const lw = Math.max(0.3, size / 18);
        if (st.font.underline && st.font.underline !== 'none') pg.drawLine({start: {x, y: y - size * 0.12}, end: {x: x + width, y: y - size * 0.12}, thickness: lw, color: colour});
        if (st.font.strike) pg.drawLine({start: {x, y: y + size * 0.3}, end: {x: x + width, y: y + size * 0.3}, thickness: lw, color: colour});
      });
    }

    // Borders on top of the fills and the text.
    for (const d of cells) {
      const {ci, ri, st} = d;
      const edges = [['top', xs[ci], ys[ri], d.x1, ys[ri]], ['bottom', xs[ci], d.y1, d.x1, d.y1], ['left', xs[ci], ys[ri], xs[ci], d.y1], ['right', d.x1, ys[ri], d.x1, d.y1]];
      for (const [side, xa, ya, xb, yb] of edges) {
        const b = st.borders[side];
        if (!b || !b.style || b.style === 'none') continue;
        const col = rgbOf(b.color, theme, rgb(0, 0, 0));
        if (b.style === 'double') {
          const horizontal = ya === yb, o = 1.2 * k;
          stroke(xa - (horizontal ? 0 : o), ya - (horizontal ? o : 0), xb - (horizontal ? 0 : o), yb - (horizontal ? o : 0), col, 0.8, 'thin');
          stroke(xa + (horizontal ? 0 : o), ya + (horizontal ? o : 0), xb + (horizontal ? 0 : o), yb + (horizontal ? o : 0), col, 0.8, 'thin');
        } else stroke(xa, ya, xb, yb, col, BORDER_WIDTH[b.style] ?? 1, b.style);
      }
    }

    // Pictures, charts and shapes that lie on this page's cells.
    const nTitleCols = cols.length - (page.range.end.col - page.range.start.col + 1), nTitleRows = rows.length - (page.range.end.row - page.range.start.row + 1);
    await drawObjects(pdf, pg, images, {content, si, sheet, eng, theme, k, fontFor,
      band: {x: xs[nTitleCols], right: xs[xs.length - 1], top: ys[nTitleRows], bottom: ys[ys.length - 1], firstCol: page.range.start.col, firstRow: page.range.start.row}});

    // Header and footer.
    for (const footer of [false, true]) {
      const text = hfText(setup, kind, footer);
      if (!text) continue;
      const baseline = footer ? (L.margins[5] ?? 36) : L.pageH - (L.margins[4] ?? 36);
      expandHeaderFooter(text, cx).forEach((p, i) => {
        const font = pick(p.bold, p.italic);
        const t = font.clean(p.text);
        if (!t) return;
        const size = p.size ?? 10;
        const width = font.widthOfTextAtSize(t, size);
        const x = i === 0 ? HF_FIXED_SIDE_MARGIN : i === 2 ? L.pageW - HF_FIXED_SIDE_MARGIN - width : (L.pageW - width) / 2;
        font.draw(pg, t, {x, y: footer ? baseline : baseline - size, size, color: rgb(0, 0, 0)});
      });
    }
  }
  return new Uint8Array(await pdf.save());
}
