// Line break opportunities: UAX #14 with Word's adjustments, and kinsoku.
//
// Translated from wordcraft crates/layout/src/para/paragraph.rs (`break_positions`) and
// crates/layout/src/kinsoku.rs (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c).
// Upstream takes UAX #14 from the `unicode-linebreak` crate; `uax14` below implements the pair
// rules (LB4-LB31) for the line-break classes Word documents use. Offsets are UTF-16 units.
import {myanmarBreaks} from '../../model/text.mjs';

// Kinsoku: characters that may not start or end a line (kinsoku.rs NO_START / NO_END).
const NO_START = new Set([...'、。，．・：；？！゛゜ヽヾゝゞ々〻〉》」』】〕〗〙〛〞〟）］｝｠｡｣､･ﾞﾟ％￠']);
const NO_END = new Set([...'〈《「『【〔〖〘〚〝（［｛｟｢＄￡￥']);

/** East Asian text (kinsoku.rs is_east_asian). */
export function isEastAsian(c) {
  return (c >= 0x2e80 && c <= 0x2fff) || (c >= 0x3001 && c <= 0x303f) || (c >= 0x3040 && c <= 0x3098) || (c >= 0x309b && c <= 0x30ff)
    || (c >= 0x3100 && c <= 0x312f) || (c >= 0x3190 && c <= 0x31ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff01 && c <= 0xffef) || (c >= 0x20000 && c <= 0x3ffff);
}
const isHangul = c => (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f) || (c >= 0xa960 && c <= 0xa97f) || (c >= 0xac00 && c <= 0xd7ff)
  || (c >= 0xffa0 && c <= 0xffdc);
const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const ALPHA = /\p{Alphabetic}/u;
const isAlnum = c => ALNUM.test(String.fromCodePoint(c));
const isAlpha = c => ALPHA.test(String.fromCodePoint(c));

/** Which side of `a`|`b` gets Word's automatic space between Asian and Latin text (kinsoku.rs auto_space). */
export function autoSpace(a, b, de, dn) {
  const isAsianText = c => isEastAsian(c) && isAlnum(c) && !isHangul(c);
  const isLatinLetter = c => isAlpha(c) && !isEastAsian(c) && !isHangul(c);
  const spaced = o => (de && isLatinLetter(o)) || (dn && o >= 0x30 && o <= 0x39);
  if (isAsianText(a) && spaced(b)) return 'left';
  if (isAsianText(b) && spaced(a)) return 'right';
  return null;
}

