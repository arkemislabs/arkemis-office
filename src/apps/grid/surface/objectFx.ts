// What the Shape Format, Picture Format and Chart Format tabs add to an object on the sheet: a picture with its crop, corrections, transparency,
// frame shape and border; shape effects (shadow, glow, soft edges, reflection, bevel) on a chart, picture or shape; WordArt on a shape's text.
// Not in gridcraft; the effects are drawn by Quill's painter (src/apps/quill/surface/shape-fx.mjs, translated from wordcraft's render crate),
// the stored fields are in core/grid/lib/object-fx.mjs. Not checked against upstream. U:grid/object-format.

import type {Rect} from './geo';
import {adjustOf, cssFilter, opacityOf, cropOf} from '../../../../core/grid/lib/object-fx.mjs';
// @ts-ignore plain JavaScript module
import {withShapeEffects, paintTextEffects} from '../../quill/surface/shape-fx.mjs';

/** The outline of a frame shape (Crop to Shape, the picture styles, a shape's own kind) over (x, y, w, h). */
export function framePath(ctx: CanvasRenderingContext2D, geom: string | undefined, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  const poly = (pts: number[][]) => { pts.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * w, y + py * h) : ctx.moveTo(x + px * w, y + py * h))); ctx.closePath(); };
  switch (geom) {
    case 'roundRect': case 'roundedRectangle': if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.16); else ctx.rect(x, y, w, h); break;
    case 'ellipse': ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'triangle': poly([[0.5, 0], [1, 1], [0, 1]]); break;
    case 'diamond': poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]); break;
    case 'hexagon': poly([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]); break;
    case 'octagon': poly([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]]); break;
    default: ctx.rect(x, y, w, h);
  }
}

/**
 * Draw an object with its shape effects: `body(c)` draws it on `c` (the sheet's context, or the offscreen one an effect asks for), `geom` is
 * the outline the shadow and glow follow. Without effects the body is drawn as it is.
 */
export function paintWithFx(ctx: CanvasRenderingContext2D, fx: any, rect: Rect, z: number, geom: string | undefined, body: (c: CanvasRenderingContext2D) => void) {
  if (!fx || !Object.keys(fx).length) { body(ctx); return; }
  const path = (c: CanvasRenderingContext2D) => framePath(c, geom, rect.x, rect.y, rect.w, rect.h);
  const silhouette = () => { ctx.save(); path(ctx); ctx.fillStyle = '#000000'; ctx.fill(); ctx.restore(); };
  (withShapeEffects as any)(ctx, fx, rect, z * 96 / 72, (c?: CanvasRenderingContext2D) => body(c ?? ctx), silhouette, path);
}

/** A picture: its crop, corrections (the CSS filter of object-fx.mjs), transparency, frame shape, border and effects (Picture Format). */
export function paintPicture(ctx: CanvasRenderingContext2D, img: HTMLImageElement, pic: any, rect: Rect, z: number, css: (c: any, fallback: string | null) => string | null) {
  const {x, y, w, h} = rect;
  const body = (c: CanvasRenderingContext2D) => {
    c.save();
    if (pic.geom && pic.geom !== 'rect') { framePath(c, pic.geom, x, y, w, h); c.clip(); }
    const filter = cssFilter(adjustOf(pic));
    if (filter) c.filter = filter;
    c.globalAlpha = opacityOf(pic.adjust);
    const k = cropOf(pic), nw = img.naturalWidth, nh = img.naturalHeight;
    c.drawImage(img, nw * k.l, nh * k.t, Math.max(1, nw * (1 - k.l - k.r)), Math.max(1, nh * (1 - k.t - k.b)), x, y, w, h);
    c.restore();
    if (pic.border) {
      const bw = Math.max(1, (pic.border.width ?? 2.25) * z);
      c.save();
      c.strokeStyle = css(pic.border.color, '#000000') ?? '#000000'; c.lineWidth = bw; c.lineJoin = 'miter';
      framePath(c, pic.geom, x + bw / 2, y + bw / 2, Math.max(0, w - bw), Math.max(0, h - bw));
      c.stroke();
      c.restore();
    }
  };
  paintWithFx(ctx, pic.fx, rect, z, pic.geom, body);
}

/** A shape's text lines with WordArt (Shape Format > WordArt Styles, Text Fill, Text Outline, Text Effects). */
export function paintWordArtLines(ctx: CanvasRenderingContext2D, fx: any, lines: string[], tx: number, top: number, lh: number, size: number, z: number, base: string, align: string) {
  ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => {
    const base_y = top + i * lh + size * 0.85;
    const width = ctx.measureText(l).width;
    const x = align === 'center' ? tx - width / 2 : align === 'right' ? tx - width : tx;
    paintTextEffects(ctx, fx, {x, y: base_y, w: width, size}, base, z * 96 / 72, (mode: string) => {
      const savedAlign = ctx.textAlign;
      ctx.textAlign = 'left';
      if (mode === 'stroke') ctx.strokeText(l, x, base_y); else ctx.fillText(l, x, base_y);
      ctx.textAlign = savedAlign;
    });
  });
}
