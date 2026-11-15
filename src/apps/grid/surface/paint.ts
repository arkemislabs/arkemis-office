// Canvas painting of the worksheet: per pane (frozen corner, frozen rows, frozen columns, the
// scrolling part) the gridlines, fills, merged areas, text with overflow into empty neighbours,
// number formats, fonts, wrap and shrink, borders; then headers, the selection with its fill
// handle, reference outlines while a formula is edited, the fill-drag outline and freeze lines.
// Translated from gridcraft crates/ui-egui/src/grid/quadrant.rs (`paint_quadrant`,
// `paint_gridlines`, `paint_backgrounds`, `outside_text_cells`, `paint_cell`,
// `text_overflows_cell`, `paint_borders`), crates/ui-egui/src/grid/cell_paint.rs (`look`,
// `display_text`, `cell_text_y`, `wrapped_cell_text_y`, `center_across_end`, `shrink_font`,
// `paint_border`, `ink_on`), crates/ui-egui/src/grid/selection.rs (`selection_fill`,
// `rect_around`, `paint_selection`) and crates/ui-egui/src/grid/show.rs (headers) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Colours are gridcraft's dark-theme tokens (theme.rs); the sheet itself stays white.

import type {Geo, Rect, Range, Cell} from './geo';
import {headingFontSize} from './geo';
import {colToLetters, MAX_COLS, MAX_ROWS} from '../../../../core/grid/lib/addr.mjs';
import {formatGeneralFit, formatColorRgb} from '../../../../core/grid/lib/numfmt.mjs';
import {GArray, CellError} from '../../../../core/grid/lib/value.mjs';
import {cellAt, forEachCell} from '../../../../core/grid/model/store.mjs';
import {merges as mergesOf} from '../../../../core/grid/model/sheet.mjs';
import {styleAt, sheetView} from '../../../../core/grid/model/workbook.mjs';
import {resolveColor, BORDER_WIDTH} from '../../../../core/grid/model/style.mjs';
import {displayAt} from '../../../../core/grid/model/index.mjs';
import {SHEET_REF_COLORS} from '../../../../core/grid/lib/editor.mjs';
import {paint as paintOutline} from './outline';
import {filterSpace, paintFilterButtons, paintPivotButtons, paintValidationArrow, paintCircles} from './dataUi';
import {pivotButtons} from '../../../../core/grid/lib/pivot.mjs';
import {parseRange} from '../../../../core/grid/lib/addr.mjs';
import {paintObjects, paintCellArt, paintPageBreaks, paintPageBreakPreview, paintNoteBoxes, paintInkOverlay, setHiddenInk, type Live, type InkOverlay} from './objects';
import {tableAt, tableCellStyle} from '../../../../core/grid/lib/table-style.mjs';
import {cfFor, hasCf} from '../../../../core/grid/lib/cond-format.mjs';
import {iconShapes} from '../../../../core/grid/lib/cf-icons.mjs';
import {formatValue} from '../../../../core/grid/lib/numfmt.mjs';

export const T = {
  gridBg: '#ffffff', gridline: '#e1e1e1', desk: '#2b2b2d',
  headerBg: '#303030', headerText: '#cccccc', headerLine: '#454545', headerSelBg: '#454545', headerSelText: '#6fd39a', headerAllBg: '#2e553e',
  selFill: 'rgba(16,124,65,0.14)', selBorder: '#107c41', accent: '#5cc587', freezeLine: '#8a8a8a', cellText: '#000000',
};

export interface PaintInput {
  ctx: CanvasRenderingContext2D;
  geo: Geo;
  content: any;
  si: number;
  engine: any;
  sel: {active: Cell; anchor: Cell; ranges: Range[]};
  /** The cell being edited (its text is hidden under the editor). */
  editing: Cell | null;
  /** References of the formula being edited on this sheet: [{range, color}]. */
  refs: {range: Range; color: number}[];
  fillTarget: Range | null;
  showFillHandle: boolean;
  /** A column or row being resized: the line and its live size in units. */
  resize: {axis: 'cols' | 'rows'; line: number; size: number} | null;
  /** Circle Invalid Data: the cells to circle. */
  circles: Cell[];
  /** The in-cell list arrow of the active cell, and whether its list is open. */
  arrow: Rect | null;
  arrowOpen: boolean;
  /** The header cell whose filter drop-down is open. */
  filterOpen: Cell | null;
  /** The selected floating object, the rectangle it is dragged to, and a repaint request for pictures that load. */
  selectedObject: {kind: string; id: number} | null;
  liveObject: Live;
  /** Every object picked together (Shift or Ctrl click, a group), when there are several. */
  pickedObjects?: {kind: string; id: number}[];
  /** View > Page Break Preview: the pages as they print. */
  pageBreakPreview?: boolean;
  /** The cell under the pointer, and Review > Show All Notes: the notes and comments whose box shows. */
  hoverCell?: Cell | null;
  showAllNotes?: boolean;
  /** The Draw tab's marks (the stroke being drawn, the lasso) and the strokes Ink Replay has not reached. */
  ink?: InkOverlay | null;
  hiddenInk?: Set<number> | null;
  ready: () => void;
}

/** The workbook theme the colours of the frame being painted resolve against (undefined: the default theme). */
let THEME: any;
/** The conditional formats of the sheet being painted (null when it has none). */
let CF: ReturnType<typeof cfFor> | null = null;
const textCache = new Map<string, number>();
function measure(ctx: CanvasRenderingContext2D, font: string, text: string) {
  const k = font + '\u0000' + text;
  let w = textCache.get(k);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    if (textCache.size > 50_000) textCache.clear();
    textCache.set(k, w);
  }
  return w;
}

const rgbCss = (c: any, fallback: string | null) => {
  const rgb = resolveColor(c, THEME);
  return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : fallback;
};