/** The UAX #14 line-break class of `c`, for the classes the pair rules below tell apart. */
export function lbClass(c) {
  if (c < 0x80) {
    if (c === 0x0a) return 'LF';
    if (c === 0x0d) return 'CR';
    if (c === 0x0b || c === 0x0c) return 'BK';
    if (c === 0x09) return 'BA';
    if (c === 0x20) return 'SP';
    if (c < 0x20 || c === 0x7f) return 'CM';
    if (c >= 0x30 && c <= 0x39) return 'NU';
    switch (c) {
      case 0x21: case 0x3f: return 'EX';
      case 0x22: case 0x27: return 'QU';
      case 0x23: case 0x26: case 0x2a: case 0x3c: case 0x3d: case 0x3e: case 0x40: case 0x5e: case 0x5f: case 0x60: case 0x7e: return 'AL';
      case 0x24: case 0x2b: case 0x5c: return 'PR';
      case 0x25: return 'PO';
      case 0x28: case 0x5b: case 0x7b: return 'OP';
      case 0x29: case 0x5d: return 'CP';
      case 0x7d: return 'CL';
      case 0x2c: case 0x2e: case 0x3a: case 0x3b: return 'IS';
      case 0x2d: return 'HY';
      case 0x2f: return 'SY';
      case 0x7c: return 'BA';
      default: return 'AL';
    }
  }
  switch (c) {
    case 0x0085: return 'NL';
    case 0x00a0: case 0x2007: case 0x202f: case 0x2011: case 0x0f0c: case 0x180e: case 0x034f: return 'GL';
    case 0x00ad: case 0x2010: case 0x2012: case 0x2013: case 0x058a: case 0x1680: case 0x2000: case 0x2001: case 0x2002: case 0x2003: case 0x2004:
    case 0x2005: case 0x2006: case 0x2008: case 0x2009: case 0x200a: case 0x205f: case 0x2027: case 0x2056: case 0x2058: case 0x2059:
    case 0x205a: case 0x205b: case 0x205d: case 0x205e: case 0x2e0e: case 0x2e0f: case 0x2e10: case 0x2e11: case 0x2e12: case 0x2e13:
    case 0x2e14: case 0x2e15: case 0x2e17: case 0x2e19: case 0x2e2a: case 0x2e2b: case 0x2e2c: case 0x2e2d: case 0x2e30: case 0x2e31:
    case 0x2e33: case 0x2e34: case 0x2e3c: case 0x2e3d: case 0x2e3e: case 0x2e40: case 0x2e41: case 0x2e43: case 0x2e44: case 0x2e45:
    case 0x2e46: case 0x2e47: case 0x2e48: case 0x2e49: case 0x2e4a: case 0x2e4c: case 0x2e4e: case 0x2e4f: case 0x2e5d:
      return 'BA';
    case 0x2014: return 'B2';
    case 0x200b: return 'ZW';
    case 0x200d: return 'ZWJ';
    case 0x2060: case 0xfeff: return 'WJ';
    case 0x2028: case 0x2029: return 'BK';
    case 0x2024: case 0x2025: case 0x2026: case 0xfe19: return 'IN';
    case 0x2018: case 0x2019: case 0x201b: case 0x201c: case 0x201d: case 0x201f: case 0x00ab: case 0x00bb: case 0x2039: case 0x203a: return 'QU';
    case 0x201a: case 0x201e: case 0x2045: case 0x207d: case 0x208d: case 0x2329: case 0x27e8: case 0x2983: return 'OP';
    case 0x2046: case 0x207e: case 0x208e: case 0x232a: case 0x27e9: case 0x2984: return 'CL';
    case 0x00a2: case 0x00b0: case 0x2030: case 0x2031: case 0x2032: case 0x2033: case 0x2103: case 0x2109: case 0xffe0: case 0x066a: return 'PO';
    case 0x00a3: case 0x00a4: case 0x00a5: case 0x00b1: case 0x20ac: case 0x2116: case 0x2212: case 0x2213: case 0xffe1: case 0xffe5: case 0xffe6: return 'PR';
    case 0x00b4: case 0x02c8: case 0x02cc: case 0x02df: return 'BB';
    case 0x3000: return 'BA';
    case 0xfffc: return 'CB';
    default: break;
  }
  if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x0483 && c <= 0x0489) || (c >= 0x0591 && c <= 0x05bd) || (c >= 0x0610 && c <= 0x061a)
    || (c >= 0x064b && c <= 0x065f) || c === 0x0670 || (c >= 0x06d6 && c <= 0x06ed) || (c >= 0x0900 && c <= 0x0903) || (c >= 0x093a && c <= 0x094f)
    || (c >= 0x0951 && c <= 0x0957) || (c >= 0x0962 && c <= 0x0963) || (c >= 0x1ab0 && c <= 0x1aff) || (c >= 0x1dc0 && c <= 0x1dff)
    || (c >= 0x20d0 && c <= 0x20f0) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xfe20 && c <= 0xfe2f) || c === 0x200c || (c >= 0xe0100 && c <= 0xe01ef)) return 'CM';
  if (c >= 0x0660 && c <= 0x0669) return 'NU';
  if (c >= 0x06f0 && c <= 0x06f9) return 'NU';
  if (c >= 0x0966 && c <= 0x096f) return 'NU';
  if (c >= 0xff10 && c <= 0xff19) return 'ID';
  // CJK punctuation: closing and non-starters, opening.
  if ('、。，．｡､'.includes(String.fromCodePoint(c))) return 'CL';
  if ('〉》」』】〕〗〙〛〞〟）］｝｠｣'.includes(String.fromCodePoint(c))) return 'CL';
  if ('〈《「『【〔〖〘〚〝（［｛｟｢'.includes(String.fromCodePoint(c))) return 'OP';
  if ('・：；'.includes(String.fromCodePoint(c))) return 'NS';
  if ('！？'.includes(String.fromCodePoint(c))) return 'EX';
  if ('ヽヾゝゞ々〻゛゜ー〜ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿｧｨｩｪｫｬｭｮｯｰﾞﾟ'.includes(String.fromCodePoint(c))) return 'NS';
  if (c >= 0x1100 && c <= 0x115f) return 'JL';
  if (c >= 0x1160 && c <= 0x11a7) return 'JV';
  if (c >= 0x11a8 && c <= 0x11ff) return 'JT';
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? 'H2' : 'H3';
  if ((c >= 0x2e80 && c <= 0x2fff) || (c >= 0x3001 && c <= 0x303f) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3100 && c <= 0x31ff)
    || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa000 && c <= 0xa4cf) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff01 && c <= 0xff60) || (c >= 0x20000 && c <= 0x3fffd) || (c >= 0x1f000 && c <= 0x1faff)) return 'ID';
  if (c >= 0x1f1e6 && c <= 0x1f1ff) return 'RI';
  if ((c >= 0x0e00 && c <= 0x0eff) || (c >= 0x1000 && c <= 0x109f) || (c >= 0x1780 && c <= 0x17ff) || (c >= 0x1950 && c <= 0x19df)) return 'SA';
  return 'AL';
}

