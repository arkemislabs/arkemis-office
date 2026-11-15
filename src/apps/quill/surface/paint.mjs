// Paint a Quill page's display list (core/quill/layout/display.mjs `pageDisplay`) on a 2D canvas.
//
// Translated from wordcraft crates/render/src/lib.rs and media.rs (the screen
// rasterizer the page view's textures come from: fills, lines with dash/dot/double/wave strokes,
// text runs in their font with horizontal scale, images with crop and rotation, preset shapes,
// formatting marks in the marks colour) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `paintPage(ctx, items, {scale, originY, images})` draws in page points scaled by `scale`
// (device pixels per point) with the tile's top at `originY` points. Images come from
// `images(mediaKey)`: a decoded image or null while it loads (the caller repaints when it is ready).

import {cssFont} from '../../../../core/quill/layout/shaper-canvas.mjs';
import {placedPaths} from '../../../../core/quill/model/freeform.mjs';
import {paintPrims} from '../../../shell/charts/prims';
import {fillStyleOf, withShapeEffects, paintTextEffects, warpAt} from './shape-fx.mjs';
import {presetOfKind, presetSteps, isOpenPreset} from '../../../../core/quill/lib/shape-presets.mjs';

/** Scripts whose letters join or reorder: drawn as whole runs so the browser shapes them. */
const COMPLEX = /[\u0590-\u08FF\u0900-\u0DFF\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF\uFB1D-\uFDFF\uFE70-\uFEFF\u200C\u200D]/;
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
/** @param {string} s */
function* graphemes(s) {
  if (segmenter) { for (const g of segmenter.segment(s)) yield g.segment; } else yield* s;
}

/** Formatting marks are drawn in Word's mark blue. */
export const MARK_COLOR = 'rgb(39, 99, 167)';

const rgb = (c, a = 1) => `rgba(${c?.[0] ?? 0}, ${c?.[1] ?? 0}, ${c?.[2] ?? 0}, ${a})`;

function strokeLine(ctx, it) {
  const w = Math.max(it.width ?? 0.5, 0.25);
  ctx.save();
  ctx.globalAlpha = it.alpha ?? 1;
  ctx.strokeStyle = rgb(it.color);
  ctx.lineWidth = w;
  ctx.lineCap = 'butt';
  const dash = it.stroke === 'dash' ? [w * 4, w * 2] : it.stroke === 'dot' ? [w, w * 1.5] : [];
  ctx.setLineDash(dash);
  if (it.stroke === 'wave') {
    // A wave of half-periods ~3 line widths long (paint.rs wave).
    const len = Math.hypot(it.x1 - it.x0, it.y1 - it.y0);
    const step = Math.max(w * 3, 1.5);
    const ux = (it.x1 - it.x0) / (len || 1), uy = (it.y1 - it.y0) / (len || 1);
    ctx.beginPath();
    ctx.moveTo(it.x0, it.y0);
    for (let d = step, k = 0; d <= len + 0.01; d += step, k++) {
      const amp = (k % 2 ? -1 : 1) * w * 1.5;
      ctx.quadraticCurveTo(it.x0 + ux * (d - step / 2) - uy * amp, it.y0 + uy * (d - step / 2) + ux * amp, it.x0 + ux * d, it.y0 + uy * d);
    }
    ctx.stroke();
  } else if (it.stroke === 'double') {
    const nx = -(it.y1 - it.y0), ny = it.x1 - it.x0;
    const n = Math.hypot(nx, ny) || 1;
    const off = w;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(it.x0 + nx / n * off * s, it.y0 + ny / n * off * s);
      ctx.lineTo(it.x1 + nx / n * off * s, it.y1 + ny / n * off * s);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(it.x0, it.y0);
    ctx.lineTo(it.x1, it.y1);
    ctx.stroke();
  }
  ctx.restore();
}

