// What editing text needs from a PDF font: how a string splits into character codes, each code's advance, the glyph height, what each
// code means (Unicode) and back, which text the font can still show.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/fonts/src/pdf.rs   Metrics (from_dict, read_metrics, codes, width, std14_code, is_space, text_of, has_glyph, shows, encode),
//                             the ToUnicode CMap reader (bfchar, bfrange), unicode_map (/Encoding base, /Differences, glyph names),
//                             style_from_name, descriptor flags, parse_cmap's codespace ranges
//   crates/edit/src/text/fallback.rs   source_encodes, source_space, source_width, source_show, source_family, same_base_font,
//                             strip_subset_tag
// Not translated (docs/spec/patches/folio/edit.json): the embedded program's glyph outlines (a subset's CIDs are taken to have a glyph
// when /W lists them), the Indic visual-order fonts, Type 3 and Japanese/Hebrew fallback faces, embedded CMaps' cid ranges beyond the
// identity (a font that maps its codes through one still shows and measures by code), per-glyph vertical metrics. No DOM, no Node built-ins.

import {PDFName, PDFNumber, PDFArray, PDFDict, PDFRef, PDFStream, PDFString, PDFHexString} from 'pdf-lib';
import {Encodings, Font, FontNames} from '@pdf-lib/standard-fonts';
import {decoded} from './edit-place.mjs';

const MAX_ENTRIES = 200_000;
const MAX_CMAP_BYTES = 8 * 1024 * 1024;

const stdCache = new Map();
/** The advance of one character in a standard face, per 1000 units (the published Core14 metrics). */
function stdWidth(baseFont, ch) {
  const n = stripSubsetTag(String(baseFont)).toLowerCase();
  const bold = /bold/.test(n), slant = /italic|oblique/.test(n);
  const key = /courier/.test(n) ? (bold ? (slant ? 'CourierBoldOblique' : 'CourierBold') : (slant ? 'CourierOblique' : 'Courier'))
    : /times/.test(n) ? (bold ? (slant ? 'TimesRomanBoldItalic' : 'TimesRomanBold') : (slant ? 'TimesRomanItalic' : 'TimesRoman'))
      : (bold ? (slant ? 'HelveticaBoldOblique' : 'HelveticaBold') : (slant ? 'HelveticaOblique' : 'Helvetica'));
  if (!stdCache.has(key)) stdCache.set(key, Font.load(FontNames[key]));
  const entry = Encodings.WinAnsi.unicodeMappings[ch.codePointAt(0)];
  if (!entry) return 0;
  try { return stdCache.get(key).getWidthOfGlyph(entry[1]) ?? 0; } catch { return 0; }
}

/** `ABCDEF+Arial` → `Arial` (strip_subset_tag). */
export function stripSubsetTag(name) {
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name;
}
/** same_base_font: a subset tag does not change the font; a name that is missing or only a tag names no font. */
export function sameBaseFont(a, b) {
  const [x, y] = [stripSubsetTag(a), stripSubsetTag(b)];
  return x !== '' && x === y;
}
/** style_from_name: bold and italic from the face's name. */
export function styleFromName(name) {
  const n = stripSubsetTag(name).toLowerCase();
  return {bold: /bold|black|heavy|semibold|demi/.test(n), italic: /italic|oblique/.test(n)};
}
/** source_family: the standard family a face stands in for. */
export function sourceFamily(baseFont) {
  const n = String(baseFont ?? '').toLowerCase();
  if (['courier', 'mono', 'consolas', 'menlo', 'monaco', 'lucida console'].some(s => n.includes(s))) return 'Courier';
  if (!n.includes('sans') && ['times', 'serif', 'roman', 'mincho', 'cambria', 'georgia', 'palatino', 'garamond'].some(s => n.includes(s))) return 'Times';
  return 'Helvetica';
}
/** Family.base_font: the standard face for a family, bold and italic. */
export function familyBaseFont(family, bold, italic) {
  if (family === 'Times') return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : 'Times-Roman');
  if (family === 'Courier') return bold ? (italic ? 'Courier-BoldOblique' : 'Courier-Bold') : (italic ? 'Courier-Oblique' : 'Courier');
  return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (italic ? 'Helvetica-Oblique' : 'Helvetica');
}

