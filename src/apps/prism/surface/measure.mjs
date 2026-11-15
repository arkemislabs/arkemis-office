// Text metrics for the translated deckcraft text layout (core/prism/model/textlayout.mjs), from
// Canvas2D (architecture 16.3: line breaking and autofit come from the translation, glyph shaping
// from the browser). One CSS pixel inside a slide is one point, so a font of `size` points is
// measured at `size` px, and the SVG text that draws a line uses the very same font stack.
// F:prism surface. Plain JS so the surface.pointer command (src/apps/prism/ui-commands) and node tests import it too.

/** @typedef {{family: string, size: number, bold?: boolean, italic?: boolean}} FontSpec */

/** Families after the document's own: metric-compatible stand-ins first, then the platform UI font. */
const FALLBACK = 'Carlito, Calibri, "Segoe UI", Arial, sans-serif';

/** The CSS font-family list a run is drawn with (and measured with). */
/** @param {string | null | undefined} family */
export function fontStack(family) {
  const f = String(family ?? '').replace(/["\\]/g, '').trim();
  return f ? `"${f}", ${FALLBACK}` : FALLBACK;
}

/** @param {FontSpec} f */
export function cssFont(f) {
  return `${f.italic ? 'italic ' : ''}${f.bold ? 700 : 400} ${Math.max(f.size, 0.1)}px ${fontStack(f.family)}`;
}

/** @type {CanvasRenderingContext2D | null} */
let ctx = null;
const widthCache = new Map();
const metricCache = new Map();

function context() {
  if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  return ctx;
}

/** Advance width of `text` in `font` (points). */
/** @param {FontSpec} font @param {string} text @returns {number} */
export function measure(font, text) {
  const c = context();
  if (!c) return text.length * font.size * 0.5;
  const key = `${cssFont(font)}\u0000${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    c.font = cssFont(font);
    w = c.measureText(text).width;
    if (widthCache.size > 200_000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

/** The font's ascent and descent (font bounding box) at `font.size`. */
/** @param {FontSpec} font @returns {{ascent: number, descent: number}} */
export function metrics(font) {
  const c = context();
  if (!c) return {ascent: font.size * 0.8, descent: font.size * 0.2};
  const key = cssFont(font);
  let m = metricCache.get(key);
  if (!m) {
    c.font = key;
    const t = c.measureText('Hg');
    m = {ascent: t.fontBoundingBoxAscent || font.size * 0.8, descent: t.fontBoundingBoxDescent || font.size * 0.2};
    metricCache.set(key, m);
  }
  return m;
}

/** Fonts finished loading: cached widths from fallback faces must go. */
if (typeof document !== 'undefined' && /** @type {any} */ (document).fonts?.addEventListener) {
  /** @type {any} */ (document).fonts.addEventListener('loadingdone', () => { widthCache.clear(); metricCache.clear(); });
}
