// The person's own text in any script: when a text holds a character the standard faces cannot draw (Cyrillic, Greek beyond the standard set, Devanagari, Arabic, Hebrew, Thai,
// Chinese, Japanese, Korean...), the PDF being written gets the shared Unicode helper (core/common/lib/pdf-fonts.mjs: a system font subset-embedded through fontkit, a fallback font
// per run). Text the standard faces can draw keeps them, so a Western European document is written exactly as before. A character no installed font has still prints as "?".
//
// Shaping: the text is not set one character at a time. It is cut into runs by the Unicode bidirectional algorithm (lib/shape-text.mjs: Arabic and Hebrew read right to left, the
// Latin words and numbers among them left to right), the runs go in the order they are read, and each run gets its glyphs from fontkit's OpenType layout (`font.layout`: GSUB for
// the joining forms of Arabic, ligatures, Devanagari conjuncts and vowel signs, GPOS for kerning and for where the marks of Arabic, Thai and Devanagari sit). The glyph codes go out
// in Tj/TJ operators with the kerning as TJ adjustments and a mark's offset as a TJ shift and a text rise (Ts), so the page is drawn the way the layout engine placed it.
// No DOM, no Node built-ins (the helper reaches the file system through a dynamic import a host without one lacks).

import {pushGraphicsState, popGraphicsState, beginText, endText, setFillingColor, setFontAndSize, setTextRise, setTextMatrix, showText, PDFOperator, PDFOperatorNames, PDFHexString, PDFNumber} from 'pdf-lib';
import {systemFonts} from '../../common/lib/pdf-fonts.mjs';
import {firstUndrawable} from './fonts.mjs';
import {visualRuns} from './shape-text.mjs';

/** Scripts a layout engine has to shape (they join, reorder or place marks): Hebrew, Arabic, Thai. */
const SHAPED = /[֐-ࣿ฀-๿יִ-﷿ﹰ-﻿]/;
const CONTROL = /[\r\n\t]+/g;

/** Whether a text needs more than the standard faces. */
export const needsUnicode = text => firstUndrawable(String(text ?? '')) !== null;
/** Whether a text is in a script that is set right to left or that places marks around its letters (Arabic, Hebrew, Thai). */
export const needsShaping = text => SHAPED.test(String(text ?? ''));

const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;

/**
 * A run's glyphs as the layout engine placed them: [{code, id, adv, base, xo, yo}] in 1/1000 em, where `adv` is the advance the layout wants (kerning included), `base` the advance
 * the PDF's width table gives the glyph, `xo` and `yo` the offset the glyph is drawn at, and `code` the glyph's code in the embedded subset.
 */
function glyphsOf(run) {
  if (!run.font) return null;
  const lay = run.font.layout(run.text);
  const codes = run.pdfFont.encodeText(run.text).toString().slice(1, -1).match(/.{4}/g) ?? [];
  if (codes.length !== lay.glyphs.length) return null;
  const k = 1000 / run.font.unitsPerEm;
  return lay.glyphs.map((g, i) => { const p = lay.positions[i]; return {code: codes[i], id: g.id, adv: p.xAdvance * k, base: g.advanceWidth * k, xo: p.xOffset * k, yo: p.yOffset * k}; });
}

/**
 * The Tj/TJ pieces of a plan item: [{rise, parts}] where `parts` alternate hex strings and numbers (a number moves the pen right by its negative thousandth of the size, as in TJ).
 * A glyph with an offset is moved before it is drawn and the pen brought back after it; a glyph whose advance differs from the PDF's width gets the difference.
 */
function pieces(item) {
  const out = [];
  let cur = null;
  const num = x => { const p = cur.parts; if (Math.abs(x) < 0.005) return; if (typeof p[p.length - 1] === 'number') p[p.length - 1] += x; else p.push(x); };
  for (const g of item.glyphs) {
    const rise = r2(g.yo);
    if (!cur || cur.rise !== rise) { cur = {rise, parts: []}; out.push(cur); }
    if (g.xo) num(-g.xo);
    const p = cur.parts;
    if (typeof p[p.length - 1] === 'string') p[p.length - 1] += g.code; else p.push(g.code);
    num(-(g.adv - g.xo - g.base));
  }
  return out;
}

