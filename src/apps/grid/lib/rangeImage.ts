// A range of a sheet drawn to a canvas or a PNG: for the host (`renderRange`: Copy as Picture and Paste as Picture) and for Linked Pictures,
// which the worksheet draws live from their range. The cells are painted by the same painter as the worksheet (fonts, fills, borders, number
// formats, merges, conditional formats, pictures), as shown on screen: gridlines when the sheet shows them, no headings, no selection, no
// frozen panes. Not in gridcraft (not checked against upstream).

import {Geo} from '../surface/geo';
import {paintGrid} from '../surface/paint';
import {engineFor} from '../../../../core/grid/model/calc.mjs';

export interface RangeImage { dataUrl: string; width: number; height: number }
export interface RangeCanvas { canvas: HTMLCanvasElement; width: number; height: number; pending: boolean }
type Range = {start: {row: number; col: number}; end: {row: number; col: number}};

/** The largest picture made (device pixels on a side), so a whole-column copy cannot ask for gigabytes. */
const MAX_SIDE = 8000;
/** A picture of a range that holds a linked picture of its own is not drawn again inside itself. */
let depth = 0;
export const drawingRange = () => depth > 0;

export function rangeCanvas(content: any, si: number, range: Range, scale = 2): RangeCanvas | null {
  if (depth > 0) return null;
  const sheet = content.sheets[si];
  if (!sheet) return null;
  // The sheet as a picture of itself: no frozen panes, no headings, no outline bands.
  const flat = {...sheet, freeze: undefined, showOutlineSymbols: false, showHeadings: false};
  const probe = new Geo(flat, {x: 0, y: 0, w: 100, h: 100}, 0, 0, 100);
  let w = 0, h = 0;
  for (let c = range.start.col; c <= range.end.col; c++) w += probe.colWidth(c);
  for (let r = range.start.row; r <= range.end.row; r++) h += probe.rowHeight(r);
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const z = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h);
  const geo = new Geo(flat, {x: 0, y: 0, w: w * z, h: h * z}, probe.scrollLeftOf(range.start.col), probe.scrollTopOf(range.start.row), 100 * z);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * z)); canvas.height = Math.max(1, Math.round(h * z));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // A cell far outside the picture is the active one, so no selection is drawn on it.
  const away = {row: range.end.row + 1000, col: range.end.col + 1000};
  const out: RangeCanvas = {canvas, width: Math.round(w), height: Math.round(h), pending: false};
  depth++;
  try {
    paintGrid({
      ctx, geo, content, si, engine: engineFor(content), sel: {active: away, anchor: away, ranges: []}, editing: null, refs: [], fillTarget: null,
      showFillHandle: false, resize: null, circles: [], arrow: null, arrowOpen: false, filterOpen: null, selectedObject: null, liveObject: null,
      ready: () => { out.pending = true; },
    } as any);
  } finally { depth--; }
  return out;
}

export async function rangeImage(content: any, si: number, range: Range, scale = 2): Promise<RangeImage> {
  let r = rangeCanvas(content, si, range, scale);
  if (!r) throw new Error('a picture cannot be drawn here');
  // Pictures on the sheet load as they are first drawn: a second pass puts them in.
  if (r.pending) { await new Promise(res => setTimeout(res, 60)); r = rangeCanvas(content, si, range, scale) ?? r; }
  return {dataUrl: r.canvas.toDataURL('image/png'), width: r.width, height: r.height};
}