/**
 * Break opportunities of `text` (UAX #14 pair rules): offsets i where a line may break before
 * text[i], 0 < i <= length, mandatory breaks included, as `unicode_linebreak::linebreaks` gives
 * them. The text's end is included as upstream's iterator reports it.
 */
export function uax14(text) {
  const n = text.length;
  const cps = [], offs = [];
  for (let i = 0; i < n; i++) { const c = text.codePointAt(i); cps.push(c); offs.push(i); if (c > 0xffff) i++; }
  const m = cps.length;
  const cls = cps.map(lbClass).map(k => (k === 'SA' ? 'AL' : k));
  // LB9/LB10: combining marks take the class of what they follow (AL at the start or after spaces).
  const eff = cls.slice();
  for (let j = 0; j < m; j++) {
    if ((eff[j] === 'CM' || eff[j] === 'ZWJ') && j > 0 && !['BK', 'CR', 'LF', 'NL', 'SP', 'ZW'].includes(eff[j - 1])) eff[j] = eff[j - 1];
    else if (eff[j] === 'CM' || eff[j] === 'ZWJ') eff[j] = 'AL';
  }
  const out = [];
  let riCount = 0;
  for (let j = 1; j <= m; j++) {
    const at = j < m ? offs[j] : n;
    const a = eff[j - 1];
    const b = j < m ? eff[j] : 'EOT';
    // LB4/LB5: mandatory break after hard breaks.
    if (a === 'BK' || a === 'LF' || a === 'NL' || (a === 'CR' && b !== 'LF')) { out.push(at); continue; }
    if (a === 'CR' && b === 'LF') continue;
    if (b === 'EOT') { out.push(at); continue; }
    // LB6: no break before hard breaks.
    if (b === 'BK' || b === 'CR' || b === 'LF' || b === 'NL') continue;
    // LB7: no break before spaces or ZW.
    if (b === 'SP' || b === 'ZW') continue;
    // LB8: break after ZW (and the spaces after it).
    let k = j - 1;
    while (k > 0 && eff[k] === 'SP') k--;
    if (eff[k] === 'ZW') { out.push(at); continue; }
    // LB8a: no break after ZWJ.
    if (cls[j - 1] === 'ZWJ') continue;
    // LB9: combining marks stick to their base.
    if (cls[j] === 'CM' || cls[j] === 'ZWJ') { if (a !== 'SP' && a !== 'ZW') continue; }
    // LB11: no break around word joiners.
    if (a === 'WJ' || b === 'WJ') continue;
    // LB12: no break after GL.
    if (a === 'GL') continue;
    // LB12a: no break before GL except after spaces and hyphens.
    if (b === 'GL' && a !== 'SP' && a !== 'BA' && a !== 'HY') continue;
    // LB13: no break before closing punctuation, exclamation, infix separators, symbols.
    if (b === 'CL' || b === 'CP' || b === 'EX' || b === 'IS' || b === 'SY') continue;
    // The class before the spaces in front of b.
    const before = eff[k];
    // LB14: no break after an opening bracket, spaces between them included.
    if (before === 'OP') continue;
    // LB15: no break between a quote and an opening bracket.
    if (before === 'QU' && b === 'OP') continue;
    // LB16: no break between closing punctuation and a non-starter.
    if ((before === 'CL' || before === 'CP') && b === 'NS') continue;
    // LB17: no break between two em dashes.
    if (before === 'B2' && b === 'B2') continue;
    // LB18: break after spaces.
    if (a === 'SP') { out.push(at); continue; }
    // LB19: no break before or after quotation marks.
    if (a === 'QU' || b === 'QU') continue;
    // LB20: break before and after unresolved CB (objects).
    if (a === 'CB' || b === 'CB') { out.push(at); continue; }
    // LB21: no break before hyphens and non-starters, nor after BB.
    if (b === 'BA' || b === 'HY' || b === 'NS' || a === 'BB') continue;
    // LB21a: no break after a Hebrew letter followed by a hyphen (approximated by HL = AL here).
    // LB21b: no break between a solidus and Hebrew letters (not distinguished).
    // LB22: no break before ellipsis.
    if (b === 'IN') continue;
    // LB23: letters and numbers.
    if ((a === 'AL' && b === 'NU') || (a === 'NU' && b === 'AL')) continue;
    // LB23a: prefixes and ideographs.
    if ((a === 'PR' && b === 'ID') || (a === 'ID' && b === 'PO')) continue;
    // LB24: prefix/postfix and letters.
    if ((a === 'PR' || a === 'PO') && b === 'AL') continue;
    if (a === 'AL' && (b === 'PR' || b === 'PO')) continue;
    // LB25: numbers with their prefixes, postfixes and separators.
    if ((a === 'CL' || a === 'CP' || a === 'NU') && (b === 'PO' || b === 'PR')) continue;
    if ((a === 'PO' || a === 'PR') && (b === 'OP' || b === 'NU')) continue;
    if ((a === 'HY' || a === 'IS' || a === 'NU' || a === 'SY') && b === 'NU') continue;
    // LB26/LB27: Korean syllables.
    if (a === 'JL' && (b === 'JL' || b === 'JV' || b === 'H2' || b === 'H3')) continue;
    if ((a === 'JV' || a === 'H2') && (b === 'JV' || b === 'JT')) continue;
    if ((a === 'JT' || a === 'H3') && b === 'JT') continue;
    if (['JL', 'JV', 'JT', 'H2', 'H3'].includes(a) && b === 'PO') continue;
    if (a === 'PR' && ['JL', 'JV', 'JT', 'H2', 'H3'].includes(b)) continue;
    // LB28: no break between letters.
    if (a === 'AL' && b === 'AL') continue;
    // LB29: no break between infix separator and letters.
    if (a === 'IS' && b === 'AL') continue;
    // LB30: letters/numbers and brackets.
    if ((a === 'AL' || a === 'NU') && b === 'OP') continue;
    if (a === 'CP' && (b === 'AL' || b === 'NU')) continue;
    // LB30a: regional indicator pairs.
    if (a === 'RI' && b === 'RI') { riCount++; if (riCount % 2 === 1) continue; } else riCount = 0;
    // LB31: break everywhere else.
    out.push(at);
  }
  return out;
}