/** CSS font for a cell font at zoom z (points → px). */
export function cssFont(font: any, z: number, sizeOverride?: number) {
  const px = (sizeOverride ?? font.size) * 96 / 72 * z;
  const fam = String(font.name || 'Calibri').replace(/"/g, '');
  return `${font.italic ? 'italic ' : ''}${font.bold ? '700 ' : '400 '}${px.toFixed(2)}px "${fam}", Carlito, "Segoe UI", Arial, sans-serif`;
}

interface Look { style: any; fill: string | null; text: string; cf?: any }
/** A resolved style under a rule's differential format (Excel: only the parts the format sets change). */
function withDxf(st: any, dxf: any) {
  if (!dxf) return st;
  const out = {...st, font: {...st.font, ...(dxf.font ?? {})}, borders: {...st.borders, ...(dxf.borders ?? {})}};
  if (dxf.fill) out.fill = {...st.fill, ...dxf.fill};
  if (dxf.font && dxf.font.color === undefined) out.font.color = st.font.color;
  return out;
}
function look(content: any, sheet: any, row: number, col: number): Look {
  let st = styleAt(content, sheet, row, col);
  // A cell inside a table takes the table style's fill, header and band look unless it has its own.
  const hit = tableAt(sheet, row, col);
  if (hit) st = tableCellStyle(hit, row, col, st);
  const cf = CF ? CF.look(row, col) : null;
  if (cf?.dxf) st = withDxf(st, cf.dxf);
  let fill: string | null = null;
  if (st.fill.pattern === 'solid') fill = rgbCss(st.fill.fg, null);
  else if (st.fill.pattern && st.fill.pattern !== 'none') {
    // Patterns: approximate with a blend of foreground and background (cell_paint.rs `look`).
    const fg = resolveColor(st.fill.fg, THEME) ?? [0, 0, 0], bg = resolveColor(st.fill.bg, THEME) ?? [255, 255, 255];
    fill = `rgb(${Math.round((fg[0] + bg[0] * 3) / 4)},${Math.round((fg[1] + bg[1] * 3) / 4)},${Math.round((fg[2] + bg[2] * 3) / 4)})`;
  }
  if (cf?.fill) fill = `rgb(${cf.fill[0]},${cf.fill[1]},${cf.fill[2]})`;
  return {style: st, fill, text: rgbCss(st.font.color, T.cellText)!, ...(cf ? {cf} : {})};
}

function strokeLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

/** One border segment in its line style (cell_paint.rs `paint_border`). */
export function paintBorder(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number], style: string, color: string) {
  const w = BORDER_WIDTH[style as keyof typeof BORDER_WIDTH] ?? 1;
  if (!w) return;
  ctx.save();
  ctx.strokeStyle = color;
  if (style === 'double') {
    const horiz = Math.abs(a[1] - b[1]) < 0.5;
    const [ox, oy] = horiz ? [0, 1.5] : [1.5, 0];
    ctx.lineWidth = 1;
    strokeLine(ctx, a[0] - ox, a[1] - oy, b[0] - ox, b[1] - oy);
    strokeLine(ctx, a[0] + ox, a[1] + oy, b[0] + ox, b[1] + oy);
  } else {
    ctx.lineWidth = w;
    if (/dash|slant/i.test(style)) ctx.setLineDash(style.includes('DotDot') ? [4, 2, 1, 2, 1, 2] : style.includes('Dot') ? [4, 2, 1, 2] : [4, 2]);
    else if (style === 'dotted' || style === 'hair') ctx.setLineDash([1, 1]);
    strokeLine(ctx, a[0], a[1], b[0], b[1]);
  }
  ctx.restore();
}

const isNumberValue = (v: unknown) => typeof v === 'number';

/** The value shown at a cell (spills included), unwrapped. */
function shownValue(engine: any, si: number, row: number, col: number) {
  const v = engine.sheetValue(si, row, col);
  return v instanceof GArray ? (v.data[0] ?? null) : v;
}

/** Text for a value with General narrowing to the available width (cell_paint.rs `display_text`). */
function displayText(input: PaintInput, row: number, col: number, v: unknown, st: any, widthPx: number, charW: number, cfFmt?: string) {
  const view = sheetView(input.content.sheets[input.si]);
  if (cfFmt) {
    // A conditional format that sets a number format shows the value in it.
    const f = formatValue(v as any, cfFmt, input.content.dateSystem === 1904 ? 1904 : 1900);
    const c = formatColorRgb(f.color);
    return {text: f.text as string, color: c ? `rgb(${c[0]},${c[1]},${c[2]})` : null, numeric: !!f.numeric, fill: f.fill};
  }
  if (!view.showFormulas && st.numFmt === 'General' && typeof v === 'number') {
    if (!view.showZeros && v === 0) return {text: '', color: null as string | null, numeric: true, fill: null as any};
    const maxChars = Math.max(1, Math.floor((widthPx - 4) / charW));
    const t = formatGeneralFit(v, Math.min(maxChars, 11));
    return {text: t ?? '#'.repeat(Math.max(maxChars, 1)), color: null, numeric: true, fill: null};
  }
  const f = displayAt(input.content, input.si, row, col, v);
  const c = formatColorRgb(f.color);
  const color = c ? `rgb(${c[0]},${c[1]},${c[2]})` : null;
  return {text: f.text as string, color, numeric: !!f.numeric, fill: f.fill};
}

interface Painted { cell: Cell; rect: Rect; look: Look }