/** The content stream operators that set one plan item at `size`. */
function itemOps(item, size) {
  let out = `/${item.name} ${r3(size)} Tf `;
  if (!item.glyphs) return `${out}${item.hex} Tj\n`;
  let rise = 0;
  for (const piece of pieces(item)) {
    if (piece.rise !== rise) { rise = piece.rise; out += `${r3(rise * size / 1000)} Ts `; }
    const p = piece.parts;
    out += p.length === 1 && typeof p[0] === 'string' ? `<${p[0]}> Tj\n` : `[${p.map(x => (typeof x === 'string' ? `<${x}>` : r2(x))).join(' ')}] TJ\n`;
  }
  if (rise) out += '0 Ts\n';
  return out;
}

/**
 * The Unicode text set for `pdf`, made ready for `texts`: null when no text needs it. `face(style)` is the helper's face; `runs(text, style)` gives the pieces in reading order of
 * the characters, as {name, ref, hex, text, width(size)}; `plan(text, style)` the shaped pieces in the order they are drawn on the page, as {name, ref, text, glyphs, width(size)}.
 */
export async function unicodeFor(pdf, texts) {
  const list = [...texts].map(t => String(t ?? '')).filter(needsUnicode);
  if (!list.length) return null;
  const set = await systemFonts(pdf);
  await set.prepare(list);
  const names = new Map();
  const nameOf = pdfFont => { if (!names.has(pdfFont)) names.set(pdfFont, `PCU${names.size + 1}`); return names.get(pdfFont); };
  const faces = new Map();
  const face = (style = {}) => { const k = `${style.bold ? 1 : 0}${style.italic ? 1 : 0}`; if (!faces.has(k)) faces.set(k, set.face(style)); return faces.get(k); };
  const runs = (text, style = {}) => face(style).runs(text).map(r => ({name: nameOf(r.pdfFont), ref: r.pdfFont.ref, pdfFont: r.pdfFont, text: r.text, hex: r.pdfFont.encodeText(r.text).toString(), width: size => r.pdfFont.widthOfTextAtSize(r.text, size)}));
  const memo = new Map();
  const plan = (text, style = {}) => {
    const key = `${style.bold ? 1 : 0}${style.italic ? 1 : 0}|${text}`;
    if (memo.has(key)) return memo.get(key);
    const out = [];
    const fc = face(style);
    for (const part of visualRuns(String(text ?? '').replace(CONTROL, ' '))) {
      let rs = fc.runs(part.text);
      if (part.reversed) rs = rs.slice().reverse();
      for (const r of rs) {
        const glyphs = glyphsOf(r);
        const item = {name: nameOf(r.pdfFont), ref: r.pdfFont.ref, pdfFont: r.pdfFont, text: r.text, glyphs, rtl: part.rtl};
        if (glyphs) item.width = size => glyphs.reduce((w, g) => w + g.adv, 0) * size / 1000;
        else { item.hex = r.pdfFont.encodeText(r.text).toString(); item.width = size => r.pdfFont.widthOfTextAtSize(r.text, size); }
        out.push(item);
      }
    }
    if (memo.size > 5000) memo.clear();
    memo.set(key, out);
    return out;
  };
  return {
    face, runs, plan, fonts: () => [...names.entries()].map(([pdfFont, name]) => ({name, ref: pdfFont.ref})),
    width: (text, size, style = {}) => plan(text, style).reduce((w, it) => w + it.width(size), 0),
    /** Whether every character of the text prints as itself (not "?"). */
    canDraw: (text, style = {}) => { const s = String(text ?? ''); return (face(style).clean(s).split('?').length - 1) === (s.split('?').length - 1); },
    /** Content stream operators setting `text` at the current text position, shaped and in reading order: `/PCU1 12 Tf [<...> -12 <...>] TJ` for each run (the position advances by itself). */
    ops: (text, size, style = {}) => plan(text, style).map(it => itemOps(it, size)).join(''),
  };
}