/** Kinsoku and Latin word wrap in Asian typography (kinsoku.rs apply); `opps` sorted, deduplicated. */
export function applyKinsoku(text, opps, kinsoku, wordWrap) {
  const next = i => (i < text.length ? text.codePointAt(i) : null);
  const prev = i => { if (i <= 0) return null; const c = text.charCodeAt(i - 1); return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? text.codePointAt(i - 2) : c; };
  let out = opps;
  if (kinsoku) {
    out = out.filter(i => { const n = next(i), p = prev(i); return !(n !== null && NO_START.has(String.fromCodePoint(n))) && !(p !== null && NO_END.has(String.fromCodePoint(p))); });
  } else {
    for (let i = 1; i < text.length; i++) {
      const c = text.codePointAt(i);
      const p = prev(i);
      if (isEastAsian(c) && p !== null && isEastAsian(p)) out.push(i);
      if (c > 0xffff) i++;
    }
  }
  if (!wordWrap) {
    const latin = c => c !== null && isAlnum(c) && !isEastAsian(c);
    for (let i = 1; i < text.length; i++) {
      const c = text.codePointAt(i);
      if (latin(prev(i)) && latin(c)) out.push(i);
      if (c > 0xffff) i++;
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

const isSpaceExceptNb = c => c !== null && /\s/u.test(String.fromCodePoint(c)) && c !== 0xa0 && c !== 0x2007 && c !== 0x202f;

/** Word's break opportunities of `text` (break_positions): offsets a line may break before. */
export function breakPositions(text, rp) {
  const n = text.length;
  const found = [];
  const charAt = i => (i < n ? text.codePointAt(i) : null);
  const charBefore = i => { if (i <= 0) return null; const c = text.charCodeAt(i - 1); return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? text.codePointAt(i - 2) : c; };
  for (const i of uax14(text)) {
    // Word keeps "and/or" and web addresses whole: no break right after a slash before a letter or digit.
    const afterSlash = charBefore(i) === 0x2f && charAt(i) !== null && isAlnum(charAt(i));
    if (i < n && !afterSlash) found.push(i);
    else if (i === n && !afterSlash) { /* the end is an allowed break only for non-mandatory ends; upstream keeps `i < len` */ }
  }
  // Break before a slash that starts a word ("caption /word").
  for (let i = text.indexOf('/'); i >= 0; i = text.indexOf('/', i + 1)) {
    if (isSpaceExceptNb(charBefore(i)) && charAt(i + 1) !== null && isAlnum(charAt(i + 1))) found.push(i);
  }
  // Word breaks after a hyphen before digits ("2016-" / "2022").
  for (let i = text.indexOf('-'); i >= 0; i = text.indexOf('-', i + 1)) {
    const c = charAt(i + 1);
    if (c !== null && c >= 0x30 && c <= 0x39) found.push(i + 1);
  }
  // Myanmar wraps between syllables.
  if (/[က-႟ꧠ-꧿ꩠ-ꩿ]/u.test(text)) for (const b of myanmarBreaks(text)) found.push(b);
  const sorted = [...new Set(found)].sort((a, b) => a - b);
  return applyKinsoku(text, sorted, rp.kinsoku !== false, rp.wordWrap !== false);
}