function paintQuadrant(input: PaintInput, rows: [number, number], cols: [number, number], clip: Rect) {
  const {ctx, geo, content, si} = input;
  const sheet = content.sheets[si];
  const view = sheetView(sheet);
  const [r0, r1] = rows, [c0, c1] = cols;
  ctx.save();
  ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
  ctx.fillStyle = T.gridBg; ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
  const near = {start: {row: r0, col: Math.max(c0 - 20, 0)}, end: {row: r1, col: Math.min(c1 + 20, MAX_COLS - 1)}};
  const ms = (mergesOf(sheet) as Range[]).filter(m => m.start.row <= near.end.row && near.start.row <= m.end.row && m.start.col <= near.end.col && near.start.col <= m.end.col);
  const inMerge = (row: number, col: number) => ms.find(m => row >= m.start.row && row <= m.end.row && col >= m.start.col && col <= m.end.col) ?? null;

  // Gridlines.
  if (view.showGridlines) {
    ctx.strokeStyle = T.gridline; ctx.lineWidth = 1;
    const top = geo.y(r0), bottom = geo.y(r1 + 1), left = geo.x(c0), right = geo.x(c1 + 1);
    ctx.beginPath();
    for (let c = c0; c <= c1 + 1; c++) {
      if (c <= c1 && geo.colWidth(c) === 0) continue;
      const x = Math.round(geo.x(c)) - 0.5;
      ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    }
    for (let r = r0; r <= r1 + 1; r++) {
      if (r <= r1 && geo.rowHeight(r) === 0) continue;
      const y = Math.round(geo.y(r)) - 0.5;
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    ctx.stroke();
  }

  // Backgrounds: every visible cell with a fill (or styled), merged areas once.
  const looks: Painted[] = [];
  const seenMerge = new Set<Range>();
  const visit = (row: number, col: number) => {
    if (geo.rowHeight(row) === 0 || geo.colWidth(col) === 0) return;
    const m = inMerge(row, col);
    let rect: Rect, anchor: Cell;
    if (m) {
      if (seenMerge.has(m)) return;
      seenMerge.add(m);
      rect = geo.rangeRect(m); anchor = m.start;
    } else { rect = geo.cellRect({row, col}); anchor = {row, col}; }
    const lk = look(content, sheet, anchor.row, anchor.col);
    if (lk.fill) { ctx.fillStyle = lk.fill; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
    else if (m) { ctx.fillStyle = T.gridBg; ctx.fillRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1); }
    if (lk.cf?.bar) paintDataBar(ctx, rect, lk.cf.bar, geo.z);
    looks.push({cell: anchor, rect, look: lk});
  };
  // Stored cells, styled lines and merges are the only cells that can paint anything.
  const lineStyled = (sheet.rows && Object.values(sheet.rows).some((l: any) => l?.s)) || (sheet.cols && Object.values(sheet.cols).some((l: any) => l?.s));
  if (lineStyled) {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) visit(r, c);
  } else {
    forEachCell(sheet, r0, c0, r1, c1, (row: number, col: number) => { visit(row, col); return true; });
    for (const m of ms) visit(Math.max(m.start.row, r0), Math.max(m.start.col, c0));
    // Cells with no content that a rule colours (Blanks, a formula).
    if (CF) for (const ar of CF.areas()) {
      for (let r = Math.max(ar.start.row, r0); r <= Math.min(ar.end.row, r1); r++) for (let c = Math.max(ar.start.col, c0); c <= Math.min(ar.end.col, c1); c++) {
        if (!cellAt(sheet, r, c) && !inMerge(r, c) && CF.look(r, c)) visit(r, c);
      }
    }
    // Spilled values have no stored cell.
    for (const [ak, range] of input.engine.spillRanges ?? []) {
      void ak;
      const rr = range as Range;
      for (let r = Math.max(rr.start.row, r0); r <= Math.min(rr.end.row, r1); r++) for (let c = Math.max(rr.start.col, c0); c <= Math.min(rr.end.col, c1); c++) {
        if (!cellAt(sheet, r, c)) looks.push({cell: {row: r, col: c}, rect: geo.cellRect({row: r, col: c}), look: look(content, sheet, r, c)});
      }
    }
  }

  // Text that overflows from just outside the pane into it.
  const emptyAt = (row: number, col: number) => {
    const v = shownValue(input.engine, si, row, col);
    return (v === null || v === undefined || v === '') && !inMerge(row, col);
  };
  const outside: Painted[] = [];
  for (let r = r0; r <= r1; r++) {
    if (geo.rowHeight(r) === 0) continue;
    for (let col = c0 - 1; col >= Math.max(c0 - 20, 0); col--) {
      if (!emptyAt(r, col)) { if (geo.colWidth(col) > 0 && (col < geo.fc) === (c0 < geo.fc) && !inMerge(r, col)) outside.push({cell: {row: r, col}, rect: geo.cellRect({row: r, col}), look: look(content, sheet, r, col)}); break; }
    }
    for (let col = c1 + 1; col <= Math.min(c1 + 20, MAX_COLS - 1); col++) {
      if (!emptyAt(r, col)) { if (geo.colWidth(col) > 0 && (col < geo.fc) === (c0 < geo.fc) && !inMerge(r, col)) outside.push({cell: {row: r, col}, rect: geo.cellRect({row: r, col}), look: look(content, sheet, r, col)}); break; }
    }
  }

  for (const p of [...looks, ...outside]) paintCell(input, p, c0, c1, emptyAt, inMerge);

  // Borders: each cell's own edges, merged areas from their edge cells.
  for (const p of looks) {
    const b = p.look.style.borders;
    const m = inMerge(p.cell.row, p.cell.col);
    if (m) {
      const rect = p.rect;
      for (let col = m.start.col; col <= m.end.col; col++) {
        const x0 = geo.x(col), x1 = geo.x(col + 1);
        const top = look(content, sheet, m.start.row, col).style.borders.top, bottom = look(content, sheet, m.end.row, col).style.borders.bottom;
        if (top) paintBorder(ctx, [x0, rect.y], [x1, rect.y], top.style, rgbCss(top.color, '#000')!);
        if (bottom) paintBorder(ctx, [x0, rect.y + rect.h], [x1, rect.y + rect.h], bottom.style, rgbCss(bottom.color, '#000')!);
      }
      for (let row = m.start.row; row <= m.end.row; row++) {
        const y0 = geo.y(row), y1 = geo.y(row + 1);
        const left = look(content, sheet, row, m.start.col).style.borders.left, right = look(content, sheet, row, m.end.col).style.borders.right;
        if (left) paintBorder(ctx, [rect.x, y0], [rect.x, y1], left.style, rgbCss(left.color, '#000')!);
        if (right) paintBorder(ctx, [rect.x + rect.w, y0], [rect.x + rect.w, y1], right.style, rgbCss(right.color, '#000')!);
      }
      continue;
    }
    if (!b) continue;
    const {x, y, w, h} = p.rect;
    const X0 = Math.round(x) - 0.5, Y0 = Math.round(y) - 0.5, X1 = Math.round(x + w) - 0.5, Y1 = Math.round(y + h) - 0.5;
    if (b.top) paintBorder(ctx, [X0, Y0], [X1, Y0], b.top.style, rgbCss(b.top.color, '#000')!);
    if (b.bottom) paintBorder(ctx, [X0, Y1], [X1, Y1], b.bottom.style, rgbCss(b.bottom.color, '#000')!);
    if (b.left) paintBorder(ctx, [X0, Y0], [X0, Y1], b.left.style, rgbCss(b.left.color, '#000')!);
    if (b.right) paintBorder(ctx, [X1, Y0], [X1, Y1], b.right.style, rgbCss(b.right.color, '#000')!);
    if (b.diagDown) paintBorder(ctx, [X0, Y0], [X1, Y1], b.diagDown.style, rgbCss(b.diagDown.color, '#000')!);
    if (b.diagUp) paintBorder(ctx, [X0, Y1], [X1, Y0], b.diagUp.style, rgbCss(b.diagUp.color, '#000')!);
  }
  ctx.restore();
}

