// Floating objects on the worksheet canvas: charts, pictures, shapes (text boxes, icons), and the
// selection frame with its eight handles; also the cell art drawn inside cells (sparklines, pictures
// in a cell, the corner mark of notes and comments).
// Translated from gridcraft crates/ui-egui/src/floating_pictures.rs, chartview.rs, text_box.rs and
// grid/quadrant.rs (`paint_sparklines`, `paint_objects`, the selection handles) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Geometry: an object's anchor (core/grid/lib/objects.mjs) puts its top-left corner `dx, dy` pixels
// from its cell and gives its size; here that is scaled by the zoom and placed with the grid's Geo.

import type {Geo, Rect, Range} from './geo';
import {sheetObjects, anchorCell} from '../../../../core/grid/lib/objects.mjs';
import {resolveChart} from '../../../../core/grid/lib/chart-resolve.mjs';
import {render, renderSparkline} from '../../../../core/grid/lib/chart-render.mjs';
import {iconPath} from '../../../../core/grid/lib/icon-library.mjs';
import {resolveColor} from '../../../../core/grid/model/style.mjs';
import {parseRef} from '../../../../core/grid/lib/chart-resolve.mjs';
import {parseCell, parseRange} from '../../../../core/grid/lib/addr.mjs';
import {GArray} from '../../../../core/grid/lib/value.mjs';
import {layoutSheet, printRanges} from '../../../../core/grid/lib/page-layout.mjs';
import {slicerItems, slicerLayout, slicerLook} from '../../../../core/grid/lib/slicer.mjs';
import {timelinePeriods, timelineLayout, selectionLabel, periodOn, TIME_LEVEL_LABEL} from '../../../../core/grid/lib/timeline.mjs';
import {inkPoints, inkWidth, inkAlpha, nearInk} from '../../../../core/grid/lib/ink.mjs';
import {sparkOptions, sparkGroupMembers} from '../../../../core/grid/lib/sparkline-fx.mjs';
import {colLeft, rowTop} from '../../../../core/grid/model/sheet.mjs';
import {artEffects} from '../../../../core/grid/lib/wordart.mjs';
import {paintWithFx, paintPicture, paintWordArtLines} from './objectFx';
import {rangeCanvas, type RangeCanvas} from '../lib/rangeImage';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export interface ObjectHit { kind: string; id: number; object: any; rect: Rect; handle: Handle | null }
export interface LiveRect { kind: string; id: number; rect: Rect }
/** The rectangle(s) dragged objects are shown at: one, or all the picked objects moving together. */
export type Live = LiveRect | LiveRect[] | null;
const liveFor = (live: Live, kind: string, id: number): LiveRect | undefined => (Array.isArray(live) ? live.find(l => l.kind === kind && l.id === id) : live && live.kind === kind && live.id === id ? live : undefined);

const HANDLE = 4;
const rgba = (c: number[]) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;
const css = (c: any, fallback: string | null) => { const rgb = resolveColor(c, themeOf.current); return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : fallback; };
const themeOf: {current: any} = {current: undefined};
/** Strokes not shown now (Ink Replay shows them one by one): set before a frame is painted. */
let hiddenInk: Set<number> | null = null;
export const setHiddenInk = (ids: Set<number> | null) => { hiddenInk = ids; };

/** Sheet pixels (from A1's corner) to the screen, through the cell the point is in so frozen panes map right (interact.rs `handle_draw_tool`). */
export function sheetToScreen(geo: Geo, sheet: any, x: number, y: number): {x: number; y: number} {
  const col = geo.ci.at(Math.max(0, x)), row = geo.ri.at(Math.max(0, y));
  return {x: geo.x(col) + (x - colLeft(sheet, col)) * geo.z, y: geo.y(row) + (y - rowTop(sheet, row)) * geo.z};
}
/** A screen point to sheet pixels. */
export function screenToSheet(geo: Geo, sheet: any, px: number, py: number): [number, number] {
  const c = geo.cellAt(px, py);
  return [colLeft(sheet, c.col) + (px - geo.x(c.col)) / geo.z, rowTop(sheet, c.row) + (py - geo.y(c.row)) / geo.z];
}

export interface InkOverlay {
  /** The stroke being drawn (sheet pixels), the lasso loop being drawn, the ids the lasso holds, and how far they are being dragged (screen pixels). */
  live: {pts: [number, number][]; color: string; width: number; kind: 'pen' | 'eraser' | 'lasso'} | null;
  lassoIds: number[];
  lassoDrag: {dx: number; dy: number} | null;
}

/** An object's rectangle on screen. */
export function screenRect(geo: Geo, anchor: any): Rect {
  const c = anchorCell(anchor);
  return {x: geo.x(c.col) + (anchor.dx ?? 0) * geo.z, y: geo.y(c.row) + (anchor.dy ?? 0) * geo.z, w: Math.max(0, anchor.width ?? 0) * geo.z, h: Math.max(0, anchor.height ?? 0) * geo.z};
}

/** The objects of a sheet with their screen rectangles, back to front. */
export function objectsOf(geo: Geo, sheet: any, live: Live = null) {
  const out: {kind: string; object: any; rect: Rect}[] = [];
  for (const {kind, object} of sheetObjects(sheet) as Iterable<{kind: string; object: any}>) {
    if (hiddenInk && kind === 'shape' && object.kind === 'ink' && hiddenInk.has(object.id)) continue;
    if (object.hidden === true) continue;
    const rect = liveFor(live, kind, object.id)?.rect ?? screenRect(geo, object.anchor);
    out.push({kind, object, rect});
  }
  return out;
}

const near = (v: number, t: number) => Math.abs(v - t) <= HANDLE + 1;
/** The handle of `rect` at a point, or null. */
export function handleAt(rect: Rect, x: number, y: number): Handle | null {
  const xs: [number, string][] = [[rect.x, 'w'], [rect.x + rect.w / 2, ''], [rect.x + rect.w, 'e']];
  const ys: [number, string][] = [[rect.y, 'n'], [rect.y + rect.h / 2, ''], [rect.y + rect.h, 's']];
  for (const [hy, vn] of ys) for (const [hx, hn] of xs) {
    const name = `${vn}${hn}`;
    if (!name) continue;
    if (near(x, hx) && near(y, hy)) return name as Handle;
  }
  return null;
}

