// Glyph extraction: every glyph a page draws, with its Unicode text and its em box as a quad in
// page view space, from pdf.js's operator list (pdf.js keeps rendering the page; this reads the
// same operators it paints with, so the boxes sit exactly on the painted glyphs).
//
// Translated from printcraft crates/render/src/text/device.rs (TextDevice::draw_glyph: the em box
// spans the descender (-200) to the ascender (800) of 1000 units per em and the advance width;
// quad corners in the writing direction; control characters dropped; direction quarter) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The text state arithmetic follows pdf.js's own CanvasGraphics.showText (pdfjs-dist 6.4.299) so
// the positions match what pdf.js paints.
//
// No DOM, no Node built-ins: the caller passes the pdf.js module (for OPS) and a page proxy.

import {mul, apply} from '../lib/geom.mjs';
import {layoutPage, quarterOf} from './text.mjs';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const FONT_IDENTITY = [0.001, 0, 0, 0.001, 0, 0];

function freshText() {
  return {font: null, fontSize: 0, fontMatrix: FONT_IDENTITY, fontDirection: 1, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0,
    textMatrix: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0};
}

/**
 * Glyphs in content order, view space of the page shown at `rotation` (scale 1).
 * @param {{OPS: Record<string, number>}} pdfjs
 * @param {any} page pdf.js PDFPageProxy
 * @param {{rotation?: number}} [opts]
 */