function paintCell(input: PaintInput, p: Painted, c0: number, c1: number, emptyAt: (r: number, c: number) => boolean, inMerge: (r: number, c: number) => Range | null) {
  const {ctx, geo, si, engine} = input;
  const {cell: c, rect: rect0, look: lk} = p;
  // A header cell with a filter button keeps its text clear of the button, and does not run into its neighbours.
  const fSpace = filterSpace(input.content.sheets[input.si], c.row, c.col, geo.z) * geo.z;
  const rect = fSpace > 0 ? {...rect0, w: Math.max(rect0.w - fSpace, 1)} : rect0;
  if (input.editing && input.editing.row === c.row && input.editing.col === c.col) return;
  const v = shownValue(engine, si, c.row, c.col);
  if (v === null || v === undefined || v === '') return;
  const st = lk.style;
  const z = geo.z;
  const icon = lk.cf?.icon ? paintCfIcon(ctx, rect, lk.cf.icon, z) : 0;
  if (lk.cf?.hideValue) return;
  if (st.numFmt === 'checkbox' && typeof v === 'boolean') {
    const s = Math.min(Math.max(11 * z * 1.2, 8), 24);
    const bx = rect.x + rect.w / 2 - s / 2, by = rect.y + rect.h / 2 - s / 2;
    ctx.fillStyle = v ? '#107c41' : '#ffffff'; ctx.fillRect(bx, by, s, s);
    ctx.strokeStyle = v ? '#107c41' : '#6e6e6e'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, s - 1, s - 1);
    if (v) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(bx + s * 0.22, by + s * 0.52); ctx.lineTo(bx + s * 0.42, by + s * 0.72); ctx.lineTo(bx + s * 0.78, by + s * 0.3); ctx.stroke(); }
    return;
  }
  let font = cssFont(st.font, z);
  const charW = Math.max(measure(ctx, font, '0'), 1);
  const avail = rect.w;
  const shown = displayText(input, c.row, c.col, v, st, avail, charW, lk.cf?.dxf?.numFmt);
  let text = shown.text;
  if (!text) return;
  const color = shown.color ?? lk.text;
  const h0 = st.align.h;
  const halign = h0 === 'general'
    ? (isNumberValue(v) ? 'right' : typeof v === 'boolean' || v instanceof CellError ? 'center' : shown.numeric ? 'right' : 'left')
    : h0;
  const indent = (st.align.indent ?? 0) * 9 * z + (halign === 'left' || halign === 'justify' ? icon : 0);
  const pad = 2.5 * z;
  const sizePx = st.font.size * 96 / 72 * z;
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  const ascent = sizePx * 0.78, lineH = sizePx * 1.22;
  if (st.align.wrap || h0 === 'justify') {
    // Wrapped text: words broken to the cell width, lines placed per vertical alignment.
    const wrapW = Math.max(rect.w - 2 * pad - indent, 4);
    const lines: string[] = [];
    for (const para of text.split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (line && measure(ctx, font, next.trimEnd()) > wrapW) { lines.push(line.trimEnd()); line = word.trimStart(); }
        else line = next;
        // A single word wider than the cell breaks between characters.
        while (measure(ctx, font, line.trimEnd()) > wrapW && line.trimEnd().length > 1) {
          let k = line.trimEnd().length - 1;
          while (k > 1 && measure(ctx, font, line.slice(0, k)) > wrapW) k--;
          lines.push(line.slice(0, k)); line = line.slice(k).trimStart();
        }
      }
      lines.push(line);
    }
    const gh = lines.length * lineH;
    const padV = 1.5 * z;
    const yTop = rect.y + padV, yBottom = rect.y + rect.h - gh - padV;
    let y = st.align.v === 'top' ? yTop : st.align.v === 'bottom' ? yBottom : (yTop + yBottom) / 2;
    ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    ctx.font = font;
    for (const line of lines) {
      const w = measure(ctx, font, line);
      const x = halign === 'center' || halign === 'centerAcross' ? rect.x + rect.w / 2 - w / 2 : halign === 'right' ? rect.x + rect.w - pad - w : rect.x + pad + indent;
      ctx.fillText(line, x, y + ascent + (lineH - sizePx) / 2);
      decorate(ctx, st.font, x, y + ascent + (lineH - sizePx) / 2, w, sizePx, color);
      y += lineH;
    }
    ctx.restore();
    return;
  }
  let firstLine = text.replace(/[\r\n]/g, '');
  // Shrink to fit.
  if (st.align.shrink && h0 !== 'fill' && !shown.fill) {
    const natural = measure(ctx, font, firstLine), room = Math.max(avail - 2 * pad - indent, 1);
    if (natural > room) font = cssFont(st.font, z, Math.max(st.font.size * room / natural * 0.97, 1));
  }
  let w = measure(ctx, font, firstLine);
  const hashed = (shown.numeric || isNumberValue(v)) && w > avail - 2 * pad && h0 !== 'fill' && !st.align.shrink;
  if (hashed) {
    const hw = Math.max(measure(ctx, font, '#'), 1);
    firstLine = '#'.repeat(Math.max(1, Math.floor((avail - 2 * pad) / hw)));
    w = measure(ctx, font, firstLine);
  } else if (shown.fill && Array.isArray(shown.fill)) {
    // `*x` repeats x to fill the cell.
    const [ch, pos] = shown.fill as [string, number];
    const cw = Math.max(measure(ctx, font, ch), 1);
    const n = Math.max(0, Math.floor((avail - 2 * pad - w) / cw));
    firstLine = firstLine.slice(0, pos) + ch.repeat(n) + firstLine.slice(pos);
    w = measure(ctx, font, firstLine);
  } else if (h0 === 'fill') {
    const n = Math.max(1, Math.floor((avail - 2 * pad) / Math.max(w, 1)));
    firstLine = firstLine.repeat(n); w = measure(ctx, font, firstLine);
  }
  // Center Across Selection runs over following empty cells that are also Center Across.
  let acrossEnd = c.col;
  if (halign === 'centerAcross' && !inMerge(c.row, c.col)) {
    while (acrossEnd < c1 + 20 && acrossEnd + 1 < MAX_COLS && emptyAt(c.row, acrossEnd + 1)
      && styleAt(input.content, input.content.sheets[si], c.row, acrossEnd + 1).align.h === 'centerAcross') acrossEnd++;
  }
  let clip = rect;
  const overflows = fSpace === 0 && !shown.numeric && !isNumberValue(v) && Math.abs(st.align.rotation ?? 0) !== 90 && w > rect.w - 2 * pad;
  if ((overflows || acrossEnd > c.col) && !inMerge(c.row, c.col)) {
    let right = rect.x + rect.w, left = rect.x;
    if (acrossEnd > c.col) right = geo.x(acrossEnd + 1);
    if (halign === 'left' || halign === 'center' || halign === 'justify') {
      let cc = c.col + 1;
      while (right - rect.x < w + 2 * pad && cc < MAX_COLS && emptyAt(c.row, cc) && cc <= c1 + 20) { right = geo.x(cc + 1); cc++; }
    }
    if (halign === 'right' || halign === 'center') {
      let cc = c.col;
      while (rect.x + rect.w - left < w + 2 * pad && cc > 0 && emptyAt(c.row, cc - 1) && cc + 20 > c0) { cc--; left = geo.x(cc); }
    }
    clip = {x: left, y: rect.y, w: right - left, h: rect.h};
    if (!p.look.fill) {
      // Text running over a neighbour hides that neighbour's gridline.
      ctx.fillStyle = T.gridBg;
      if (rect.x - left > 0) ctx.fillRect(left + 1, rect.y + 0.5, rect.x - left, rect.h - 1.5);
      if (right - (rect.x + rect.w) > 0) ctx.fillRect(rect.x + rect.w - 1, rect.y + 0.5, right - rect.x - rect.w, rect.h - 1.5);
      ctx.fillStyle = color;
    }
  }
  const box = acrossEnd > c.col ? {x: rect.x, y: rect.y, w: geo.x(acrossEnd + 1) - rect.x, h: rect.h} : clip.w > rect.w && halign === 'center' ? clip : rect;
  let x: number;
  if (halign === 'center' || halign === 'centerAcross' || halign === 'distributed') x = box.x + box.w / 2 - w / 2;
  else if (halign === 'right') x = rect.x + rect.w - pad - indent - w;
  else x = rect.x + pad + indent;
  // Bottom (default) sits on the cell's bottom edge, Top under its top, Center in between (cell_text_y).
  const gh = sizePx * 1.2;
  const yTop = rect.y - 1 * z, yBottom = Math.max(rect.y + rect.h - gh - 0.5 * z, yTop);
  const yBox = st.align.v === 'top' ? yTop + 1.5 * z : st.align.v === 'center' || st.align.v === 'justify' || st.align.v === 'distributed' ? (yTop + yBottom) / 2 : yBottom;
  const baseline = yBox + gh * 0.5 + sizePx * 0.36;
  ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip();
  ctx.font = font;
  ctx.fillStyle = color;
  const rot = st.align.rotation ?? 0;
  if (rot && rot !== 255) {
    const angle = -(rot > 90 ? -(rot - 90) : rot) * Math.PI / 180;
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.rotate(angle);
    ctx.fillText(firstLine, -w / 2, sizePx * 0.36);
  } else {
    ctx.fillText(firstLine, x, baseline);
    decorate(ctx, st.font, x, baseline, w, sizePx, color);
  }
  ctx.restore();
}