/** The topmost object at a point; a selected object's handles win over what is under them. */
export function hitObject(geo: Geo, sheet: any, x: number, y: number, selected: {kind: string; id: number} | null, live: Live = null): ObjectHit | null {
  if (x < geo.cells.x || y < geo.cells.y || x >= geo.cells.x + geo.cells.w || y >= geo.cells.y + geo.cells.h) return null;
  const list = objectsOf(geo, sheet, live);
  if (selected) {
    const s = list.find(o => o.kind === selected.kind && o.object.id === selected.id);
    if (s) { const h = handleAt(s.rect, x, y); if (h) return {kind: s.kind, id: s.object.id, object: s.object, rect: s.rect, handle: h}; }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    // A stroke of ink is taken only where its line is, not anywhere in its box.
    if (o.object.kind === 'ink') {
      const pts = (inkPoints(o.object) as [number, number][]).map(([px, py]) => [o.rect.x + px * geo.z, o.rect.y + py * geo.z] as [number, number]);
      if (nearInk(pts, inkWidth(o.object) * geo.z, x, y, 4)) return {kind: o.kind, id: o.object.id, object: o.object, rect: o.rect, handle: null};
      continue;
    }
    const slack = o.object.kind === 'line' || o.object.kind === 'arrow' ? 4 : 0;
    const r = o.rect;
    if (x >= r.x - slack && x <= r.x + r.w + slack && y >= r.y - slack && y <= r.y + Math.max(r.h, 0) + slack) return {kind: o.kind, id: o.object.id, object: o.object, rect: r, handle: null};
  }
  return null;
}

