// The page view's text in any script. The saved file draws a comment's text (free text, a stamp's By line, a line's caption, a measurement label) with a system font embedded at
// write time (lib/unicode-text.mjs); the view draws the same appearance on a canvas, where the browser's own fonts are the fonts and the browser's own text engine shapes and orders
// the glyphs (joining, conjuncts, right to left). This is the text set the appearance builder (model/appearance.mjs `withUnicode`) takes in place of the file's: the same four
// members (`canDraw`, `width`, `ops`, `fonts`), measuring with the browser, and writing the text as a UTF-16 string shown with a pseudo font (`/PCBr`, `/PCBrB`...) that
// lib/content-paint.mjs paints with `fillText`. Nothing here is saved: the file never sees these operators.
// No DOM: the caller gives the function that measures text on a canvas.

import {isRtlParagraph} from './shape-text.mjs';

/** The families the saved file's fonts come from, in the order the helper tries them (the browser falls back glyph by glyph for what the first lacks). */
export const BROWSER_FAMILY = '"Segoe UI", Arial, "DejaVu Sans", "Noto Sans", "Nirmala UI", "Leelawadee UI", Tahoma, "Microsoft YaHei", "Yu Gothic", "Malgun Gothic", "Hiragino Sans", "Apple SD Gothic Neo", sans-serif';

/** The CSS font of a style at a size in pixels. */
export const browserCss = ({bold = false, italic = false} = {}, size = 12) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${BROWSER_FAMILY}`;

/** A pseudo font's text as shown: the UTF-16BE string of a Tj (one byte per character) back to text. */
export function decodeUtf16(bytes) {
  let s = '';
  for (let k = 0; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes.charCodeAt(k) << 8) | bytes.charCodeAt(k + 1));
  return s;
}

/** The direction a canvas draws a text in: the paragraph direction of its first strong character, as the saved file's text is ordered. */
export const directionOf = text => (isRtlParagraph(text) ? 'rtl' : 'ltr');

const CONTROL = /[\r\n\t]+/g;
const r3 = x => Math.round(x * 1000) / 1000;
const hex4 = n => n.toString(16).padStart(4, '0');

/**
 * The text set for the view. `measure(text, size, style)` is the width in pixels of `text` at `size` in `browserCss(style, size)` (a canvas context's measureText).
 * `fonts()` lists the pseudo fonts the text written so far uses, as {name, ref} where `ref` is the font object the painter reads (it holds `PCBrowser: {bold, italic}`).
 */
export function browserText(measure) {
  const used = new Map();
  const nameOf = ({bold = false, italic = false} = {}) => {
    const name = `PCBr${bold ? 'B' : ''}${italic ? 'I' : ''}`;
    if (!used.has(name)) used.set(name, {Type: '/Font', Subtype: '/Type0', BaseFont: '/PCBrowser', PCBrowser: {bold: !!bold, italic: !!italic}});
    return name;
  };
  const clean = text => String(text ?? '').replace(CONTROL, ' ');
  return {
    fonts: () => [...used].map(([name, ref]) => ({name, ref})),
    width: (text, size, style = {}) => measure(clean(text), size, style),
    canDraw: text => String(text ?? '').length > 0,
    ops: (text, size, style = {}) => `/${nameOf(style)} ${r3(size)} Tf <${[...clean(text)].map(c => { const cp = c.codePointAt(0); return cp > 0xFFFF ? hex4(0xD800 + ((cp - 0x10000) >> 10)) + hex4(0xDC00 + ((cp - 0x10000) & 0x3FF)) : hex4(cp); }).join('')}> Tj\n`,
  };
}