/** A data bar inside its cell: the bar's share of the width in the rule's colour, a fade or a solid with an edge (Excel). */
function paintDataBar(ctx: CanvasRenderingContext2D, rect: Rect, bar: {fraction: number; color: number[]; gradient: boolean}, z: number) {
  const pad = Math.max(2 * z, 1.5);
  const full = rect.w - 2 * pad;
  if (full <= 0 || rect.h <= 2 * pad) return;
  const w = Math.max(full * bar.fraction, 1), x = rect.x + pad, y = rect.y + pad, h = rect.h - 2 * pad;
  const [r, g, b] = bar.color;
  ctx.save();
  if (bar.gradient) {
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, `rgb(${r},${g},${b})`); grad.addColorStop(1, `rgba(${r},${g},${b},0.18)`);
    ctx.fillStyle = grad; ctx.fillRect(x, y, w, h);
  } else {
    ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = `rgb(${Math.round(r * 0.78)},${Math.round(g * 0.78)},${Math.round(b * 0.78)})`; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(w - 1, 0), h - 1);
  }
  ctx.restore();
}

/** An icon-set icon at the cell's left edge (the shapes are shared with the ribbon's tiles); returns the room it takes. */
function paintCfIcon(ctx: CanvasRenderingContext2D, rect: Rect, icon: {set: string; index: number}, z: number) {
  const size = Math.min(Math.max(13 * z, 8), rect.h - 2);
  if (size < 6) return 0;
  const x = rect.x + 2 * z, y = rect.y + (rect.h - size) / 2;
  ctx.save();
  ctx.translate(x, y); ctx.scale(size / 16, size / 16);
  for (const sh of iconShapes(icon.set, icon.index) as {d: string; fill?: string; stroke?: string; sw?: number}[]) {
    const path = new Path2D(sh.d);
    if (sh.fill && sh.fill !== 'none') { ctx.fillStyle = sh.fill; ctx.fill(path); }
    if (sh.stroke) { ctx.strokeStyle = sh.stroke; ctx.lineWidth = sh.sw ?? 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(path); }
  }
  ctx.restore();
  return size + 4 * z;
}

