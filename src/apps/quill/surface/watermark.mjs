// The document's text watermark (Design › Watermark), drawn on every page behind the text.
// Translated from wordcraft crates/render/src/lib.rs `draw_watermark` at
// aadb077e072b7de05f724e359d8db82e151f125c (MIT, see assets/third-party-licenses/artcraft-reference.txt):
// the text stretched over its box (Word's `v:textpath fitshape`): its advance across the box, its
// em down it with the em's foot on the box's bottom; the box centred on the margins and, when
// diagonal, turned 45°; the colour at 35 % (semitransparent) or 80 %.

import {watermarkFrame} from '../../../../core/quill/model/content.mjs';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{w: number, h: number, markup?: number, body?: {x: number, y: number, w: number, h: number}}} page
 * @param {{text?: string, font?: string, color?: number[], diagonal?: boolean, semitransparent?: boolean, size?: number[] | null} | null} wm
 * @param {{scale: number, originY?: number, images?: (key: string) => HTMLImageElement | null}} o
 */
export function paintWatermark(ctx, page, wm, o) {
  if (!wm || !page) return;
  if (wm.picture) { paintPictureWatermark(ctx, page, wm, o); return; }
  const text = [...String(wm.text ?? '')].slice(0, 200).join('');
  if (!text.trim()) return;
  const {scale, originY = 0} = o;
  // The document page, not a Print Markup area beside it.
  const pw = Math.max(1, (page.w ?? 0) - Math.max(0, page.markup ?? 0));
  const ph = Math.min(2000, page.h ?? 0);
  const [bw, bh] = watermarkFrame(wm, pw, page.h);
  const size = Math.min(bh, 2000);
  if (!(size > 0) || !(bw > 0)) return;
  const family = String(wm.font || 'Aptos').replace(/["\\]/g, '');
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, -originY * scale);
  ctx.font = `${size}px "${family}", "Aptos", "Calibri", sans-serif`;
  const m = ctx.measureText(text);
  if (!(m.width > 0)) { ctx.restore(); return; }
  const stretch = bw / m.width;
  const descent = Math.max(0, Math.min(1, (Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : size * 0.21) / size));
  const b = page.body;
  const [cx, cy] = b && b.w > 0 && b.h > 0 ? [b.x + b.w / 2, b.y + b.h / 2] : [pw / 2, ph / 2];
  ctx.translate(cx, cy);
  if (wm.diagonal) ctx.rotate(-Math.PI / 4);
  ctx.translate(-bw / 2, bh / 2 - descent * bh);
  ctx.scale(stretch, 1);
  const [r, g, bl] = Array.isArray(wm.color) && wm.color.length === 3 ? wm.color : [0xc0, 0xc0, 0xc0];
  ctx.fillStyle = `rgba(${r}, ${g}, ${bl}, ${wm.semitransparent === false ? 0.8 : 0.35})`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** A picture watermark: the picture in its frame (its size times Scale, or Auto), centred on the margins, washed out when asked. */
function paintPictureWatermark(ctx, page, wm, o) {
  const img = o.images ? o.images(wm.picture.media) : null;
  if (!img || !(img.naturalWidth > 0)) return;
  const {scale, originY = 0} = o;
  const pw = Math.max(1, (page.w ?? 0) - Math.max(0, page.markup ?? 0));
  const [bw, bh] = watermarkFrame(wm, pw, page.h);
  const b = page.body;
  const [cx, cy] = b && b.w > 0 && b.h > 0 ? [b.x + b.w / 2, b.y + b.h / 2] : [pw / 2, Math.min(2000, page.h ?? 0) / 2];
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, -originY * scale);
  if (wm.washout !== false) { ctx.globalAlpha = 0.4; try { ctx.filter = 'brightness(1.35) contrast(.7)'; } catch { /* no filters here */ } }
  ctx.drawImage(img, cx - bw / 2, cy - bh / 2, bw, bh);
  ctx.restore();
}
