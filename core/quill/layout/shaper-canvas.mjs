// The Canvas2D text shaper the Quill page view lays text out with (architecture 16.1).
//
// Upstream: wordcraft crates/layout shapes with `wordcraft_fonts` (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c, `para/builder.rs`, `wordcraft_fonts::word::line_metrics`).
// Here the browser shapes: `measureText` gives each cluster's advance (the browser applies the
// installed font, its fallback and complex-script shaping inside the cluster) and the font's
// bounding ascent/descent give the line metrics. Canvas pixels are used as points: a font of N px
// measures in the same unit as N pt, so no scaling is needed.
//
// Usage (renderer only; no DOM in Node tests):
//   import {createCanvasShaper} from '.../layout/shaper-canvas.mjs';
//   import {setDefaultShaper} from '.../layout/shaper.mjs';
//   setDefaultShaper(createCanvasShaper());

/** Quote a family for the CSS font shorthand. */
const cssFamily = f => `"${String(f || 'sans-serif').replace(/["\\]/g, '')}", sans-serif`;
/** The CSS font shorthand for a font spec (size in px = points). */
export const cssFont = f => `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${Math.max(0.5, f.size)}px ${cssFamily(f.family)}`;

const MAX_ENTRIES = 200_000;

/**
 * A shaper over a 2D canvas context. `ctx` defaults to an OffscreenCanvas (or a detached
 * `<canvas>`) context. Advances are cached per font and text; metrics per font.
 */
export function createCanvasShaper(ctx = null) {
  if (!ctx) {
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(8, 8) : globalThis.document?.createElement('canvas');
    ctx = canvas?.getContext('2d');
  }
  if (!ctx) throw new Error('Canvas 2D is not available');
  const adv = new Map();
  const met = new Map();
  let current = '';
  const use = f => {
    const font = cssFont(f);
    if (font !== current) { ctx.font = font; current = font; }
    return font;
  };
  return {
    key: 'canvas',
    metrics(f) {
      const font = cssFont(f);
      let m = met.get(font);
      if (!m) {
        use(f);
        const t = ctx.measureText('Hg');
        const ascent = Number.isFinite(t.fontBoundingBoxAscent) ? t.fontBoundingBoxAscent : f.size * 0.9;
        const descent = Number.isFinite(t.fontBoundingBoxDescent) ? t.fontBoundingBoxDescent : f.size * 0.22;
        m = {ascent, descent};
        met.set(font, m);
      }
      return m;
    },
    advance(text, f) {
      const font = cssFont(f);
      const k = font + '\u0000' + text;
      let w = adv.get(k);
      if (w === undefined) {
        use(f);
        w = ctx.measureText(text).width;
        if (adv.size > MAX_ENTRIES) adv.clear();
        adv.set(k, w);
      }
      return w;
    },
  };
}