/** Underline (single, double, accounting) and strikethrough lines under a run of text. */
function decorate(ctx: CanvasRenderingContext2D, font: any, x: number, baseline: number, w: number, sizePx: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, sizePx / 15);
  const u = font.underline;
  if (u && u !== 'none') {
    const y = Math.round(baseline + sizePx * (u.endsWith('Accounting') ? 0.22 : 0.12)) + 0.5;
    strokeLine(ctx, x, y, x + w, y);
    if (u.startsWith('double')) strokeLine(ctx, x, y + 2, x + w, y + 2);
  }
  if (font.strike) { const y = Math.round(baseline - sizePx * 0.3) + 0.5; strokeLine(ctx, x, y, x + w, y); }
}

/** The rectangles shaded for a selection: every area except the active cell (selection.rs). */
function rectAround(area: Rect, hole: Rect): Rect[] {
  const out: Rect[] = [];
  const top = Math.max(area.y, Math.min(hole.y, area.y + area.h)), bottom = Math.min(area.y + area.h, Math.max(hole.y + hole.h, area.y));
  if (top > area.y) out.push({x: area.x, y: area.y, w: area.w, h: top - area.y});
  if (area.y + area.h > bottom) out.push({x: area.x, y: bottom, w: area.w, h: area.y + area.h - bottom});
  const left = Math.max(area.x, Math.min(hole.x, area.x + area.w)), right = Math.min(area.x + area.w, Math.max(hole.x + hole.w, area.x));
  if (bottom > top) {
    if (left > area.x) out.push({x: area.x, y: top, w: left - area.x, h: bottom - top});
    if (area.x + area.w > right) out.push({x: right, y: top, w: area.x + area.w - right, h: bottom - top});
  }
  return out.filter(r => r.w > 0 && r.h > 0 && [r.x, r.y, r.w, r.h].every(Number.isFinite));
}

const clampRect = (r: Rect, c: Rect): Rect | null => {
  const x0 = Math.max(r.x, c.x - 4), y0 = Math.max(r.y, c.y - 4), x1 = Math.min(r.x + r.w, c.x + c.w + 4), y1 = Math.min(r.y + r.h, c.y + c.h + 4);
  return x1 > x0 && y1 > y0 ? {x: x0, y: y0, w: x1 - x0, h: y1 - y0} : null;
};

function activeRect(geo: Geo, sheet: any, active: Cell): Rect {
  const m = (mergesOf(sheet) as Range[]).find(x => active.row >= x.start.row && active.row <= x.end.row && active.col >= x.start.col && active.col <= x.end.col);
  return m ? geo.rangeRect(m) : geo.cellRect(active);
}

function paintSelection(input: PaintInput) {
  const {ctx, geo} = input;
  const sheet = input.content.sheets[input.si];
  const sel = input.sel;
  const hole = activeRect(geo, sheet, sel.active);
  const cur = sel.ranges[sel.ranges.length - 1];
  for (const r of sel.ranges) {
    for (const pane of geo.rangePanes(r)) {
      ctx.save();
      ctx.beginPath(); ctx.rect(pane.x, pane.y, pane.w, pane.h); ctx.clip();
      const rr = clampRect(geo.rangeRect(r), pane);
      const single = sel.ranges.length === 1 && r.start.row === r.end.row && r.start.col === r.end.col;
      if (rr && !single) {
        ctx.fillStyle = T.selFill;
        for (const piece of rectAround(rr, hole)) ctx.fillRect(piece.x, piece.y, piece.w, piece.h);
      }
      if (r === cur && rr) {
        ctx.strokeStyle = T.selBorder; ctx.lineWidth = 2;
        const full = geo.rangeRect(r);
        const o = clampRect({x: full.x, y: full.y, w: full.w, h: full.h}, pane) ?? full;
        ctx.strokeRect(Math.round(o.x) - 0.5, Math.round(o.y) - 0.5, Math.round(o.w), Math.round(o.h));
        if (input.showFillHandle && r.end.row < MAX_ROWS && r.end.col < MAX_COLS) {
          const hx = full.x + full.w, hy = full.y + full.h;
          ctx.fillStyle = '#ffffff'; ctx.fillRect(hx - 4.5, hy - 4.5, 8, 8);
          ctx.fillStyle = T.selBorder; ctx.fillRect(hx - 3.5, hy - 3.5, 6, 6);
        }
      }
      ctx.restore();
    }
  }
  // The active cell inside a multi-area selection keeps a thin outline.
  if (sel.ranges.length > 1) { ctx.strokeStyle = T.selBorder; ctx.lineWidth = 1; ctx.strokeRect(Math.round(hole.x) + 0.5, Math.round(hole.y) + 0.5, Math.round(hole.w) - 1, Math.round(hole.h) - 1); }
}