/**
 * The lines of `text` wrapped to `width` points with `measure(line)`: words are kept whole where they fit, and a word wider than the line (or text with no spaces, such as
 * Chinese or Japanese) breaks between characters. Every \n starts a paragraph.
 */
export function wrapLines(text, width, measure) {
  const out = [];
  for (const para of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (!para.length) { out.push(''); continue; }
    let line = '';
    const flush = () => { out.push(line.replace(/ +$/, '')); line = ''; };
    for (const word of para.split(/(?<= )/)) {
      if (measure(line + word) <= width) { line += word; continue; }
      if (line) flush();
      let rest = word;
      while (measure(rest) > width && [...rest].length > 1) {
        const chars = [...rest];
        let k = chars.length;
        while (k > 1 && measure(chars.slice(0, k).join('')) > width) k--;
        out.push(chars.slice(0, k).join(''));
        rest = chars.slice(k).join('');
      }
      line = rest;
    }
    flush();
  }
  return out;
}

/**
 * Draw shaped text on a pdf-lib page with the plan's operators: `options` are drawText's (x, y, size, color, rotate in degrees or radians).
 */
function drawPlan(page, uni, text, options = {}, style = {}) {
  const size = options.size ?? 12;
  const rot = options.rotate;
  const th = rot ? (rot.angle ?? 0) * (rot.type === 'radians' ? 1 : Math.PI / 180) : 0;
  const c = Math.cos(th), s = Math.sin(th);
  const ops = [pushGraphicsState()];
  if (options.color) ops.push(setFillingColor(options.color));
  ops.push(beginText(), setTextMatrix(c, s, -s, c, options.x ?? 0, options.y ?? 0));
  const context = page.doc.context;
  for (const item of uni.plan(text, style)) {
    const key = page.node.newFontDictionary(item.name, item.ref);
    ops.push(setFontAndSize(key, size));
    if (!item.glyphs) { ops.push(showText(PDFHexString.of(item.hex.slice(1, -1)))); continue; }
    let rise = 0;
    for (const piece of pieces(item)) {
      if (piece.rise !== rise) { rise = piece.rise; ops.push(setTextRise(rise * size / 1000)); }
      const parts = piece.parts.map(x => (typeof x === 'string' ? PDFHexString.of(x) : PDFNumber.of(r2(x))));
      ops.push(parts.length === 1 && typeof piece.parts[0] === 'string' ? showText(parts[0]) : PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [context.obj(parts)]));
    }
    if (rise) ops.push(setTextRise(0));
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

/**
 * A face for text a PDF-writing function sets with pdf-lib's drawText: the standard `font` where every character is drawable (a Western European document is written as
 * before), else the Unicode helper's face for `texts`. `{width(text, size), draw(page, text, options), unicode}`.
 */
export async function textFace(pdf, font, texts, style = {}) {
  const list = [...texts].map(t => String(t ?? ''));
  const uni = list.some(needsUnicode) ? await unicodeFor(pdf, list) : null;
  if (!uni) return {unicode: false, width: (t, size) => font.widthOfTextAtSize(String(t), size), draw: (page, t, o = {}) => page.drawText(String(t), {...o, font})};
  return {unicode: true, width: (t, size) => uni.width(String(t), size, style), draw: (page, t, o = {}) => drawPlan(page, uni, String(t), o, style)};
}

/**
 * The one pdf-lib font a form field is filled with: the standard `font` where every text is drawable, else the Unicode helper's font for the first script of the texts (a field
 * has one font, so a character of another script that font lacks prints as "?").
 */
export async function formFont(pdf, font, texts) { return (await formFontSet(pdf, font, texts)).font; }

/**
 * formFont and the Unicode text set behind it (null when every text is drawable by the standard `font`): `uni.canDraw(text)` says whether a font the helper finds has every
 * character, which is what a form value or a choice option must pass to be accepted.
 */
export async function formFontSet(pdf, font, texts) {
  const list = [...texts].map(t => String(t ?? ''));
  if (!list.some(needsUnicode)) return {font, uni: null};
  const uni = await unicodeFor(pdf, list);
  return {font: list.filter(needsUnicode).map(t => uni.runs(t)[0]?.pdfFont).find(Boolean) ?? font, uni};
}