/** The cursor over an object: a move cross, or the resize arrow of a handle. */
export function cursorOf(hit: ObjectHit): string {
  if (!hit.handle) return 'move';
  return ({nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize'} as Record<Handle, string>)[hit.handle];
}

/** The rectangle after dragging `handle` (or moving, with null) by (dx, dy) screen pixels. */
export function dragRect(orig: Rect, handle: Handle | null, dx: number, dy: number, keepAspect = false): Rect {
  if (!handle) return {x: orig.x + dx, y: orig.y + dy, w: orig.w, h: orig.h};
  let {x, y, w, h} = orig;
  if (handle.includes('w')) { x += dx; w -= dx; }
  if (handle.includes('e')) w += dx;
  if (handle.includes('n')) { y += dy; h -= dy; }
  if (handle.includes('s')) h += dy;
  if (keepAspect && orig.w > 0 && orig.h > 0 && handle.length === 2) {
    const ratio = orig.w / orig.h;
    if (Math.abs(w - orig.w) >= Math.abs(h - orig.h) * ratio) h = w / ratio; else w = h * ratio;
    if (handle.includes('w')) x = orig.x + orig.w - w;
    if (handle.includes('n')) y = orig.y + orig.h - h;
  }
  if (w < 4) { if (handle.includes('w')) x -= 4 - w; w = 4; }
  if (h < 0) { if (handle.includes('n')) y += h; h = -h; }
  return {x, y, w, h};
}

// ---------------------------------------------------------------------------------------------
// Painting

const images = new Map<string, HTMLImageElement>();
function imageFor(key: string, mime: string, data: string, ready: () => void): HTMLImageElement | null {
  let img = images.get(key);
  if (!img) {
    if (images.size > 200) images.clear();
    img = new Image();
    img.onload = () => ready();
    img.src = `data:${mime};base64,${data}`;
    images.set(key, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

const chartCache = new WeakMap<object, {content: unknown; w: number; h: number; prims: any[]}>();
function measureWith(ctx: CanvasRenderingContext2D) {
  return {textWidth: (t: string, size: number, bold: boolean) => { ctx.font = `${bold ? '700 ' : '400 '}${size}px "Segoe UI", Carlito, Arial, sans-serif`; return ctx.measureText(t).width; }};
}

/** Draws chart primitives with their origin at (ox, oy) and one unit as `s` pixels. */
export function paintPrims(ctx: CanvasRenderingContext2D, prims: any[], ox: number, oy: number, s: number) {
  for (const p of prims) {
    switch (p.t) {
      case 'rect': {
        const x = ox + p.x * s, y = oy + p.y * s, w = p.w * s, h = p.h * s;
        ctx.beginPath();
        if (p.radius > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, p.radius * s); else ctx.rect(x, y, w, h);
        if (p.fill) { ctx.fillStyle = rgba(p.fill); ctx.fill(); }
        if (p.stroke) { ctx.strokeStyle = rgba(p.stroke[0]); ctx.lineWidth = p.stroke[1] * s; ctx.stroke(); }
        break;
      }
      case 'line':
        ctx.beginPath();
        p.pts.forEach((q: number[], i: number) => (i ? ctx.lineTo(ox + q[0] * s, oy + q[1] * s) : ctx.moveTo(ox + q[0] * s, oy + q[1] * s)));
        ctx.strokeStyle = rgba(p.color); ctx.lineWidth = p.width * s; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.setLineDash(p.dash ? [4 * s, 3 * s] : []);
        ctx.stroke(); ctx.setLineDash([]);
        break;
      case 'poly':
        ctx.beginPath();
        p.pts.forEach((q: number[], i: number) => (i ? ctx.lineTo(ox + q[0] * s, oy + q[1] * s) : ctx.moveTo(ox + q[0] * s, oy + q[1] * s)));
        ctx.closePath(); ctx.fillStyle = rgba(p.fill); ctx.fill();
        if (p.stroke) { ctx.strokeStyle = rgba(p.stroke[0]); ctx.lineWidth = p.stroke[1] * s; ctx.stroke(); }
        break;
      case 'wedge': {
        // Angles run clockwise from 12 o'clock.
        const a0 = p.a0 - Math.PI / 2, a1 = p.a1 - Math.PI / 2, cx = ox + p.cx * s, cy = oy + p.cy * s;
        ctx.beginPath();
        ctx.arc(cx, cy, p.ro * s, a0, a1);
        if (p.ri > 0) ctx.arc(cx, cy, p.ri * s, a1, a0, true); else ctx.lineTo(cx, cy);
        ctx.closePath(); ctx.fillStyle = rgba(p.fill); ctx.fill();
        if (p.stroke) { ctx.strokeStyle = rgba(p.stroke[0]); ctx.lineWidth = p.stroke[1] * s; ctx.stroke(); }
        break;
      }
      case 'circle':
        ctx.beginPath(); ctx.arc(ox + p.cx * s, oy + p.cy * s, p.r * s, 0, Math.PI * 2);
        if (p.fill) { ctx.fillStyle = rgba(p.fill); ctx.fill(); }
        if (p.stroke) { ctx.strokeStyle = rgba(p.stroke[0]); ctx.lineWidth = p.stroke[1] * s; ctx.stroke(); }
        break;
      case 'text': {
        ctx.save();
        ctx.translate(ox + p.x * s, oy + p.y * s);
        if (p.rotation) ctx.rotate(p.rotation);
        ctx.font = `${p.bold ? '700 ' : '400 '}${p.size * s}px "Segoe UI", Carlito, Arial, sans-serif`;
        ctx.fillStyle = rgba(p.color);
        if (p.shadow) { ctx.shadowColor = rgba(p.shadow.color); ctx.shadowBlur = p.shadow.blur * s; ctx.shadowOffsetX = p.shadow.dx * s; ctx.shadowOffsetY = p.shadow.dy * s; }
        ctx.textAlign = p.align === 'center' ? 'center' : p.align === 'right' ? 'right' : 'left';
        ctx.textBaseline = p.valign === 'middle' ? 'middle' : p.valign === 'bottom' ? 'bottom' : 'top';
        if (p.hollow) ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillText(p.text, 0, 0);
        if (p.outline) { ctx.shadowColor = 'transparent'; ctx.strokeStyle = rgba(p.outline.color); ctx.lineWidth = Math.max(0.25, p.outline.width * s); ctx.lineJoin = 'round'; ctx.strokeText(p.text, 0, 0); }
        ctx.restore();
        break;
      }
      default: break;
    }
  }
}

/** A Linked Picture (Paste > Linked Picture): its range drawn live, redrawn whenever the workbook changes. */
const linkedCache = new WeakMap<object, {content: unknown; r: RangeCanvas | null}>();
function paintLinked(ctx: CanvasRenderingContext2D, content: any, object: any, rect: Rect, ready: () => void) {
  let c = linkedCache.get(object);
  if (!c || c.content !== content) {
    const si = content.sheets.findIndex((s: any) => s.id === object.link.sheet);
    const range = parseRange(String(object.link.range));
    const r = si >= 0 && range ? rangeCanvas(content, si, range, 2) : null;
    c = {content, r};
    // Pictures inside the range load as they are first drawn: draw again once they are in.
    if (r?.pending) setTimeout(() => { linkedCache.delete(object); ready(); }, 80);
    if (r) linkedCache.set(object, c);
  }
  if (c.r) ctx.drawImage(c.r.canvas, rect.x, rect.y, rect.w, rect.h);
  else { ctx.fillStyle = '#e9e9ee'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
}

function paintChart(ctx: CanvasRenderingContext2D, content: any, si: number, engine: any, chart: any, rect: Rect, z: number) {
  const w = rect.w / z, h = rect.h / z;
  let cached = chartCache.get(chart);
  if (!cached || cached.content !== content || cached.w !== w || cached.h !== h) {
    let prims: any[] = [];
    try { prims = render(chart, resolveChart(content, si, chart, engine), w, h, measureWith(ctx)); } catch { prims = []; }
    cached = {content, w, h, prims};
    chartCache.set(chart, cached);
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
  paintPrims(ctx, cached.prims, rect.x, rect.y, z);
  ctx.restore();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (line && ctx.measureText(line + word).width > maxW) { out.push(line.trimEnd()); line = word.trimStart(); } else line += word;
    }
    out.push(line);
  }
  return out;
}

const rgbOf = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const fontOf = (f: any, size: number, fallback: string) => `${f.italic ? 'italic ' : ''}${f.bold ? '700 ' : '400 '}${size}px ${f.font ? `"${String(f.font).replace(/"/g, '')}", ` : ''}${fallback}`;

/** WordArt: the text drawn in the style's fill (solid or gradient), outline, shadow and glow (core/grid/lib/wordart.mjs). */
function paintWordArt(ctx: CanvasRenderingContext2D, shape: any, rect: Rect, z: number) {
  const {x, y, w, h} = rect;
  const fx: any = artEffects(shape.wordArt, themeOf.current?.colors) ?? {};
  const f = shape.format ?? {};
  const size = (f.fontSize ?? 36) * 96 / 72 * z;
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.font = fontOf({...f, bold: f.bold !== false}, size, '"Segoe UI", Calibri, Carlito, Arial, sans-serif');
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
  const lines = wrapLines(ctx, String(shape.text ?? ''), Math.max(10, w - 10 * z));
  const lh = size * 1.15, top = y + (h - lines.length * lh) / 2;
  let fill: string | CanvasGradient | null = null;
  if (fx.fill?.type === 'gradient') {
    const g = ctx.createLinearGradient(0, top, 0, top + lines.length * lh);
    for (const st of fx.fill.stops) g.addColorStop(st.pos / 100, rgbOf(st.color));
    fill = g;
  } else if (fx.fill?.type === 'solid') fill = rgbOf(fx.fill.color);
  lines.forEach((l, i) => {
    const cy = top + (i + 0.5) * lh;
    ctx.save();
    if (fx.glow) { ctx.shadowColor = rgbOf(fx.glow.color, 0.8); ctx.shadowBlur = fx.glow.size * z; }
    else if (fx.shadow) { ctx.shadowColor = rgbOf(fx.shadow.color ?? [0, 0, 0], fx.shadow.alpha); ctx.shadowBlur = fx.shadow.blur * z; ctx.shadowOffsetX = fx.shadow.dist * z * 0.7; ctx.shadowOffsetY = fx.shadow.dist * z * 0.7; }
    if (fill) { ctx.fillStyle = fill; ctx.fillText(l, x + w / 2, cy); } else if (fx.outline) { ctx.strokeStyle = rgbOf(fx.outline.color); ctx.lineWidth = Math.max(1, fx.outline.width * z); ctx.strokeText(l, x + w / 2, cy); }
    ctx.restore();
    if (fx.outline && fill) { ctx.strokeStyle = rgbOf(fx.outline.color); ctx.lineWidth = Math.max(1, fx.outline.width * z); ctx.strokeText(l, x + w / 2, cy); }
  });
}

/** A signature line: the X, the line to sign on, and under it the signer and the title. */
function paintSignature(ctx: CanvasRenderingContext2D, shape: any, rect: Rect, z: number) {
  const {x, y, w, h} = rect;
  const sig = shape.signature ?? {};
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const base = y + Math.min(h * 0.58, h - 26 * z);
  ctx.fillStyle = '#44464d'; ctx.strokeStyle = '#44464d'; ctx.lineWidth = Math.max(1, z);
  ctx.font = `400 ${24 * z}px "Segoe UI", Calibri, Arial, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('X', x + 4 * z, base - 3 * z);
  ctx.beginPath(); ctx.moveTo(x + 2 * z, base); ctx.lineTo(x + w - 2 * z, base); ctx.stroke();
  ctx.font = `400 ${11 * z}px "Segoe UI", Calibri, Arial, sans-serif`; ctx.textBaseline = 'top';
  [sig.signer, sig.title].filter(Boolean).forEach((t: string, i: number) => ctx.fillText(t, x + 4 * z, base + (4 + i * 14) * z, Math.max(0, w - 8 * z)));
}

/** An equation: the linear text in the maths font, a dotted frame and "Type equation here." while empty. */
function paintEquation(ctx: CanvasRenderingContext2D, shape: any, rect: Rect, z: number) {
  const {x, y, w, h} = rect;
  const f = shape.format ?? {};
  const size = (f.fontSize ?? 16) * 96 / 72 * z;
  const text = String(shape.text ?? '');
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  if (!text) { ctx.setLineDash([2 * z, 2 * z]); ctx.strokeStyle = '#8a8a92'; ctx.lineWidth = Math.max(1, z); ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); ctx.setLineDash([]); }
  ctx.font = `italic 400 ${size}px "Cambria Math", Cambria, "Times New Roman", serif`;
  ctx.fillStyle = text ? css(f.textColor, '#000000') ?? '#000000' : '#8a8a92'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, text || 'Type equation here.', Math.max(10, w - 10 * z));
  const lh = size * 1.25, top = y + (h - lines.length * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x + w / 2, top + (i + 0.5) * lh));
}

function paintShape(ctx: CanvasRenderingContext2D, shape: any, rect: Rect, z: number) {
  const {x, y, w, h} = rect;
  const fill = shape.fill === 'auto' ? null : css(shape.fill, null);
  const line = shape.line === 'auto' ? null : css(shape.line, null);
  const noLine = shape.format?.noLine === true;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, 1.25 * z);
  ctx.strokeStyle = line ?? '#444444';
  if (shape.kind === 'icon') {
    const d = iconPath(shape.text);
    if (d) {
      ctx.translate(x, y); ctx.scale(w / 24, h / 24);
      ctx.strokeStyle = fill ?? '#000000'; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(new Path2D(d));
    }
    ctx.restore();
    return;
  }
  if (shape.kind === 'ink') {
    const pts = inkPoints(shape) as [number, number][];
    if (pts.length >= 2) {
      ctx.globalAlpha = inkAlpha(shape);
      ctx.strokeStyle = line ?? '#000000'; ctx.lineWidth = Math.max(0.5, inkWidth(shape) * z); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * z, y + py * z) : ctx.moveTo(x + px * z, y + py * z)));
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  if (shape.kind === 'wordArt' || shape.kind === 'signature' || shape.kind === 'equation') {
    if (shape.kind === 'wordArt') paintWordArt(ctx, shape, rect, z); else if (shape.kind === 'signature') paintSignature(ctx, shape, rect, z); else paintEquation(ctx, shape, rect, z);
    ctx.restore();
    return;
  }
  ctx.beginPath();
  switch (shape.kind) {
    case 'ellipse': ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'triangle': ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); break;
    case 'roundedRectangle': if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.16); else ctx.rect(x, y, w, h); break;
    case 'line': case 'arrow': ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); break;
    default: ctx.rect(x, y, w, h);
  }
  if (shape.kind !== 'line' && shape.kind !== 'arrow' && fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (!noLine) ctx.stroke();
  if (shape.kind === 'arrow') {
    const a = Math.atan2(h, w), len = 9 * z;
    ctx.beginPath();
    ctx.moveTo(x + w, y + h);
    ctx.lineTo(x + w - len * Math.cos(a - 0.45), y + h - len * Math.sin(a - 0.45));
    ctx.moveTo(x + w, y + h);
    ctx.lineTo(x + w - len * Math.cos(a + 0.45), y + h - len * Math.sin(a + 0.45));
    ctx.stroke();
  }
  if (shape.text && shape.kind !== 'line' && shape.kind !== 'arrow') {
    const f = shape.format ?? {};
    const size = (f.fontSize ?? 11) * 96 / 72 * z;
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.font = `${f.italic ? 'italic ' : ''}${f.bold ? '700 ' : '400 '}${size}px ${f.font ? `"${String(f.font).replace(/"/g, '')}", ` : ''}Calibri, Carlito, "Segoe UI", Arial, sans-serif`;
    // Text with no colour of its own takes the contrasting one for the shape's fill (white on a dark fill), as Excel's styles do.
    const bg = shape.fill === 'auto' ? null : resolveColor(shape.fill, themeOf.current);
    const auto = bg && 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2] < 150 ? '#ffffff' : '#000000';
    ctx.fillStyle = css(f.textColor, auto) ?? auto;
    ctx.textBaseline = 'top';
    const pad = 5 * z;
    const lines = wrapLines(ctx, String(shape.text), Math.max(10, w - 2 * pad));
    const lh = size * 1.2, total = lines.length * lh;
    const top = f.anchor === 'middle' || (shape.kind !== 'textBox' && !f.anchor) ? y + (h - total) / 2 : f.anchor === 'bottom' ? y + h - total - pad : y + pad;
    const align = f.align ?? (shape.kind === 'textBox' ? 'left' : 'center');
    ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
    const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w - pad : x + pad;
    if (shape.textFx) paintWordArtLines(ctx, shape.textFx, lines, tx, top, lh, size, z, ctx.fillStyle as string, align);
    else lines.forEach((l, i) => ctx.fillText(l, tx, top + i * lh));
  }
  ctx.restore();
}

const slicerCache = new WeakMap<object, {content: unknown; items: {value: string; on: boolean}[]}>();
/** The tiles of a slicer, read from its table when the document has changed. */
export function itemsOfSlicer(content: any, si: number, sl: any): {value: string; on: boolean}[] {
  const hit = slicerCache.get(sl);
  if (hit && hit.content === content) return hit.items;
  const items = slicerItems(content, si, sl) as {value: string; on: boolean}[];
  slicerCache.set(sl, {content, items});
  return items;
}

const periodCache = new WeakMap<object, {content: unknown; periods: any[]}>();
/** The periods of a timeline, read from its PivotTable when the document has changed. */
export function periodsOfTimeline(content: any, tl: any): any[] {
  const hit = periodCache.get(tl);
  if (hit && hit.content === content) return hit.periods;
  const periods = timelinePeriods(content, tl) as any[];
  periodCache.set(tl, {content, periods});
  return periods;
}

/** A timeline: its caption with a clear-filter button, the selection and the time level, then a bar of periods (the picked ones filled) between two scroll arrows. */
function paintTimeline(ctx: CanvasRenderingContext2D, content: any, tl: any, rect: Rect, z: number) {
  const periods = periodsOfTimeline(content, tl);
  const lay = timelineLayout(rect, tl, periods, z) as any;
  const lk = slicerLook(tl.style);
  const font = (w: number | string, s: number) => `${w} ${s * z}px "Segoe UI", Carlito, Arial, sans-serif`;
  const round = (x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  round(rect.x, rect.y, rect.w, rect.h, 3 * z);
  ctx.fillStyle = lk.body; ctx.fill(); ctx.strokeStyle = lk.frame; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = lk.header; ctx.fillRect(lay.header.x + 0.5, lay.header.y + 0.5, lay.header.w - 1, lay.header.h);
  ctx.font = font(700, 12); ctx.fillStyle = lk.headerText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(String(tl.caption ?? tl.field), rect.x + 8 * z, rect.y + lay.header.h / 2, Math.max(0, rect.w - 40 * z));
  const c = lay.clear, filtered = tl.from !== null && tl.from !== undefined;
  ctx.save(); ctx.globalAlpha = filtered ? 1 : 0.35; ctx.strokeStyle = lk.headerText; ctx.lineWidth = 1.4 * z; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(c.x + c.w * 0.18, c.y + c.h * 0.22); ctx.lineTo(c.x + c.w * 0.62, c.y + c.h * 0.22); ctx.lineTo(c.x + c.w * 0.45, c.y + c.h * 0.5); ctx.lineTo(c.x + c.w * 0.45, c.y + c.h * 0.78);
  ctx.moveTo(c.x + c.w * 0.62, c.y + c.h * 0.58); ctx.lineTo(c.x + c.w * 0.88, c.y + c.h * 0.84); ctx.moveTo(c.x + c.w * 0.88, c.y + c.h * 0.58); ctx.lineTo(c.x + c.w * 0.62, c.y + c.h * 0.84);
  ctx.stroke(); ctx.restore();
  ctx.font = font(400, 11); ctx.fillStyle = lk.offText === lk.headerText ? '#444' : lk.onText;
  ctx.fillText(selectionLabel(periods, tl) as string, lay.label.x, lay.label.y + lay.label.h / 2, lay.label.w);
  const lv = lay.level;
  round(lv.x, lv.y, lv.w, lv.h, 2 * z); ctx.fillStyle = lk.off; ctx.fill(); ctx.strokeStyle = lk.offLine; ctx.stroke();
  ctx.font = font(600, 10); ctx.fillStyle = lk.offText; ctx.textAlign = 'center';
  ctx.fillText(`${(TIME_LEVEL_LABEL as any)[tl.level ?? 'months']} ▾`, lv.x + lv.w / 2, lv.y + lv.h / 2);
  ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y + lay.header.h, rect.w, Math.max(0, rect.h - lay.header.h)); ctx.clip();
  for (const [r, dir] of [[lay.left, -1], [lay.right, 1]] as const) {
    ctx.fillStyle = lk.off; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeStyle = lk.offLine; ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.fillStyle = lk.offText; ctx.beginPath(); const cx = r.x + r.w / 2, cy = r.y + r.h / 2, a = 3 * z;
    ctx.moveTo(cx - dir * a, cy - a); ctx.lineTo(cx + dir * a, cy); ctx.lineTo(cx - dir * a, cy + a); ctx.closePath(); ctx.fill();
  }
  ctx.textAlign = 'center';
  let lastGroup = '';
  for (const cell of lay.cells as {i: number; rect: Rect}[]) {
    const p = periods[cell.i], r = cell.rect, on = periodOn(tl, p);
    ctx.fillStyle = on ? lk.on : lk.off; ctx.fillRect(r.x, r.y + 14 * z, r.w - 1, r.h - 14 * z);
    ctx.strokeStyle = on ? lk.onLine : lk.offLine; ctx.lineWidth = 1; ctx.strokeRect(r.x + 0.5, r.y + 14 * z + 0.5, r.w - 2, r.h - 14 * z - 1);
    ctx.font = font(400, 10); ctx.fillStyle = on ? lk.onText : lk.offText;
    ctx.fillText(p.label, r.x + r.w / 2, r.y + 14 * z + (r.h - 14 * z) / 2, r.w - 4);
    if (p.group && p.group !== lastGroup) { ctx.textAlign = 'left'; ctx.font = font(600, 9); ctx.fillStyle = lk.offText; ctx.fillText(p.group, r.x + 2 * z, r.y + 7 * z, 70 * z); ctx.textAlign = 'center'; lastGroup = p.group; }
  }
  ctx.restore();
}

/** A slicer: a header with its caption and a clear-filter button, then a tile for each value of the column (blue when shown, grey when filtered out). */
function paintSlicer(ctx: CanvasRenderingContext2D, content: any, si: number, sl: any, rect: Rect, z: number) {
  if (sl.timeline) { paintTimeline(ctx, content, sl, rect, z); return; }
  const items = itemsOfSlicer(content, si, sl);
  const lay = slicerLayout(rect, sl, items, z);
  const lk = slicerLook(sl.style);
  const round = (x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  round(rect.x, rect.y, rect.w, rect.h, 3 * z);
  ctx.fillStyle = lk.body; ctx.fill(); ctx.strokeStyle = lk.frame; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = lk.header; ctx.fillRect(lay.header.x + 0.5, lay.header.y + 0.5, lay.header.w - 1, lay.header.h);
  ctx.font = `700 ${12 * z}px "Segoe UI", Carlito, Arial, sans-serif`;
  ctx.fillStyle = lk.headerText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(String(sl.caption ?? sl.column), rect.x + 8 * z, rect.y + lay.header.h / 2, Math.max(0, rect.w - 40 * z));
  // The clear-filter button: a funnel with a cross, dimmed while nothing is filtered.
  const c = lay.clear, filtered = Array.isArray(sl.selected);
  ctx.save();
  ctx.globalAlpha = filtered ? 1 : 0.35;
  ctx.strokeStyle = lk.headerText; ctx.lineWidth = 1.4 * z; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(c.x + c.w * 0.18, c.y + c.h * 0.22); ctx.lineTo(c.x + c.w * 0.62, c.y + c.h * 0.22); ctx.lineTo(c.x + c.w * 0.45, c.y + c.h * 0.5); ctx.lineTo(c.x + c.w * 0.45, c.y + c.h * 0.78);
  ctx.moveTo(c.x + c.w * 0.18, c.y + c.h * 0.22); ctx.lineTo(c.x + c.w * 0.34, c.y + c.h * 0.5); ctx.lineTo(c.x + c.w * 0.34, c.y + c.h * 0.7);
  ctx.moveTo(c.x + c.w * 0.62, c.y + c.h * 0.58); ctx.lineTo(c.x + c.w * 0.88, c.y + c.h * 0.84); ctx.moveTo(c.x + c.w * 0.88, c.y + c.h * 0.58); ctx.lineTo(c.x + c.w * 0.62, c.y + c.h * 0.84);
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.rect(rect.x, rect.y + lay.header.h, rect.w, Math.max(0, rect.h - lay.header.h)); ctx.clip();
  ctx.font = `${11 * z}px "Segoe UI", Carlito, Arial, sans-serif`;
  for (const tile of lay.tiles as {value: string; on: boolean; rect: Rect}[]) {
    const r = tile.rect;
    if (r.y > rect.y + rect.h) break;
    round(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 2 * z);
    ctx.fillStyle = tile.on ? lk.on : lk.off; ctx.fill();
    ctx.strokeStyle = tile.on ? lk.onLine : lk.offLine; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = tile.on ? lk.onText : lk.offText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(tile.value, r.x + 8 * z, r.y + r.h / 2, Math.max(0, r.w - 14 * z));
  }
  ctx.restore();
}

/** Paints the floating objects of a sheet inside the cell area, then the selection frame. */
export function paintObjects(ctx: CanvasRenderingContext2D, geo: Geo, content: any, si: number, engine: any, selected: {kind: string; id: number} | null, live: Live, ready: () => void, picked: {kind: string; id: number}[] = []) {
  const sheet = content.sheets[si];
  themeOf.current = content.theme;
  const list = objectsOf(geo, sheet, live);
  if (!list.length) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(geo.cells.x, geo.cells.y, geo.cells.w, geo.cells.h); ctx.clip();
  for (const {kind, object, rect} of list) {
    if (rect.x + rect.w < geo.cells.x || rect.y + rect.h < geo.cells.y || rect.x > geo.cells.x + geo.cells.w || rect.y > geo.cells.y + geo.cells.h) continue;
    // Rotated and flipped pictures and shapes: turned about their centre (Page Layout > Rotate).
    const turned = kind !== 'chart' && kind !== 'slicer' && (object.rotation || object.flipH || object.flipV);
    if (turned) {
      ctx.save();
      ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
      if (object.rotation) ctx.rotate((object.rotation * Math.PI) / 180);
      ctx.scale(object.flipH ? -1 : 1, object.flipV ? -1 : 1);
      ctx.translate(-(rect.x + rect.w / 2), -(rect.y + rect.h / 2));
    }
    if (kind === 'chart') paintWithFx(ctx, object.fx, rect, geo.z, undefined, c => paintChart(c, content, si, engine, object, rect, geo.z));
    else if (kind === 'image' && object.link) paintLinked(ctx, content, object, rect, ready);
    else if (kind === 'image') {
      const img = imageFor(`${si}:${object.id}:${object.data.length}`, object.mime, object.data, ready);
      if (img) paintPicture(ctx, img, object, rect, geo.z, css);
      else { ctx.fillStyle = '#e9e9ee'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
    } else if (kind === 'shape') paintWithFx(ctx, ['line', 'arrow', 'icon', 'ink'].includes(object.kind) ? null : object.fx, rect, geo.z, object.kind, c => paintShape(c, object, rect, geo.z));
    else if (kind === 'slicer') paintSlicer(ctx, content, si, object, rect, geo.z);
    if (turned) ctx.restore();
  }
  // Several objects picked together: a frame round each, no handles.
  if (picked.length > 1) {
    ctx.strokeStyle = '#107c41'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    for (const o of list) if (picked.some(q => q.kind === o.kind && q.id === o.object.id)) ctx.strokeRect(Math.round(o.rect.x) + 0.5, Math.round(o.rect.y) + 0.5, Math.round(o.rect.w), Math.round(o.rect.h));
  }
  const sel = selected && picked.length < 2 ? list.find(o => o.kind === selected.kind && o.object.id === selected.id) : null;
  if (sel) {
    const r = sel.rect;
    ctx.strokeStyle = '#107c41'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
    const line = sel.object.kind === 'line' || sel.object.kind === 'arrow';
    const xs = [r.x, r.x + r.w / 2, r.x + r.w], ys = [r.y, r.y + r.h / 2, r.y + r.h];
    ys.forEach((hy, j) => xs.forEach((hx, i) => {
      if (i === 1 && j === 1) return;
      if (line && (i === 1 || j === 1)) return;
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#107c41'; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.rect(Math.round(hx) - HANDLE, Math.round(hy) - HANDLE, HANDLE * 2, HANDLE * 2); ctx.fill(); ctx.stroke();
    }));
  }
  ctx.restore();
}

/** The stroke being drawn, the lasso loop and the dashed box round the strokes the lasso holds (draw tools). */
export function paintInkOverlay(ctx: CanvasRenderingContext2D, geo: Geo, sheet: any, ink: InkOverlay) {
  ctx.save();
  ctx.beginPath(); ctx.rect(geo.cells.x, geo.cells.y, geo.cells.w, geo.cells.h); ctx.clip();
  const live = ink.live;
  if (live && live.pts.length) {
    const pts = live.pts.map(([x, y]) => sheetToScreen(geo, sheet, x, y));
    if (live.kind === 'pen') {
      ctx.globalAlpha = live.width > 8 ? 0.45 : 1;
      ctx.strokeStyle = live.color; ctx.lineWidth = Math.max(0.5, live.width * geo.z); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y); ctx.stroke();
    } else if (live.kind === 'lasso' && pts.length > 1) {
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
      ctx.fillStyle = 'rgba(80,140,255,0.10)'; ctx.fill();
      ctx.setLineDash([5, 4]); ctx.strokeStyle = '#5b9bff'; ctx.lineWidth = 1.25; ctx.stroke();
    } else if (live.kind === 'eraser') {
      const q = pts[pts.length - 1];
      ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill(); ctx.strokeStyle = '#888'; ctx.lineWidth = 1; ctx.stroke();
    }
  }
  ctx.restore();
  if (ink.lassoIds.length) {
    const rects = objectsOf(geo, sheet).filter(o => o.kind === 'shape' && o.object.kind === 'ink' && ink.lassoIds.includes(o.object.id)).map(o => o.rect);
    if (rects.length) {
      const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y)), x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h));
      const dx = ink.lassoDrag?.dx ?? 0, dy = ink.lassoDrag?.dy ?? 0;
      ctx.save();
      ctx.beginPath(); ctx.rect(geo.cells.x, geo.cells.y, geo.cells.w, geo.cells.h); ctx.clip();
      ctx.fillStyle = 'rgba(80,140,255,0.06)'; ctx.strokeStyle = '#5b9bff'; ctx.lineWidth = 1.25; ctx.setLineDash([5, 4]);
      ctx.fillRect(x0 - 3 + dx, y0 - 3 + dy, x1 - x0 + 6, y1 - y0 + 6); ctx.strokeRect(x0 - 3 + dx, y0 - 3 + dy, x1 - x0 + 6, y1 - y0 + 6);
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cell art: sparklines, pictures in cells and the mark of notes and comments

const rangeValues = (engine: any, content: any, si: number, source: string): (number | null)[] => {
  const ref = parseRef(content, si, source);
  if (!ref) return [];
  const out: (number | null)[] = [];
  const r = ref.range;
  for (let row = r.start.row; row <= Math.min(r.end.row, r.start.row + 5000); row++) for (let col = r.start.col; col <= Math.min(r.end.col, r.start.col + 5000); col++) {
    let v = engine.sheetValue(ref.sheet, row, col);
    if (v instanceof GArray) v = v.data[0] ?? null;
    out.push(typeof v === 'number' && Number.isFinite(v) ? v : null);
  }
  return out;
};

/** Paints one pane's cell art, after the cells and before the selection. */
export function paintCellArt(ctx: CanvasRenderingContext2D, geo: Geo, content: any, si: number, engine: any, rows: [number, number], cols: [number, number], ready: () => void) {
  const sheet = content.sheets[si];
  themeOf.current = content.theme;
  const inPane = (row: number, col: number) => row >= rows[0] && row <= rows[1] && col >= cols[0] && col <= cols[1];
  const cellRect = (row: number, col: number): Rect => ({x: geo.x(col), y: geo.y(row), w: geo.colWidth(col) * geo.z, h: geo.rowHeight(row) * geo.z});
  for (const sp of sheet.sparklines ?? []) {
    const at = parseCell(sp.cell);
    if (!at || !inPane(at.row, at.col)) continue;
    const r = cellRect(at.row, at.col);
    if (r.w < 3 || r.h < 3) continue;
    const rgb = resolveColor(sp.color, content.theme) ?? [21, 96, 130];
    const values = rangeValues(engine, content, si, sp.source);
    // Axis options Same for All Sparklines: the scale of the whole group.
    let same: [number, number] | null = null;
    if (sp.group && (sp.axis?.min === 'same' || sp.axis?.max === 'same')) {
      const all = sparkGroupMembers(sheet.sparklines ?? [], sp).flatMap((m: any) => rangeValues(engine, content, si, m.source)).filter((v: number | null) => v !== null) as number[];
      if (all.length) same = [Math.min(...all), Math.max(...all)];
    }
    const opts = sparkOptions(sp, (c: any) => { const v = resolveColor(c, content.theme); return v ? [v[0], v[1], v[2], 255] : null; }, same);
    const prims = renderSparkline(sp.kind, values, [rgb[0], rgb[1], rgb[2], 255], !!sp.markers, r.w, r.h, opts);
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    paintPrims(ctx, prims, r.x, r.y, 1);
    ctx.restore();
  }
  for (const [key, pic] of Object.entries<any>(sheet.cellPictures ?? {})) {
    const at = parseCell(key);
    if (!at || !inPane(at.row, at.col)) continue;
    const r = cellRect(at.row, at.col);
    const img = imageFor(`${si}:cell:${key}:${pic.data.length}`, pic.mime, pic.data, ready);
    if (!img) continue;
    const k = Math.min((r.w - 2) / img.naturalWidth, (r.h - 2) / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.drawImage(img, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
    ctx.restore();
  }
  for (const [map, color] of [['notes', '#d13b2f'], ['comments', '#7b4fc0']] as const) {
    for (const [key, note] of Object.entries<any>(sheet[map] ?? {})) {
      const at = parseCell(key);
      if (!at || !inPane(at.row, at.col)) continue;
      const r = cellRect(at.row, at.col);
      if (r.w < 6 || r.h < 6) continue;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(r.x + r.w - 6, r.y); ctx.lineTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + 6); ctx.closePath(); ctx.fill();
      void note;
    }
  }
}

/**
 * Notes and comments as boxes beside their cell (gridcraft grid/show.rs `paint_overlays`): shown while the pointer is over
 * the cell, always when marked visible, and for every note with Review > Show All Notes. A note is a pale yellow box, a
 * comment a white one with its replies below, the author in bold.
 */
export function paintNoteBoxes(ctx: CanvasRenderingContext2D, geo: Geo, sheet: any, hover: {row: number; col: number} | null, allNotes: boolean) {
  const boxes: {key: string; item: any; threaded: boolean}[] = [];
  for (const [map, threaded] of [['notes', false], ['comments', true]] as const) {
    for (const [key, item] of Object.entries<any>(sheet?.[map] ?? {})) {
      const c = parseCell(key);
      if (!c) continue;
      if (item.visible || (allNotes && !threaded) || (hover && hover.row === c.row && hover.col === c.col)) boxes.push({key, item, threaded});
    }
  }
  if (!boxes.length) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(geo.cells.x, geo.cells.y, geo.cells.w, geo.cells.h); ctx.clip();
  ctx.textBaseline = 'top';
  const wrap = (text: string, width: number) => {
    const lines: string[] = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
      }
      lines.push(line);
    }
    return lines;
  };
  for (const {key, item, threaded} of boxes) {
    const c = parseCell(key)!;
    const r = geo.cellRect(c);
    if (r.x + r.w < geo.cells.x || r.x > geo.cells.x + geo.cells.w || r.y + r.h < geo.cells.y || r.y > geo.cells.y + geo.cells.h) continue;
    const pad = 8, width = 240, fs = 12, lh = 16;
    ctx.font = `${fs}px system-ui, sans-serif`;
    const parts: {text: string; bold: boolean}[] = [{text: `${item.author ?? ''}:`, bold: true}, {text: String(item.text ?? ''), bold: false}];
    for (const rep of item.replies ?? []) parts.push({text: Array.isArray(rep) ? `${rep[0]}: ${rep[1]}` : `${rep.author}: ${rep.text}`, bold: false});
    const lines: {t: string; bold: boolean; gap: boolean}[] = [];
    parts.forEach((p, i) => { ctx.font = `${p.bold ? 'bold ' : ''}${fs}px system-ui, sans-serif`; wrap(p.text, width - pad * 2).forEach((t, j) => lines.push({t, bold: p.bold, gap: i > 1 && j === 0})); });
    const h = lines.reduce((n, l) => n + lh + (l.gap ? 6 : 0), 0) + pad * 2;
    const x = r.x + r.w + 10, y = r.y;
    ctx.strokeStyle = '#5a5a5a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(r.x + r.w, r.y); ctx.lineTo(x, y + 6); ctx.stroke();
    ctx.fillStyle = threaded ? '#ffffff' : '#ffffe1'; ctx.strokeStyle = '#8a8a8a';
    ctx.fillRect(x, y, width, h); ctx.strokeRect(x + 0.5, y + 0.5, width - 1, h - 1);
    ctx.fillStyle = '#000';
    let ty = y + pad;
    for (const l of lines) { if (l.gap) { ctx.strokeStyle = '#d0d0d0'; ctx.beginPath(); ctx.moveTo(x + pad, ty + 2); ctx.lineTo(x + width - pad, ty + 2); ctx.stroke(); ty += 6; } ctx.font = `${l.bold ? 'bold ' : ''}${fs}px system-ui, sans-serif`; ctx.fillText(l.t, x + pad, ty); ty += lh; }
  }
  ctx.restore();
}

const pagesCache = new WeakMap<object, {pages: {n: number; range: Range}[]; areas: any[]}>();
const BLUE = '#2E6FD8';

/**
 * Page Break Preview (gridcraft grid/show.rs `paint_pages`): everything but the printed pages is greyed, each page carries its number
 * behind the cells, the breaks between pages are blue (solid for a manual break, dashed for an automatic one, as in Excel) and stop at the
 * printed area, which has a heavy blue outline.
 */
export function paintPageBreakPreview(ctx: CanvasRenderingContext2D, geo: Geo, sheet: any) {
  let layout = pagesCache.get(sheet);
  if (!layout) { layout = layoutSheet(sheet) as any; pagesCache.set(sheet, layout!); }
  const {pages, areas} = layout!;
  if (!pages.length) return;
  const c = geo.cells;
  const pr0 = pages.reduce((p, q) => ({start: {row: Math.min(p.start.row, q.range.start.row), col: Math.min(p.start.col, q.range.start.col)}, end: {row: Math.max(p.end.row, q.range.end.row), col: Math.max(p.end.col, q.range.end.col)}}), pages[0].range);
  const pr = geo.rangeRect(pr0);
  ctx.save();
  ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.27)';
  for (const r of [
    {x: c.x, y: c.y, w: c.w, h: pr.y - c.y}, {x: c.x, y: pr.y + pr.h, w: c.w, h: c.y + c.h - (pr.y + pr.h)},
    {x: c.x, y: pr.y, w: pr.x - c.x, h: pr.h}, {x: pr.x + pr.w, y: pr.y, w: c.x + c.w - (pr.x + pr.w), h: pr.h},
  ]) if (r.w > 0 && r.h > 0) ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = BLUE; ctx.lineWidth = 2;
  // The breaks between the pages of each printed area: a manual break (one the sheet holds) is solid, the others dashed.
  for (const lay of areas) {
    const x0 = geo.x(lay.area.start.col), x1 = geo.x(lay.area.end.col + 1), y0 = geo.y(lay.area.start.row), y1 = geo.y(lay.area.end.row + 1);
    const manualRows: number[] = lay.manualBreaks ? lay.setup.rowBreaks ?? [] : [], manualCols: number[] = lay.manualBreaks ? lay.setup.colBreaks ?? [] : [];
    for (const [r] of lay.rowBands.slice(1) as [number, number][]) {
      const y = Math.round(geo.y(r)) - 0.5;
      if (y < c.y - 2 || y > c.y + c.h + 2) continue;
      ctx.setLineDash(manualRows.includes(r) ? [] : [6, 3]);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
    for (const [col] of lay.colBands.slice(1) as [number, number][]) {
      const x = Math.round(geo.x(col)) - 0.5;
      if (x < c.x - 2 || x > c.x + c.w + 2) continue;
      ctx.setLineDash(manualCols.includes(col) ? [] : [6, 3]);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const p of pages) {
    const rr = geo.rangeRect(p.range);
    if (rr.x > c.x + c.w || rr.y > c.y + c.h || rr.x + rr.w < c.x || rr.y + rr.h < c.y) continue;
    const size = Math.min(72, Math.max(14, Math.min(rr.w, rr.h) / 6));
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.fillText(`Page ${p.n}`, rr.x + rr.w / 2, rr.y + rr.h / 2);
  }
  ctx.lineWidth = 3;
  ctx.strokeRect(pr.x - 1.5, pr.y - 1.5, pr.w + 3, pr.h + 3);
  ctx.restore();
}

/**
 * Manual page breaks in Normal view: dashed lines (a break above a row or left of a column) that stop at the printed area, and
 * the print area's outline.
 */
export function paintPageBreaks(ctx: CanvasRenderingContext2D, geo: Geo, sheet: any) {
  const ps = sheet?.pageSetup;
  const rows: number[] = ps?.rowBreaks ?? [], cols: number[] = ps?.colBreaks ?? [];
  const area: string | undefined = sheet?.printArea;
  if (!rows.length && !cols.length && !area) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(geo.cells.x, geo.cells.y, geo.cells.w, geo.cells.h); ctx.clip();
  ctx.strokeStyle = '#4a6fa5'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
  const ranges = printRanges(sheet) as Range[];
  if (ranges.length && (rows.length || cols.length)) {
    const r0 = Math.min(...ranges.map(r => r.start.row)), r1 = Math.max(...ranges.map(r => r.end.row)), c0 = Math.min(...ranges.map(r => r.start.col)), c1 = Math.max(...ranges.map(r => r.end.col));
    const x0 = geo.x(c0), x1 = geo.x(c1 + 1), y0 = geo.y(r0), y1 = geo.y(r1 + 1);
    for (const r of rows) { if (r <= r0 || r > r1) continue; const y = Math.round(geo.y(r)) - 0.5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
    for (const c of cols) { if (c <= c0 || c > c1) continue; const x = Math.round(geo.x(c)) - 0.5; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); }
  }
  if (area) {
    ctx.setLineDash([]); ctx.strokeStyle = '#4a6fa5'; ctx.lineWidth = 1.5;
    for (const part of area.split(',')) {
      const rg = parseRange(part.trim().replace(/\$/g, ''));
      if (!rg) continue;
      const a = geo.cellRect(rg.start), b = geo.cellRect(rg.end);
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x + b.w - a.x) - 1, Math.round(b.y + b.h - a.y) - 1);
    }
  }
  ctx.restore();
}