function paintRefs(input: PaintInput) {
  const {ctx, geo} = input;
  for (const {range, color} of input.refs) {
    const col = SHEET_REF_COLORS[color % SHEET_REF_COLORS.length];
    for (const pane of geo.rangePanes(range)) {
      ctx.save(); ctx.beginPath(); ctx.rect(pane.x, pane.y, pane.w, pane.h); ctx.clip();
      const r = geo.rangeRect(range);
      ctx.fillStyle = col + '1f'; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
      ctx.fillStyle = col;
      for (const [hx, hy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) ctx.fillRect(hx - 2.5, hy - 2.5, 5, 5);
      ctx.restore();
    }
  }
}

function paintHeaders(input: PaintInput) {
  const {ctx, geo} = input;
  if (!geo.headerH && !geo.headerW) return;
  const sel = input.sel;
  const z = geo.z;
  const fontPx = headingFontSize(z);
  const font = `400 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
  const selRows = (r: number) => sel.ranges.some(x => r >= x.start.row && r <= x.end.row);
  const selCols = (c: number) => sel.ranges.some(x => c >= x.start.col && c <= x.end.col);
  const fullRow = (r: number) => sel.ranges.some(x => x.start.col === 0 && x.end.col === MAX_COLS - 1 && r >= x.start.row && r <= x.end.row);
  const fullCol = (c: number) => sel.ranges.some(x => x.start.row === 0 && x.end.row === MAX_ROWS - 1 && c >= x.start.col && c <= x.end.col);
  ctx.save();
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const live = (axis: 'cols' | 'rows', line: number, size: number) => (input.resize && input.resize.axis === axis && input.resize.line === line ? input.resize.size : size);
  // Column headers per pane.
  const top = geo.cells.y - geo.headerH;
  const colParts: [number, number, number, number][] = [];
  if (geo.fc > 0) colParts.push([0, geo.fc - 1, geo.cells.x, geo.cells.x + geo.frozenW]);
  const sc = geo.scrollCols();
  colParts.push([sc[0], sc[1], geo.cells.x + geo.frozenW, geo.cells.x + geo.cells.w]);
  ctx.fillStyle = T.headerBg; ctx.fillRect(geo.cells.x, top, geo.cells.w, geo.headerH);
  for (const [a, b, x0, x1] of colParts) {
    ctx.save(); ctx.beginPath(); ctx.rect(x0, top, x1 - x0, geo.headerH); ctx.clip();
    for (let c = a; c <= b; c++) {
      const w = live('cols', c, geo.colWidth(c)) * z;
      if (w <= 0) continue;
      const x = geo.x(c);
      const on = selCols(c);
      if (on) { ctx.fillStyle = fullCol(c) ? T.headerAllBg : T.headerSelBg; ctx.fillRect(x, top, w, geo.headerH); }
      ctx.fillStyle = on ? T.headerSelText : T.headerText;
      ctx.fillText(colToLetters(c), x + w / 2, top + geo.headerH / 2 + 0.5);
      ctx.strokeStyle = T.headerLine; ctx.lineWidth = 1;
      strokeLine(ctx, Math.round(x + w) - 0.5, top + 3, Math.round(x + w) - 0.5, top + geo.headerH);
      if (on) { ctx.fillStyle = T.accent; ctx.fillRect(x, top + geo.headerH - 2, w, 2); }
    }
    ctx.restore();
  }
  // Row numbers turn blue while a filter hides rows of its range (Excel).
  const sheetNow = input.content.sheets[input.si];
  const afr = sheetNow?.autofilter?.range && sheetNow.autofilter.criteria && Object.keys(sheetNow.autofilter.criteria).length ? parseRange(sheetNow.autofilter.range) : null;
  const filteredRows: [number, number] | null = afr ? [afr.start.row, afr.end.row] : null;
  // Row headers per pane.
  const left = geo.cells.x - geo.headerW;
  ctx.fillStyle = T.headerBg; ctx.fillRect(left, geo.cells.y, geo.headerW, geo.cells.h);
  const rowParts: [number, number, number, number][] = [];
  if (geo.fr > 0) rowParts.push([0, geo.fr - 1, geo.cells.y, geo.cells.y + geo.frozenH]);
  const sr = geo.scrollRows();
  rowParts.push([sr[0], sr[1], geo.cells.y + geo.frozenH, geo.cells.y + geo.cells.h]);
  for (const [a, b, y0, y1] of rowParts) {
    ctx.save(); ctx.beginPath(); ctx.rect(left, y0, geo.headerW, y1 - y0); ctx.clip();
    for (let r = a; r <= b; r++) {
      const h = live('rows', r, geo.rowHeight(r)) * z;
      if (h <= 0) continue;
      const y = geo.y(r);
      const on = selRows(r);
      if (on) { ctx.fillStyle = fullRow(r) ? T.headerAllBg : T.headerSelBg; ctx.fillRect(left, y, geo.headerW, h); }
      ctx.fillStyle = on ? T.headerSelText : filteredRows && r > filteredRows[0] && r <= filteredRows[1] ? '#6cb3ff' : T.headerText;
      if (h >= fontPx * 0.8) ctx.fillText(String(r + 1), left + geo.headerW / 2, y + h / 2 + 0.5);
      ctx.strokeStyle = T.headerLine; ctx.lineWidth = 1;
      strokeLine(ctx, left + 3, Math.round(y + h) - 0.5, left + geo.headerW, Math.round(y + h) - 0.5);
      if (on) { ctx.fillStyle = T.accent; ctx.fillRect(left + geo.headerW - 2, y, 2, h); }
    }
    ctx.restore();
  }
  // Select All corner with its triangle.
  ctx.fillStyle = T.headerBg; ctx.fillRect(left, top, geo.headerW, geo.headerH);
  ctx.fillStyle = '#6b6b6b';
  ctx.beginPath(); ctx.moveTo(left + geo.headerW - 4, top + geo.headerH - 4); ctx.lineTo(left + geo.headerW - 4, top + geo.headerH - 14 * Math.min(z, 1.2));
  ctx.lineTo(left + geo.headerW - 4 - 14 * Math.min(z, 1.2), top + geo.headerH - 4); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = T.headerLine;
  strokeLine(ctx, left, top + geo.headerH - 0.5, left + geo.headerW + geo.cells.w, top + geo.headerH - 0.5);
  strokeLine(ctx, left + geo.headerW - 0.5, top, left + geo.headerW - 0.5, top + geo.headerH + geo.cells.h);
  ctx.restore();
}

/** Paints one frame. */
export function paintGrid(input: PaintInput) {
  const {ctx, geo} = input;
  THEME = input.content.theme ?? undefined;
  {
    const sh = input.content.sheets[input.si];
    CF = hasCf(sh) ? cfFor(input.content, input.si) : null;
    if (CF?.empty) CF = null;
  }
  ctx.fillStyle = T.desk;
  ctx.fillRect(geo.rect.x, geo.rect.y, geo.rect.w, geo.rect.h);
  for (const pane of geo.panes()) paintQuadrant(input, pane.rows, pane.cols, pane.clip);
  for (const pane of geo.panes()) {
    ctx.save(); ctx.beginPath(); ctx.rect(pane.clip.x, pane.clip.y, pane.clip.w, pane.clip.h); ctx.clip();
    paintCellArt(ctx, geo, input.content, input.si, input.engine, pane.rows, pane.cols, input.ready);
    paintFilterButtons(ctx, geo, input.content.sheets[input.si], pane.rows, pane.cols, input.filterOpen);
    paintPivotButtons(ctx, geo, pivotButtons(input.content, input.si), pane.rows, pane.cols);
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(geo.cells.x, geo.cells.y, geo.cells.w, geo.cells.h); ctx.clip();
  if (!input.pageBreakPreview) paintPageBreaks(ctx, geo, input.content.sheets[input.si]);
  if (!input.selectedObject) paintSelection(input);
  paintRefs(input);
  setHiddenInk(input.hiddenInk ?? null);
  paintObjects(ctx, geo, input.content, input.si, input.engine, input.selectedObject, input.liveObject, input.ready, input.pickedObjects);
  if (input.ink) paintInkOverlay(ctx, geo, input.content.sheets[input.si], input.ink);
  if (input.circles.length) paintCircles(ctx, geo, input.circles);
  if (input.pageBreakPreview) paintPageBreakPreview(ctx, geo, input.content.sheets[input.si]);
  paintNoteBoxes(ctx, geo, input.content.sheets[input.si], input.hoverCell ?? null, !!input.showAllNotes);
  if (input.fillTarget) {
    for (const pane of geo.rangePanes(input.fillTarget)) {
      ctx.save(); ctx.beginPath(); ctx.rect(pane.x, pane.y, pane.w, pane.h); ctx.clip();
      const r = geo.rangeRect(input.fillTarget);
      ctx.strokeStyle = '#5f5f5f'; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
      ctx.restore();
    }
  }
  // Freeze lines.
  ctx.strokeStyle = T.freezeLine; ctx.lineWidth = 1;
  if (geo.fr > 0) strokeLine(ctx, geo.cells.x, Math.round(geo.cells.y + geo.frozenH) - 0.5, geo.cells.x + geo.cells.w, Math.round(geo.cells.y + geo.frozenH) - 0.5);
  if (geo.fc > 0) strokeLine(ctx, Math.round(geo.cells.x + geo.frozenW) - 0.5, geo.cells.y, Math.round(geo.cells.x + geo.frozenW) - 0.5, geo.cells.y + geo.cells.h);
  if (input.resize) {
    ctx.strokeStyle = T.selBorder; ctx.setLineDash([2, 2]);
    if (input.resize.axis === 'cols') { const x = geo.x(input.resize.line) + input.resize.size * geo.z; strokeLine(ctx, x, geo.cells.y, x, geo.cells.y + geo.cells.h); }
    else { const y = geo.y(input.resize.line) + input.resize.size * geo.z; strokeLine(ctx, geo.cells.x, y, geo.cells.x + geo.cells.w, y); }
  }
  ctx.restore();
  paintHeaders(input);
  if (input.arrow) { ctx.save(); ctx.beginPath(); ctx.rect(geo.cells.x, geo.cells.y, geo.cells.w, geo.cells.h); ctx.clip(); paintValidationArrow(ctx, input.arrow, input.arrowOpen); ctx.restore(); }
  paintOutline(ctx, geo, input.content.sheets[input.si], {bg: T.headerBg, line: T.headerLine, text: T.headerText, button: '#3a3a3d'});
}