// ── encodings ──────────────────────────────────────────────────────────────────────────────────

const glyphToCp = new Map();
for (const [cp, [, name]] of Object.entries(Encodings.WinAnsi.unicodeMappings)) glyphToCp.set(name, Number(cp));
for (const [name, cp] of [['fi', 0xfb01], ['fl', 0xfb02], ['dotlessi', 0x131], ['Lslash', 0x141], ['lslash', 0x142], ['hyphen', 0x2d], ['nbspace', 0xa0], ['sfthyphen', 0xad],
  ['space', 0x20], ['mu', 0xb5], ['Delta', 0x394], ['Omega', 0x3a9], ['fraction', 0x2044], ['minus', 0x2212], ['circumflex', 0x2c6], ['tilde', 0x2dc], ['ff', 0xfb00], ['ffi', 0xfb03], ['ffl', 0xfb04]]) {
  if (!glyphToCp.has(name)) glyphToCp.set(name, cp);
}

/** glyph_text: a glyph name's text (AGL names the WinAnsi set covers, uniXXXX, uXXXX, `a_b` ligature names). */
export function glyphText(name) {
  if (!name || name === '.notdef') return null;
  const base = name.split('.')[0];
  if (!base) return null;
  const parts = base.split('_');
  let out = '';
  for (const part of parts) {
    let t = null;
    let m;
    if (glyphToCp.has(part)) t = String.fromCodePoint(glyphToCp.get(part));
    else if ((m = /^uni((?:[0-9A-F]{4})+)$/.exec(part))) t = m[1].match(/.{4}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
    else if ((m = /^u([0-9A-F]{4,6})$/.exec(part))) { const cp = parseInt(m[1], 16); t = cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : null; }
    else if (part.length === 1) t = part;
    if (t === null) return null;
    out += t;
  }
  return out;
}

let winTable = null, macTable = null;
const decodeByte = (label, b) => { try { return new TextDecoder(label).decode(Uint8Array.of(b)); } catch { return String.fromCharCode(b); } };
function table(label) {
  const out = new Map();
  for (let c = 0x20; c < 256; c++) { const t = decodeByte(label, c); if (t && t !== '�' && c !== 0x7f) out.set(c, t); }
  return out;
}
const STANDARD_UPPER = {
  0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤', 0xa9: "'", 0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'ﬁ', 0xaf: 'ﬂ',
  0xb1: '–', 0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿',
  0xc1: '`', 0xc2: '´', 0xc3: 'ˆ', 0xc4: '˜', 0xc5: '¯', 0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸', 0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ', 0xd0: '—',
  0xe1: 'Æ', 0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
};
function baseEncoding(name) {
  if (name === 'WinAnsiEncoding') return (winTable ??= table('windows-1252'));
  if (name === 'MacRomanEncoding') return (macTable ??= table('macintosh'));
  if (name === 'StandardEncoding') {
    const t = new Map();
    for (let c = 0x20; c < 0x7f; c++) t.set(c, String.fromCharCode(c));
    t.set(0x27, '’'); t.set(0x60, '‘');
    for (const [c, s] of Object.entries(STANDARD_UPPER)) t.set(Number(c), s);
    return t;
  }
  return null;
}

// ── objects ────────────────────────────────────────────────────────────────────────────────────

const N = s => PDFName.of(s);
const nameOf = v => (v instanceof PDFName ? v.decodeText() : undefined);
const numOf = v => (v instanceof PDFNumber ? v.asNumber() : undefined);
const hexBytes = s => { const out = []; for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16)); return out; };

/** UTF-16BE hex bytes as text. */
function utf16(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
  if (bytes.length % 2 === 1) s += String.fromCharCode(bytes[bytes.length - 1]);
  return s;
}