function shapePath(ctx, kind, r) {
  const {x, y, w, h} = r;
  ctx.beginPath();
  switch (kind) {
    case 'ellipse': case 'flowchartOr': ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); break;
    case 'roundedRectangle': { const rr = Math.min(Math.abs(w), Math.abs(h)) * 0.1667; ctx.roundRect(x, y, w, h, rr); break; }
    case 'triangle': ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); break;
    case 'rightTriangle': ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); break;
    case 'diamond': ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h / 2); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y + h / 2); ctx.closePath(); break;
    case 'line': case 'straightConnector': ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); break;
    default: {
      // Any other preset (core/quill/lib/shape-presets.mjs): its own geometry on the frame.
      const name = presetOfKind(kind);
      const steps = name ? presetSteps(name, Math.abs(w), Math.abs(h)) : null;
      if (!steps) { ctx.rect(x, y, w, h); break; }
      for (const s of steps) {
        if (s.t === 'M') ctx.moveTo(x + s.p.x, y + s.p.y);
        else if (s.t === 'L') ctx.lineTo(x + s.p.x, y + s.p.y);
        else if (s.t === 'C') ctx.bezierCurveTo(x + s.p1.x, y + s.p1.y, x + s.p2.x, y + s.p2.y, x + s.p.x, y + s.p.y);
        else if (s.t === 'Q') ctx.quadraticCurveTo(x + s.p1.x, y + s.p1.y, x + s.p.x, y + s.p.y);
        else if (s.t === 'Z') ctx.closePath();
      }
    }
  }
}

/** A freeform shape's paths on its frame (ink strokes, Ink to Shape lines and polygons). */
function paintFreeform(ctx, it, r) {
  const f = it.freeform;
  const ink = !!f.ink;
  ctx.lineCap = ink ? 'round' : 'butt';
  ctx.lineJoin = ink ? 'round' : 'miter';
  const placed = placedPaths(f, r.x, r.y, r.w, r.h);
  for (let pi = 0; pi < placed.length; pi++) {
    const [pts, closed] = placed[pi];
    if (!pts.length) continue;
    const d = f.paths[pi]?.d;
    if (d && typeof Path2D === 'function') {
      // Edit Points' outline: the curves as drawn, scaled onto the frame.
      const sx = f.w > 0 ? r.w / f.w : 1, sy = f.h > 0 ? r.h / f.h : 1;
      const path = new Path2D(d), m = new DOMMatrix([sx, 0, 0, sy, r.x, r.y]), scaled = new Path2D();
      scaled.addPath(path, m);
      if (it.fill && closed) { ctx.fillStyle = rgb(it.fill); ctx.fill(scaled); }
      if (it.stroke) { ctx.strokeStyle = rgb(it.stroke); ctx.lineWidth = Math.max(it.strokeWidth ?? 0.75, 0.25); ctx.setLineDash([]); ctx.stroke(scaled); }
      continue;
    }
    ctx.beginPath();
    if (pts.length === 1) {
      // A tap: a dot as wide as the pen.
      if (it.stroke) { ctx.fillStyle = rgb(it.stroke); ctx.arc(pts[0][0], pts[0][1], Math.max(it.strokeWidth ?? 1, 0.5) / 2, 0, Math.PI * 2); ctx.fill(); }
      continue;
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (closed) ctx.closePath();
    if (it.fill && closed && !ink) { ctx.fillStyle = rgb(it.fill); ctx.fill(); }
    if (it.stroke) { ctx.strokeStyle = rgb(it.stroke); ctx.lineWidth = Math.max(it.strokeWidth ?? 0.75, 0.25); ctx.setLineDash([]); ctx.stroke(); }
  }
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
}

/** Arrowheads at the ends of a line or connector (a:headEnd / a:tailEnd). */
function arrowHeads(ctx, it, r) {
  const len = Math.max(6, (it.strokeWidth ?? 1) * 4);
  const head = (tx, ty, fx, fy) => {
    const a = Math.atan2(ty - fy, tx - fx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - len * Math.cos(a - 0.45), ty - len * Math.sin(a - 0.45));
    ctx.lineTo(tx - len * Math.cos(a + 0.45), ty - len * Math.sin(a + 0.45));
    ctx.closePath();
    ctx.fillStyle = rgb(it.stroke);
    ctx.fill();
  };
  if (it.arrowEnd) head(r.x + r.w, r.y + r.h, r.x, r.y);
  if (it.arrowStart) head(r.x, r.y, r.x + r.w, r.y + r.h);
}

function withRotation(ctx, rect, rot, f, flipH = false, flipV = false) {
  if (!rot && !flipH && !flipV) { f(); return; }
  ctx.save();
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  if (flipH || flipV) ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.translate(-cx, -cy);
  f();
  ctx.restore();
}

/** A picture or texture fill (Shape Fill › Picture, Texture) inside the path already on the context: stretched over the shape, or tiled at its scale; the shape's own colour while the picture loads. */
function paintPictureFill(c, fx, r, img, avg) {
  const w = img ? img.naturalWidth || img.width : 0, h = img ? img.naturalHeight || img.height : 0;
  if (!img || !(w > 0 && h > 0)) { if (avg) { c.fillStyle = rgb(avg); c.fill(); } return; }
  c.save();
  c.globalAlpha *= 1 - (fx.transparency ?? 0) / 100;
  c.clip();
  if (fx.tile) {
    const tw = Math.max(w * 0.75 * (fx.scale ?? 100) / 100, 2), th = Math.max(h * 0.75 * (fx.scale ?? 100) / 100, 2);
    const cols = Math.min(Math.ceil(r.w / tw), 200), rows = Math.min(Math.ceil(r.h / th), 200);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) c.drawImage(img, r.x + x * tw, r.y + y * th, tw, th);
  } else c.drawImage(img, r.x, r.y, r.w, r.h);
  c.restore();
}

