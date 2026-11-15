// Standard-font text measuring and encoding for generated appearances.
//
// Translated from printcraft crates/fonts/src/lib.rs (helvetica_width, wrap, wrap_with,
// win_ansi_byte, win_ansi, literal, first_undrawable, undrawable_message) and
// crates/annot/src/modify.rs (`n`, the number format of content streams and DA strings) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Helvetica's advance widths come from the published Core14 metrics, which pdf-lib ships
// (@pdf-lib/standard-fonts, the same table upstream's std14_metrics.rs types in).
// No DOM, no Node built-ins.

import {Font, FontNames, Encodings} from '@pdf-lib/standard-fonts';

let helvetica = null, helveticaBold = null;
const winAnsi = Encodings.WinAnsi;

/** modify.rs `n`: a number for content streams, at most three decimals, no trailing zeros. */
export function n(v) {
  let s = (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** fonts `win_ansi_byte`: the WinAnsiEncoding code of a character, or null. */
export function winAnsiByte(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  if (!winAnsi.canEncodeUnicodeCodePoint(cp)) return null;
  const {code} = winAnsi.encodeUnicodeCodePoint(cp);
  return code >= 0x80 && code < 0xa0 ? code : null;
}

/** fonts `win_ansi`: tabs become spaces, characters it can't encode become `?`. */
export function winAnsiBytes(s) {
  const out = [];
  for (const ch of s) out.push(ch === '\t' ? 0x20 : winAnsiByte(ch) ?? 0x3f);
  return out;
}

/** fonts `first_undrawable`: the first character the standard fonts can't draw (line breaks don't count). */
export function firstUndrawable(s) {
  for (const ch of String(s ?? '')) if (ch !== '\n' && ch !== '\r' && ch !== '\t' && winAnsiByte(ch) === null) return ch;
  return null;
}

/** fonts `undrawable_message`. */
export function undrawableMessage(what, ch) {
  const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  return `the standard fonts can't draw "${ch}" (U+${hex}) in ${what}; only Western European characters can be written there for now`;
}

/** fonts `literal`: bytes as a PDF literal string, delimiters escaped (returned as a binary string). */
export function literal(bytes) {
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x0a) s += '\\n';
    else s += String.fromCharCode(b);
  }
  return s + ')';
}

let glyphNames = null;
/** WinAnsiEncoding code → glyph name (the reverse of the encoding's Unicode mappings). */
function glyphName(code) {
  if (!glyphNames) {
    glyphNames = new Map();
    for (const [, [c, glyph]] of Object.entries(winAnsi.unicodeMappings)) if (!glyphNames.has(c)) glyphNames.set(c, glyph);
  }
  return glyphNames.get(code) ?? 'question';
}

function widthOf(font, code) {
  const glyph = glyphName(code);
  try { return font.getWidthOfGlyph(glyph) ?? 0; } catch { return 0; }
}

/** std14 `Std14::Helvetica.text_width` (fonts `helvetica_width`): sum of WinAnsi advances × size / 1000. */
export function textWidth(s, size, bold = false) {
  const font = bold ? (helveticaBold ??= Font.load(FontNames.HelveticaBold)) : (helvetica ??= Font.load(FontNames.Helvetica));
  let w = 0;
  for (const code of winAnsiBytes(String(s))) w += widthOf(font, code);
  return (w * size) / 1000;
}

/** fonts `wrap` / `wrap_with`: break text into lines no wider than `width` at `size`. */
export function wrap(text, size, width, measure = textWidth) {
  const lines = [];
  const space = measure(' ', size);
  for (const para of String(text).replace(/\r\n/g, '\n').split(/[\n\r]/)) {
    let line = '', lineWidth = 0, fresh = true;
    for (const word of para.split(' ')) {
      const wordWidth = measure(word, size);
      const candidate = fresh ? wordWidth : lineWidth + space + wordWidth;
      if (candidate <= width) {
        if (!fresh) line += ' ';
        line += word;
        lineWidth = candidate;
        fresh = false;
        continue;
      }
      if (!line.trim()) line = '';
      else { lines.push(line); line = ''; }
      lineWidth = 0;
      for (const ch of word) {
        const chWidth = measure(ch, size);
        if (line && lineWidth + chWidth > width) { lines.push(line); line = ''; lineWidth = 0; }
        line += ch;
        lineWidth += chWidth;
      }
      fresh = !line;
    }
    lines.push(line);
  }
  return lines;
}

/** pdfcraft_fonts::UNDRAWN_MARK. */
export const UNDRAWN_MARK = 'PCUndrawn';

const standard = new Map();
/** The standard-14 font a form resource name (Helv, TiRo, Cour, HeBo...) or BaseFont stands for. */
export function standardFontOf(name) {
  const n = String(name ?? '');
  if (/^(TiRo|Times-Roman)$/.test(n)) return FontNames.TimesRoman;
  if (/^(TiBo|Times-Bold)$/.test(n)) return FontNames.TimesRomanBold;
  if (/^(Cour|Courier)$/.test(n)) return FontNames.Courier;
  if (/^(CoBo|Courier-Bold)$/.test(n)) return FontNames.CourierBold;
  if (/^(HeBo|Helvetica-Bold)$/.test(n)) return FontNames.HelveticaBold;
  return FontNames.Helvetica;
}
/** The advance of a string in a standard font (a form resource name or BaseFont) at `size`. */
export function fontWidth(name, s, size) {
  const base = standardFontOf(name);
  if (base === FontNames.Helvetica) return textWidth(s, size);
  if (!standard.has(base)) standard.set(base, Font.load(base));
  const font = standard.get(base);
  let w = 0;
  for (const code of winAnsiBytes(String(s))) w += widthOf(font, code);
  return (w * size) / 1000;
}