/** parse_to_unicode: bfchar and bfrange entries. */
function parseToUnicode(text, out) {
  let budget = MAX_ENTRIES;
  const hex = '<([0-9A-Fa-f\\s]*)>';
  const clean = s => s.replace(/\s+/g, '');
  const sections = /begin(bfchar|bfrange)([\s\S]*?)end\1/g;
  let m;
  while ((m = sections.exec(text))) {
    if (m[1] === 'bfchar') {
      const re = new RegExp(`${hex}\\s*${hex}`, 'g');
      let e;
      while ((e = re.exec(m[2])) && budget-- > 0) out.explicit.set(parseInt(clean(e[1]) || '0', 16), utf16(hexBytes(clean(e[2]))));
    } else {
      const re = new RegExp(`${hex}\\s*${hex}\\s*(?:${hex}|\\[([^\\]]*)\\])`, 'g');
      let e;
      while ((e = re.exec(m[2])) && budget-- > 0) {
        const lo = parseInt(clean(e[1]) || '0', 16), hi = parseInt(clean(e[2]) || '0', 16);
        if (hi < lo || hi - lo > 0xffff) continue;
        if (e[3] !== undefined) out.ranges.push({lo, hi, base: utf16(hexBytes(clean(e[3])))});
        else {
          const list = [...(e[4] ?? '').matchAll(/<([0-9A-Fa-f\s]*)>/g)].map(x => utf16(hexBytes(clean(x[1]))));
          for (let k = 0; k < list.length && lo + k <= hi && budget-- > 0; k++) out.explicit.set(lo + k, list[k]);
        }
      }
    }
  }
}

const rangeText = (r, code) => {
  const last = r.base.charCodeAt(r.base.length - 1) + (code - r.lo);
  return r.base.slice(0, -1) + String.fromCharCode(last & 0xffff);
};

/** Codespace ranges of an embedded CMap: [length, low bytes, high bytes]. */
function parseCodespace(text) {
  const out = [];
  const m = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let s;
  while ((s = m.exec(text))) {
    for (const e of s[1].matchAll(/<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>/g)) {
      const lo = hexBytes(e[1].replace(/\s+/g, '')), hi = hexBytes(e[2].replace(/\s+/g, ''));
      if (lo.length && lo.length === hi.length && lo.length <= 4) out.push([lo.length, lo, hi]);
    }
  }
  return out;
}

const be = bytes => bytes.reduce((v, b) => v * 256 + b, 0);

/** The reasons a font cannot be edited are carried on the metrics. */
export class Metrics {
  constructor() {
    this.composite = false;
    this.codespace = null;
    this.codeLen = 1;
    this.first = 0;
    this.widths = [];
    this.cidWidths = new Map();
    this.cidRanges = [];
    this.default = 500;
    this.explicitDefault = false;
    this.std14 = 'Helvetica';
    this.scale = 0.001;
    this.ascent = 0.9;
    this.descent = -0.25;
    this.baseFont = 'Helvetica';
    this.subset = false;
    this.bold = false;
    this.italic = false;
    this.vertical = null;
    this.type3 = false;
    this.unicode = {explicit: new Map(), ranges: [], encoding: new Map()};
    this.reverse = new Map();
    this.unreadable = null;
  }

  /** Metrics::fallback: Helvetica with ASCII. */
  static fallback() {
    const m = new Metrics();
    for (let c = 32; c < 127; c++) { m.unicode.encoding.set(c, String.fromCharCode(c)); m.reverse.set(String.fromCharCode(c), c); }
    return m;
  }