export async function extractGlyphs(pdfjs, page, {rotation} = {}) {
  const OPS = pdfjs.OPS;
  const viewport = page.getViewport({scale: 1, rotation: rotation ?? page.rotate});
  const ops = await page.getOperatorList({annotationMode: pdfjs.AnnotationMode?.DISABLE ?? 0});
  const fonts = new Map();
  const fontOf = id => {
    if (fonts.has(id)) return fonts.get(id);
    let f = null;
    try { f = page.commonObjs.has(id) ? page.commonObjs.get(id) : page.objs.has(id) ? page.objs.get(id) : null; } catch { f = null; }
    fonts.set(id, f);
    return f;
  };
  const glyphs = [];
  const stack = [];
  let ctm = IDENTITY.slice();
  // What the glyphs are drawn in, for the readers that care (Export to Word reads sizes, weights and colours): one object per
  // font and fill colour, shared by the glyphs drawn in it.
  let fill = [0, 0, 0];
  const styles = new Map();
  const styleOf = font => {
    const name = String(font?.name ?? font?.loadedName ?? '');
    const key = `${name}|${font?.bold ? 1 : 0}${font?.italic ? 1 : 0}${font?.black ? 1 : 0}|${fill.join(',')}`;
    let st = styles.get(key);
    if (!st) {
      const lower = name.toLowerCase();
      st = {font: name, bold: !!(font?.bold || font?.black || /bold|black|heavy/.test(lower)), italic: !!(font?.italic || /italic|oblique/.test(lower)), color: [...fill]};
      styles.set(key, st);
    }
    return st;
  };
  let t = freshText();
  const view = viewport.transform;

  /** Push a glyph whose box corners are given in text space relative to the pen (before Tm). */
  const emitCorners = (text, corners) => {
    const hs = t.hScale * t.fontDirection;
    const toView = mul(mul(t.textMatrix, ctm), view);
    const quad = corners.map(([x, y]) => apply(toView, t.x + hs * x, t.y + t.rise + y));
    const xs = quad.map(q => q[0]), ys = quad.map(q => q[1]);
    const dx = quad[1][0] - quad[0][0], dy = quad[1][1] - quad[0][1], len = Math.hypot(dx, dy) || 1;
    const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    // device.rs draw_glyph: a box that is not finite, larger than 10,000 pt or outside the crop box is dropped.
    if (!rect.every(Number.isFinite) || rect[2] - rect[0] > 10000 || rect[3] - rect[1] > 10000) return;
    if (Math.max(rect[0], 0) >= Math.min(rect[2], viewport.width) || Math.max(rect[1], 0) >= Math.min(rect[3], viewport.height)) return;
    const direction = Number.isFinite(len) && len > 0 ? [dx / len, dy / len] : [1, 0];
    // The em box's height across the baseline is the font size on the page.
    const size = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
    glyphs.push({text, rect, quad, direction, size, style: styleOf(t.font)});
  };
  // The em box from the descender (-0.2 em) to the ascender (0.8 em): start and end of the
  // descender edge, then the end and start of the ascender edge (render/text/device.rs).
  const emit = (text, x0, x1, fontSize) => {
    const d = -0.2 * fontSize * t.fontDirection, a = 0.8 * fontSize * t.fontDirection;
    emitCorners(text, [[x0, d], [x1, d], [x1, a], [x0, a]]);
  };

  const showText = list => {
    const font = t.font, fontSize = t.fontSize;
    if (!font || !fontSize) return;
    const vertical = !!font.vertical;
    const spacingDir = vertical ? 1 : -1;
    const fm = t.fontMatrix;
    const widthAdvanceScale = fontSize * fm[0];
    let x = 0;
    for (const g of list) {
      if (typeof g === 'number') { x += spacingDir * g * fontSize / 1000; continue; }
      if (!g) continue;
      const spacing = (g.isSpace ? t.wordSpacing : 0) + t.charSpacing;
      let advance;
      if (font.isType3Font) advance = (g.width ?? 0) * fm[0] * fontSize;
      else if (vertical) advance = -(g.vmetric?.[0] ?? -(g.width ?? 0)) * widthAdvanceScale;
      else advance = (g.width ?? 0) * widthAdvanceScale;
      const text = typeof g.unicode === 'string' ? g.unicode : '';
      if (text && !/^[\u0000-\u001f\u007f-\u009f]+$/.test(text)) {
        if (vertical) {
          // A vertical glyph (WMode 1): one em across, centred on the pen, its advance downwards.
          const h = fontSize * 0.5, top = -x, bottom = -x - Math.max(advance, fontSize * 0.001);
          emitCorners(text, [[-h, top], [-h, bottom], [h, bottom], [h, top]]);
        } else emit(text, x, x + Math.max(advance, fontSize * 0.001), fontSize);
      }
      x += vertical ? advance - spacing * t.fontDirection : advance + spacing * t.fontDirection;
    }
    if (vertical) t.y -= x;
    else t.x += x * t.hScale * t.fontDirection;
  };

  const {fnArray, argsArray} = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i] ?? [];
    switch (fn) {
      case OPS.save: stack.push({ctm: ctm.slice(), t: {...t}, fill}); break;
      case OPS.restore: { const s = stack.pop(); if (s) { ctm = s.ctm; t = s.t; fill = s.fill; } break; }
      case OPS.setFillRGBColor: {
        // pdf.js hands the colour on as "#rrggbb" (any colour space is converted to RGB before it gets here).
        const hex = typeof args[0] === 'string' ? /^#([0-9a-f]{6})$/i.exec(args[0]) : null;
        fill = hex ? [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16) / 255) : args.length >= 3 ? [args[0] / 255, args[1] / 255, args[2] / 255] : fill;
        break;
      }
      case OPS.transform: ctm = mul(args.length >= 6 ? args.slice(0, 6) : Array.from(args[0] ?? IDENTITY), ctm); break;
      case OPS.paintFormXObjectBegin: {
        stack.push({ctm: ctm.slice(), t: {...t}, fill});
        const m = args[0];
        if (m && m.length >= 6) ctm = mul(Array.from(m), ctm);
        break;
      }
      case OPS.paintFormXObjectEnd: { const s = stack.pop(); if (s) { ctm = s.ctm; t = s.t; fill = s.fill; } break; }
      case OPS.beginText: t.textMatrix = IDENTITY; t.x = t.lineX = 0; t.y = t.lineY = 0; break;
      case OPS.setFont: {
        const font = fontOf(args[0]);
        let size = args[1] ?? 0;
        t.fontDirection = size < 0 ? -1 : 1;
        size = Math.abs(size);
        t.font = font;
        t.fontSize = size;
        t.fontMatrix = font?.fontMatrix ?? FONT_IDENTITY;
        break;
      }
      case OPS.setTextMatrix: {
        const m = args.length >= 6 ? args.slice(0, 6) : Array.from(args[0] ?? IDENTITY);
        t.textMatrix = m;
        t.x = t.lineX = 0; t.y = t.lineY = 0;
        break;
      }
      case OPS.moveText: t.lineX += args[0]; t.lineY += args[1]; t.x = t.lineX; t.y = t.lineY; break;
      case OPS.setLeadingMoveText: t.leading = args[1]; t.lineX += args[0]; t.lineY += args[1]; t.x = t.lineX; t.y = t.lineY; break;
      case OPS.nextLine: t.lineY += t.leading; t.x = t.lineX; t.y = t.lineY; break;
      case OPS.setLeading: t.leading = -args[0]; break;
      case OPS.setCharSpacing: t.charSpacing = args[0]; break;
      case OPS.setWordSpacing: t.wordSpacing = args[0]; break;
      case OPS.setHScale: t.hScale = args[0] / 100; break;
      case OPS.setTextRise: t.rise = args[0]; break;
      case OPS.showText: case OPS.showSpacedText: showText(args[0] ?? []); break;
      case OPS.nextLineShowText: t.lineY += t.leading; t.x = t.lineX; t.y = t.lineY; showText(args[0] ?? []); break;
      case OPS.nextLineSetSpacingShowText:
        t.lineY += t.leading; t.x = t.lineX; t.y = t.lineY; t.wordSpacing = args[0]; t.charSpacing = args[1]; showText(args[2] ?? []);
        break;
      default: break;
    }
  }
  return {glyphs, width: viewport.width, height: viewport.height, rotation: viewport.rotation};
}

/** The page's text with lines and word gaps (render/text.rs PageText) for the page shown at `rotation`. */
export async function extractPageText(pdfjs, page, opts) {
  const {glyphs, width, height, rotation} = await extractGlyphs(pdfjs, page, opts);
  const text = layoutPage(glyphs.map(glyph => ({quarter: quarterOf(glyph.direction), u: glyph.direction, glyph})), width, height);
  text.width = width;
  text.height = height;
  text.rotation = rotation;
  return text;
}
