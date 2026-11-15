// Horizontal and vertical rulers for the caret's page and paragraph, as Word draws them in Print
// Layout: the page's width (or height) as a bar, the margins shaded, graduations in the File ›
// Options unit numbered from the start margin across the text area, and the caret paragraph's
// first-line, hanging/left and right indent markers.
//
// Translated from wordcraft crates/ui-egui/src/canvas/rulers.rs (`rulers`, `indent_marker_rects`,
// `ruler_mark`; the marks themselves are geometry.mjs `rulerMarks`) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Dragging the indent markers (para.indents), the margins (layout.pageSetup), tab stops
// (ruler_tabs.rs) and table columns (table_ruler.rs) needs those commands; until their families
// land the markers are shown and do not drag (the pointer stays the arrow).

import {useLayoutEffect, useRef} from 'react';
import {RULER, rulerMarks, rulerScale, rulerX} from './geometry.mjs';

type RulerMark = {label: number} | {tick: number};

interface Rect { x: number; y: number; w: number; h: number }
export interface RulerPage { w: number; h: number; body: Rect }
export interface RulerPara { indentLeft: number; indentRight: number; indentFirst: number; bidi: boolean }

const COLORS = {
  ground: '#121213', margin: 'rgba(255,255,255,0.07)', text: 'rgba(255,255,255,0.16)', tick: 'rgba(255,255,255,0.58)',
  marker: 'rgba(255,255,255,0.78)', markerFill: '#2a2a2d',
};

function useCanvas(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    draw(ctx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, ...deps]);
  return ref;
}

function mark(ctx: CanvasRenderingContext2D, x: number, y: number, m: RulerMark, horizontal: boolean, keepClear: Rect[]) {
  let len: number;
  if ('label' in m) {
    ctx.font = '9.5px system-ui, sans-serif';
    const text = String(m.label);
    const w = ctx.measureText(text).width, h = 10;
    const r = {x: x - w / 2, y: y - h / 2, w, h};
    if (!keepClear.some(o => o.x < r.x + r.w && r.x < o.x + o.w && o.y < r.y + r.h && r.y < o.y + o.h)) {
      ctx.fillStyle = COLORS.tick;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
      return;
    }
    len = 7;
  } else len = m.tick;
  ctx.strokeStyle = COLORS.tick;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (horizontal) { ctx.moveTo(Math.round(x) + 0.5, y - len / 2); ctx.lineTo(Math.round(x) + 0.5, y + len / 2); } else { ctx.moveTo(x - len / 2, Math.round(y) + 0.5); ctx.lineTo(x + len / 2, Math.round(y) + 0.5); }
  ctx.stroke();
}

function triangle(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
  ctx.closePath();
  ctx.fillStyle = COLORS.markerFill;
  ctx.fill();
  ctx.strokeStyle = COLORS.marker;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** The horizontal ruler: `x0` is the page's left edge in the ruler's coordinates. */
export function HRuler({width, x0, scale, page, para, unit, column}: {width: number; x0: number; scale: number; page: RulerPage | null; para: RulerPara | null; unit: string;
  column: {x: number; w: number} | null}) {
  const ref = useCanvas(width, RULER, ctx => {
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, 0, width, RULER);
    if (!page) return;
    const bar = {x: x0, y: 4, w: page.w * scale, h: RULER - 7};
    ctx.fillStyle = COLORS.margin;
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    ctx.fillStyle = COLORS.text;
    ctx.fillRect(x0 + page.body.x * scale, bar.y, page.body.w * scale, bar.h);
    const rtl = !!para?.bidi;
    const origin = rtl ? page.w - (page.body.x + page.body.w) : page.body.x;
    const sx = (d: number) => rulerX(d, x0, scale, page.w, rtl);
    const colX = column?.x ?? page.body.x, w = column?.w ?? page.body.w;
    const start = rtl ? page.w - (colX + w) : colX;
    const px = (s: number) => sx(start + s);
    const keepClear: Rect[] = [];
    let markers: {first: number; left: number; right: number} | null = null;
    if (para) {
      markers = {first: px(para.indentLeft + para.indentFirst), left: px(para.indentLeft), right: px(w - para.indentRight)};
      keepClear.push({x: markers.first - 4.5, y: bar.y, w: 9, h: 5}, {x: markers.left - 4.5, y: bar.y + bar.h - 8, w: 9, h: 9},
        {x: markers.right - 4.5, y: bar.y + bar.h - 6, w: 9, h: 5});
    }
    const cy = bar.y + bar.h / 2;
    for (const [d, m] of rulerMarks(origin, page.body.w, page.w, rulerScale(unit), scale) as [number, RulerMark][]) mark(ctx, sx(d), cy, m, true, keepClear);
    if (markers) {
      const top = bar.y, bottom = bar.y + bar.h;
      triangle(ctx, [[markers.first - 4.5, top], [markers.first + 4.5, top], [markers.first, top + 5]]);
      triangle(ctx, [[markers.left - 4.5, bottom - 3], [markers.left + 4.5, bottom - 3], [markers.left, bottom - 8]]);
      ctx.fillStyle = COLORS.markerFill;
      ctx.fillRect(markers.left - 4.5, bottom - 3, 9, 4);
      ctx.strokeStyle = COLORS.marker;
      ctx.strokeRect(markers.left - 4, bottom - 2.5, 8, 3);
      triangle(ctx, [[markers.right - 4.5, bottom - 1], [markers.right + 4.5, bottom - 1], [markers.right, bottom - 6]]);
    }
  }, [x0, scale, page, para, unit, column?.x, column?.w]);
  return <canvas ref={ref} className="quill-hruler" style={{width, height: RULER}} aria-hidden="true"/>;
}

/** The vertical ruler: `y0` is the page's top edge in the ruler's coordinates. */
export function VRuler({height, y0, scale, page, unit}: {height: number; y0: number; scale: number; page: RulerPage | null; unit: string}) {
  const ref = useCanvas(RULER, height, ctx => {
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, 0, RULER, height);
    if (!page) return;
    const bar = {x: 4, y: y0, w: RULER - 7, h: page.h * scale};
    ctx.fillStyle = COLORS.margin;
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    ctx.fillStyle = COLORS.text;
    ctx.fillRect(bar.x, y0 + page.body.y * scale, bar.w, page.body.h * scale);
    const cx = bar.x + bar.w / 2;
    for (const [d, m] of rulerMarks(page.body.y, page.body.h, Math.min(page.h, 20_000), rulerScale(unit), scale) as [number, RulerMark][]) mark(ctx, cx, y0 + d * scale, m, false, []);
  }, [y0, scale, page, unit]);
  return <canvas ref={ref} className="quill-vruler" style={{width: RULER, height}} aria-hidden="true"/>;
}