  /** Metrics::from_dict. `context` is the document's PDFContext, `font` the font dictionary. */
  static fromDict(context, font) {
    const m = new Metrics();
    m.std14 = null;
    const get = (d, k) => (d instanceof PDFDict ? context.lookup(d.get(N(k))) : undefined);
    const subtype = nameOf(get(font, 'Subtype')) ?? 'Type1';
    let descriptor;
    let toUnicode = null;
    const tu = get(font, 'ToUnicode');
    if (tu instanceof PDFStream) { try { const b = decoded(tu, MAX_CMAP_BYTES); toUnicode = new TextDecoder('latin1').decode(b); } catch { toUnicode = null; } }
    if (subtype === 'Type0') {
      m.composite = true;
      m.default = 1000;
      m.codeLen = 2;
      const enc = get(font, 'Encoding');
      if (enc instanceof PDFName) {
        const n = enc.decodeText();
        m.vertical = n.endsWith('-V') ? -1 : null;
      } else if (enc instanceof PDFStream) {
        let text = '';
        try { text = new TextDecoder('latin1').decode(decoded(enc, MAX_CMAP_BYTES)); } catch { m.unreadable = 'the text encoding cannot be decoded within its size limit'; }
        const spaces = parseCodespace(text);
        if (spaces.length) { m.codespace = spaces; m.codeLen = spaces[spaces.length - 1][0]; }
        const w = numOf(context.lookup(enc.dict.get(N('WMode'))));
        const wm = /\/WMode\s+(\d)\s+def/.exec(text);
        if (w === 1 || (wm && wm[1] === '1')) m.vertical = -1;
        else if (w !== undefined && w !== 0) m.unreadable = 'the text writing mode is invalid';
      }
      const dl = get(font, 'DescendantFonts');
      const desc = dl instanceof PDFArray ? context.lookup(dl.get(0)) : null;
      if (desc instanceof PDFDict) {
        const dw = numOf(get(desc, 'DW'));
        if (dw !== undefined) { m.default = dw; m.explicitDefault = true; }
        const w = get(desc, 'W');
        if (w instanceof PDFArray) {
          const items = w.asArray().map(x => context.lookup(x));
          for (let i = 0; i < items.length;) {
            const c0 = numOf(items[i]);
            if (c0 === undefined) break;
            const next = items[i + 1];
            if (next instanceof PDFArray) {
              next.asArray().forEach((x, k) => { const v = numOf(context.lookup(x)); if (v !== undefined && m.cidWidths.size < MAX_ENTRIES) m.cidWidths.set(c0 + k, v); });
              i += 2;
            } else {
              const c1 = numOf(next), v = numOf(items[i + 2]);
              if (c1 !== undefined && v !== undefined && m.cidRanges.length < MAX_ENTRIES) m.cidRanges.push([c0, c1, v]);
              i += 3;
            }
          }
        }
        const dw2 = get(desc, 'DW2');
        if (m.vertical !== null && dw2 instanceof PDFArray) { const w1 = numOf(context.lookup(dw2.get(1))); if (w1 !== undefined) m.vertical = w1 / 1000; else m.vertical = -1; }
        else if (m.vertical !== null) m.vertical = -1;
        descriptor = get(desc, 'FontDescriptor');
      }
    } else {
      m.first = Math.max(0, numOf(get(font, 'FirstChar')) ?? 0);
      const widths = get(font, 'Widths');
      descriptor = get(font, 'FontDescriptor');
      m.default = descriptor instanceof PDFDict ? numOf(get(descriptor, 'MissingWidth')) ?? 0 : 0;
      if (widths instanceof PDFArray) m.widths = widths.asArray().map(x => numOf(context.lookup(x)) ?? 0);
      if (subtype === 'Type3') {
        m.type3 = true;
        const fm = get(font, 'FontMatrix');
        if (fm instanceof PDFArray) m.scale = numOf(context.lookup(fm.get(0))) ?? 0.001;
      } else if (!m.widths.length) m.std14 = nameOf(get(font, 'BaseFont')) ?? 'Helvetica';
    }
    if (descriptor instanceof PDFDict) {
      const flags = numOf(get(descriptor, 'Flags')) ?? 0;
      const angle = numOf(get(descriptor, 'ItalicAngle')) ?? 0;
      const weight = numOf(get(descriptor, 'FontWeight')) ?? 0;
      m.italic ||= (flags & 64) !== 0 || Math.abs(angle) > 0.1;
      m.bold ||= (flags & 262144) !== 0 || weight >= 600;
      if (subtype !== 'Type3') {
        const a = (numOf(get(descriptor, 'Ascent')) ?? 0) / 1000;
        const d = (numOf(get(descriptor, 'Descent')) ?? 0) / 1000;
        m.ascent = a > 0.3 ? Math.min(a, 1.5) : 0.9;
        m.descent = d < -0.05 ? Math.max(d, -0.6) : -0.25;
      }
    }
    const base = nameOf(get(font, 'BaseFont')) ?? (subtype === 'Type3' && descriptor instanceof PDFDict ? nameOf(get(descriptor, 'FontName')) : undefined) ?? '';
    m.subset = /^[A-Z]{6}\+/.test(base);
    const st = styleFromName(base);
    m.bold ||= st.bold;
    m.italic ||= st.italic;
    m.baseFont = base;
    m.readUnicode(context, font, toUnicode, get);
    // Reverse: the lowest code showing each single character, where the font has a glyph for it.
    const rev = new Map();
    const keep = (ch, code) => { const prev = rev.get(ch); if (prev === undefined || code < prev) rev.set(ch, code); };
    for (const [code, text] of [...m.unicode.explicit, ...m.unicode.encoding]) {
      const cps = [...text];
      if (cps.length === 1 && m.shows(code, cps[0])) keep(cps[0], code);
    }
    for (const r of m.unicode.ranges) {
      if (r.hi - r.lo > 0xffff) continue;
      for (let code = r.lo; code <= r.hi; code++) {
        const t = rangeText(r, code);
        const cps = [...t];
        if (cps.length === 1 && m.shows(code, cps[0])) keep(cps[0], code);
      }
    }
    m.reverse = rev;
    return m;
  }