/**
 * Paint `items` (page points) on `ctx`. `scale`: device pixels per point; `originY`: the page y
 * (points) at the top of the canvas; `images(key)`: a CanvasImageSource or null.
 */
/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {any[]} items
 * @param {{scale: number, originY?: number, images?: (key: string) => (CanvasImageSource & {naturalWidth?: number, naturalHeight?: number, width?: any, height?: any}) | null, clipTop?: number, clipBottom?: number, advance?: ((text: string, font: any) => number) | null}} o
 */
export function paintPage(ctx, items, o) {
  const {scale, originY = 0, images = () => null, clipTop = -Infinity, clipBottom = Infinity, advance = null} = o;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, -originY * scale);
  ctx.textBaseline = 'alphabetic';
  // The layout measured each grapheme cluster on its own (no kerning, no ligatures, as Word lays
  // text out unless Kerning for fonts applies): draw runs the same way, or a long run drawn as one
  // string comes out shorter than its laid-out width and leaves a gap before the next run.
  const c2 = /** @type {any} */ (ctx);
  if ('fontKerning' in c2) c2.fontKerning = 'none';
  if ('textRendering' in c2) c2.textRendering = 'optimizeSpeed';
  if ('fontVariantCaps' in c2) c2.fontVariantCaps = 'normal';
  for (const it of items) {
    // Text of a turned text box (Shape Format › Text Direction) is laid out upright in its frame and rotated onto it.
    const cT = it.turn ? -Infinity : clipTop, cB = it.turn ? Infinity : clipBottom;
    if (it.turn) {
      ctx.save();
      ctx.translate(it.turn.tx, it.turn.ty);
      ctx.rotate((it.turn.deg * Math.PI) / 180);
      ctx.translate(-it.turn.fx, -it.turn.fy);
    }
    switch (it.type) {
      case 'fill': {
        const r = it.rect;
        if (r.y > cB || r.y + r.h < cT) break;
        ctx.globalAlpha = it.alpha ?? 1;
        ctx.fillStyle = rgb(it.color);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.globalAlpha = 1;
        break;
      }
      case 'line':
        if (Math.max(it.y0, it.y1) + (it.width ?? 1) < cT || Math.min(it.y0, it.y1) - (it.width ?? 1) > cB) break;
        strokeLine(ctx, it);
        break;
      case 'text': {
        const size = it.font?.size ?? 10;
        if (it.y + size < cT || it.y - size * 1.5 > cB) break;
        ctx.font = cssFont(it.font ?? {family: 'Calibri', size: 11});
        const base = rgb(it.color, it.alpha ?? 1);
        // One pass of the run's text: its fill (the current fill style) or its outline.
        const put = mode => {
          const draw = mode === 'stroke' ? (s, x, y) => ctx.strokeText(s, x, y) : (s, x, y) => ctx.fillText(s, x, y);
          if (it.warp && !it.spacing) {
            // Bent along a text warp: each letter placed, turned and stretched by the warp where it falls.
            let x = it.x;
            for (const g of graphemes(it.text)) {
              const gw = advance ? advance(g, it.font) * (it.xScale || 1) : ctx.measureText(g).width;
              const at = warpAt(it.warp.preset, it.warp.frame, x + gw / 2, it.y, size);
              ctx.save();
              ctx.translate(x + gw / 2 + at.dx, it.y + at.dy);
              if (at.rot) ctx.rotate(at.rot);
              if (at.sy !== 1) ctx.scale(1, at.sy);
              draw(g, -gw / 2, 0);
              ctx.restore();
              x += gw;
            }
          } else if (it.spacing) {
            // Tab leaders: one character per `spacing`.
            let x = it.x;
            for (const ch of it.text) { draw(ch, x, it.y); x += it.spacing; }
          } else if (advance && !COMPLEX.test(it.text)) {
            // Each grapheme at its laid-out x (the shaper's advances, as the layout placed them):
            // the canvas draws a whole string with its own hinted advances, which drift from the
            // layout over a long run and open gaps before the next run.
            const xs = it.xScale && Math.abs(it.xScale - 1) > 1e-3 ? it.xScale : 1;
            let x = it.x;
            for (const g of graphemes(it.text)) {
              if (xs !== 1) { ctx.save(); ctx.translate(x, it.y); ctx.scale(xs, 1); draw(g, 0, 0); ctx.restore(); } else draw(g, x, it.y);
              x += advance(g, it.font) * xs;
            }
          } else if (it.xScale && Math.abs(it.xScale - 1) > 1e-3) {
            ctx.save();
            ctx.translate(it.x, it.y);
            ctx.scale(it.xScale, 1);
            draw(it.text, 0, 0);
            ctx.restore();
          } else draw(it.text, it.x, it.y);
        };
        if (it.fx && !it.spacing) {
          const width = advance ? advance(it.text, it.font) : ctx.measureText(it.text).width;
          paintTextEffects(ctx, it.fx, {x: it.x, y: it.y, w: width, size}, base, scale, put);
        } else { ctx.fillStyle = base; put('fill'); }
        break;
      }
      case 'image': {
        const r = it.rect;
        if (r.y > cB || r.y + r.h < cT) break;
        const img = images(it.media);
        withRotation(ctx, r, it.rot, () => {
          ctx.globalAlpha = it.alpha ?? 1;
          // The picture on `c` (the page, or a canvas of its own for soft edges and reflections).
          const drawPic = (c = ctx) => {
            if (!img) { c.fillStyle = 'rgba(0,0,0,0.04)'; c.fillRect(r.x, r.y, r.w, r.h); return; }
            const iw = img.naturalWidth ?? img.width, ih = img.naturalHeight ?? img.height;
            const cr = it.crop;
            const pad = it.pad > 0 && it.pad * 2 < Math.min(iw, ih) ? it.pad : 0;
            if (pad && Array.isArray(cr) && cr.some(v => v)) {
              // A style or border frame is part of the bitmap: the crop cuts the picture inside it, and the frame is kept all round.
              const inW = iw - 2 * pad, inH = ih - 2 * pad;
              const sw = inW * (1 - (cr[0] ?? 0) - (cr[2] ?? 0)), sh = inH * (1 - (cr[1] ?? 0) - (cr[3] ?? 0));
              if (sw > 0 && sh > 0) {
                const k = Math.min(r.w / (sw + 2 * pad), r.h / (sh + 2 * pad));
                const dw = (sw + 2 * pad) * k, dh = (sh + 2 * pad) * k, dx = r.x + (r.w - dw) / 2, dy = r.y + (r.h - dh) / 2;
                c.save();
                c.beginPath(); c.rect(dx, dy, dw, dh); c.rect(dx + pad * k, dy + pad * k, dw - 2 * pad * k, dh - 2 * pad * k);
                c.clip('evenodd');
                c.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);
                c.restore();
                c.drawImage(img, pad + inW * (cr[0] ?? 0), pad + inH * (cr[1] ?? 0), sw, sh, dx + pad * k, dy + pad * k, sw * k, sh * k);
              }
            } else if (Array.isArray(cr) && cr.some(v => v)) {
              // A crop is the part of the picture the frame shows; a negative side is padding (the frame is larger than the picture there), left empty, never black.
              const sx = iw * (cr[0] ?? 0), sy = ih * (cr[1] ?? 0);
              const sw = iw * (1 - (cr[0] ?? 0) - (cr[2] ?? 0)), sh = ih * (1 - (cr[1] ?? 0) - (cr[3] ?? 0));
              if (sw > 0 && sh > 0) {
                const x0 = Math.max(0, sx), x1 = Math.min(iw, sx + sw), y0 = Math.max(0, sy), y1 = Math.min(ih, sy + sh);
                const kx = r.w / sw, ky = r.h / sh;
                if (x1 > x0 && y1 > y0) c.drawImage(img, x0, y0, x1 - x0, y1 - y0, r.x + (x0 - sx) * kx, r.y + (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
              }
            } else c.drawImage(img, r.x, r.y, r.w, r.h);
          };
          if (it.effects && img) withShapeEffects(ctx, it.effects, r, scale, drawPic, drawPic, c => { c.beginPath(); c.rect(r.x, r.y, r.w, r.h); });
          else drawPic();
          ctx.globalAlpha = 1;
        }, it.flipH, it.flipV);
        break;
      }
      case 'chart':
      case 'math': {
        const r = it.rect;
        if (r.y > cB || r.y + r.h < cT) break;
        withRotation(ctx, r, it.rot, () => {
          ctx.globalAlpha = it.alpha ?? 1;
          paintPrims(ctx, it.prims, r.x, r.y, 1, '"' + it.family + '", Carlito, Arial, sans-serif');
          ctx.globalAlpha = 1;
        });
        break;
      }
      case 'shape': {
        const r = it.rect;
        if (r.y > cB || r.y + r.h < cT) break;
        withRotation(ctx, r, it.rot, () => {
          ctx.globalAlpha = (it.alpha ?? 1) * (it.freeform?.alpha ?? 1);
          if (it.freeform) paintFreeform(ctx, it, r);
          else {
            const open = it.kind === 'line' || it.kind === 'straightConnector' || isOpenPreset(presetOfKind(it.kind));
            // The shape's own drawing, on `c` (the page, or the canvas soft edges are drawn on first).
            const body = (c = ctx) => {
              shapePath(c, it.kind, r);
              if (it.fillFx?.type === 'picture' && !open) paintPictureFill(c, it.fillFx, r, images(it.fillFx.media), it.fill);
              else {
                const fs = it.fillFx ? fillStyleOf(c, it.fillFx, r) : it.fill ? rgb(it.fill) : null;
                if (fs && !open) { c.fillStyle = fs; c.fill(); }
              }
              if (it.stroke) { c.strokeStyle = rgb(it.stroke); c.lineWidth = Math.max(it.strokeWidth ?? 0.75, 0.25); c.setLineDash([]); c.stroke(); }
              if (c === ctx && it.stroke && (it.arrowStart || it.arrowEnd) && open) arrowHeads(ctx, it, r);
            };
            if (it.effects) {
              // What a shadow or glow is cast by: the filled shape, or an outline-only shape's line.
              const silhouette = () => {
                shapePath(ctx, it.kind, r);
                if (it.fill && !open) { ctx.fillStyle = rgb(it.fill); ctx.fill(); } else if (it.stroke) { ctx.strokeStyle = rgb(it.stroke); ctx.lineWidth = Math.max(it.strokeWidth ?? 0.75, 0.25); ctx.stroke(); }
              };
              withShapeEffects(ctx, it.effects, r, scale, body, silhouette, c => shapePath(c, it.kind, r));
            } else body();
          }
          ctx.globalAlpha = 1;
        }, it.flipH, it.flipV);
        break;
      }
      case 'mark': {
        if (it.baseline + it.size < cT || it.baseline - it.size * 1.5 > cB) break;
        ctx.font = cssFont({family: 'Calibri', size: it.size, bold: false, italic: false});
        ctx.fillStyle = MARK_COLOR;
        if (it.ch === '·') { ctx.textAlign = 'center'; ctx.fillText(it.ch, it.x, it.baseline); ctx.textAlign = 'start'; } else ctx.fillText(it.ch, it.x, it.baseline);
        break;
      }
      default: break;
    }
    if (it.turn) ctx.restore();
  }
  ctx.restore();
}

/** A data: URL for a media entry of content.media (base64), typed by its key's extension. */
export function mediaUrl(key, base64) {
  const ext = String(key).split('.').pop()?.toLowerCase() ?? '';
  const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml'
    : ext === 'bmp' ? 'image/bmp' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${type};base64,${base64}`;
}