  readUnicode(context, font, toUnicode, get) {
    const u = this.unicode;
    if (toUnicode) parseToUnicode(toUnicode, u);
    if (this.composite) {
      // No ToUnicode on an Identity font: the codes mean nothing we know (an embedded program's cmap isn't read here).
      return;
    }
    const encObj = get(font, 'Encoding');
    let baseName;
    let differences = null;
    if (encObj instanceof PDFName) baseName = encObj.decodeText();
    else if (encObj instanceof PDFDict) {
      baseName = nameOf(context.lookup(encObj.get(N('BaseEncoding'))));
      const d = context.lookup(encObj.get(N('Differences')));
      if (d instanceof PDFArray) differences = d.asArray().map(x => context.lookup(x));
    }
    const symbolic = /^(Symbol|ZapfDingbats)/.test(stripSubsetTag(this.baseFont));
    const subtype = nameOf(get(font, 'Subtype'));
    let table = baseName ? baseEncoding(baseName) : null;
    if (!table && !symbolic) table = baseEncoding(subtype === 'TrueType' ? 'WinAnsiEncoding' : 'StandardEncoding');
    if (table) for (const [c, t] of table) u.encoding.set(c, t);
    if (differences) {
      let code = 0;
      for (const item of differences) {
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) {
          const t = glyphText(item.decodeText());
          if (t !== null) u.encoding.set(code, t); else u.encoding.delete(code);
          code++;
        }
      }
    }
  }

  codes(bytes) {
    const out = [];
    let i = 0;
    const spaces = this.codespace;
    while (i < bytes.length) {
      let len = this.composite ? (spaces ? spaces[0][0] : 2) : 1;
      if (spaces) {
        const hit = spaces.find(([l, lo, hi]) => i + l <= bytes.length && lo.every((low, k) => bytes[i + k] >= low && bytes[i + k] <= hi[k]));
        if (hit) len = hit[0];
      }
      len = Math.max(1, Math.min(len, bytes.length - i));
      out.push({code: be(bytes.subarray(i, i + len)), len});
      i += len;
    }
    return out;
  }

  /** The advance of `code` in text space per unit of font size. */
  width(code) {
    if (this.composite) {
      const w = this.cidWidths.get(code) ?? this.cidRanges.find(r => code >= r[0] && code <= r[1])?.[2];
      return (w ?? this.default) * this.scale;
    }
    const k = code - this.first;
    if (k >= 0 && k < this.widths.length) return this.widths[k] * this.scale;
    if (this.std14) {
      const t = this.unicode.encoding.get(code);
      const w = t && [...t].length === 1 ? stdWidth(this.std14, t) : 0;
      return w > 0 ? w / 1000 : this.default * this.scale;
    }
    return this.default * this.scale;
  }

  isSpace(code, len) { return code === 32 && len === 1; }

  textOf(code) {
    const u = this.unicode;
    const e = u.explicit.get(code);
    if (e !== undefined) return e;
    for (let i = u.ranges.length - 1; i >= 0; i--) { const r = u.ranges[i]; if (code >= r.lo && code <= r.hi) return rangeText(r, code); }
    return u.encoding.get(code) ?? null;
  }

  /** Whether the font has a glyph for `code`. */
  hasGlyph(code) {
    if (this.composite) {
      if (code === 0) return false;
      return this.cidWidths.has(code) || this.cidRanges.some(r => code >= r[0] && code <= r[1]) || !this.subset || this.explicitDefault;
    }
    const k = code - this.first;
    if (k >= 0 && k < this.widths.length) return this.widths[k] > 0 || code === 32;
    return this.widths.length === 0 && !this.subset;
  }

  shows(code, ch) {
    const t = this.textOf(code);
    return t !== null && [...t].length === 1 && t === ch && this.hasGlyph(code);
  }

  /** The bytes that show `text`, or null when some character has no code or glyph in this font. */
  encode(text) {
    if (this.type3) return null;
    const out = [];
    const len = Math.min(4, Math.max(1, this.codeLen));
    for (const ch of text) {
      const code = this.reverse.get(ch);
      if (code === undefined) return null;
      for (let k = len - 1; k >= 0; k--) out.push(Math.floor(code / 256 ** k) & 0xff);
    }
    return Uint8Array.from(out);
  }

  /** source_encodes: the words encode (a subset may lack a space glyph; spaces are positioned instead). */
  encodes(text) {
    return text.split(' ').every(w => this.encode(w) !== null);
  }

  /** source_space: the advance of the space, or 0.33 em when the font has none. */
  space() {
    const b = this.encode(' ');
    if (b) return this.codes(b).reduce((s, c) => s + this.width(c.code), 0);
    return 0.33;
  }

  /** source_width: the advance of `text` at `size`, in text space. */
  textWidth(text, size, space, charSpacing, wordSpacing) {
    const b = this.encode(text);
    if (b) return this.codes(b).reduce((s, c) => s + this.width(c.code) * size + charSpacing + (this.isSpace(c.code, c.len) ? wordSpacing : 0), 0);
    let words = 0;
    for (const w of text.split(' ')) {
      const wb = this.encode(w);
      if (wb) words += this.codes(wb).reduce((s, c) => s + this.width(c.code) * size + charSpacing, 0);
    }
    return words + (text.split(' ').length - 1) * (space * size + charSpacing + wordSpacing);
  }
}

/** The font dictionary a resource name selects (or null). */
export function fontDictOf(context, resources, name) {
  if (!(resources instanceof PDFDict)) return null;
  const fonts = context.lookup(resources.get(N('Font')));
  if (!(fonts instanceof PDFDict)) return null;
  const f = context.lookup(fonts.get(N(name)));
  return f instanceof PDFDict ? f : null;
}

export {PDFRef, PDFString, PDFHexString};

/** The advance of `text` in a standard face at `size` (WinAnsi characters; others count as the question mark). */
export function stdTextWidth(baseFont, text, size) {
  let w = 0;
  for (const ch of text) w += stdWidth(baseFont, ch) || stdWidth(baseFont, '?');
  return (w * size) / 1000;
}
