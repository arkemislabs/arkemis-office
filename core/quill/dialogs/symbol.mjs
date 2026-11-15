// Insert › Symbols › Symbol › More Symbols… (submit: insert.symbol).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_insert/symbol.rs (RECENT_SYMBOLS,
// SUBSETS, subset_of, SPECIAL, SymbolForm {new (the last symbol used and its font), shown_font,
// select_code (hex, U+ allowed), jump_to (a subset's first character), params ((normal text) sends
// no font)}) at aadb077e072b7de05f724e359d8db82e151f125c. The grid lists a subset's code points
// (the renderer draws each in the chosen font); upstream lists only the characters the font file
// has, which a renderer can't read. Recently used symbols are kept in the person's Quill options.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export const RECENT_SYMBOLS = 20;
/** The Font box's first entry: the text's own font (no font of the symbol's own). */
export const NORMAL_TEXT = '(normal text)';
const ownFont = f => { const s = String(f ?? '').trim(); return s && s !== NORMAL_TEXT ? s : ''; };
/** Whether a code point is a control character (upstream leaves them out of the grid). */
export const isControl = cp => cp < 0x20 || (cp >= 0x7F && cp <= 0x9F);
/** Unicode blocks the subset list offers: [name, first, last] (SUBSETS). */
export const SUBSETS = [
  ['Basic Latin', 0x0020, 0x007F], ['Latin-1 Supplement', 0x0080, 0x00FF], ['Latin Extended-A', 0x0100, 0x017F], ['Latin Extended-B', 0x0180, 0x024F],
  ['IPA Extensions', 0x0250, 0x02AF], ['Spacing Modifier Letters', 0x02B0, 0x02FF], ['Combining Diacritical Marks', 0x0300, 0x036F], ['Greek and Coptic', 0x0370, 0x03FF],
  ['Cyrillic', 0x0400, 0x052F], ['Armenian', 0x0530, 0x058F], ['Hebrew', 0x0590, 0x05FF], ['Arabic', 0x0600, 0x06FF], ['Devanagari', 0x0900, 0x097F],
  ['Thai', 0x0E00, 0x0E7F], ['Georgian', 0x10A0, 0x10FF], ['Hangul Jamo', 0x1100, 0x11FF], ['Phonetic Extensions', 0x1D00, 0x1DBF],
  ['Latin Extended Additional', 0x1E00, 0x1EFF], ['Greek Extended', 0x1F00, 0x1FFF], ['General Punctuation', 0x2000, 0x206F],
  ['Superscripts and Subscripts', 0x2070, 0x209F], ['Currency Symbols', 0x20A0, 0x20CF], ['Letterlike Symbols', 0x2100, 0x214F], ['Number Forms', 0x2150, 0x218F],
  ['Arrows', 0x2190, 0x21FF], ['Mathematical Operators', 0x2200, 0x22FF], ['Miscellaneous Technical', 0x2300, 0x23FF], ['Enclosed Alphanumerics', 0x2460, 0x24FF],
  ['Box Drawing', 0x2500, 0x257F], ['Block Elements', 0x2580, 0x259F], ['Geometric Shapes', 0x25A0, 0x25FF], ['Miscellaneous Symbols', 0x2600, 0x26FF],
  ['Dingbats', 0x2700, 0x27BF], ['Supplemental Arrows', 0x27F0, 0x27FF], ['Braille Patterns', 0x2800, 0x28FF], ['Supplemental Mathematical Operators', 0x2A00, 0x2AFF],
  ['CJK Symbols and Punctuation', 0x3000, 0x303F], ['Hiragana', 0x3040, 0x309F], ['Katakana', 0x30A0, 0x30FF], ['CJK Unified Ideographs', 0x4E00, 0x9FFF],
  ['Hangul Syllables', 0xAC00, 0xD7AF], ['Private Use Area', 0xE000, 0xF8FF], ['Alphabetic Presentation Forms', 0xFB00, 0xFB4F],
  ['Halfwidth and Fullwidth Forms', 0xFF00, 0xFFEF], ['Specials', 0xFFF0, 0xFFFF], ['Mathematical Alphanumeric Symbols', 0x1D400, 0x1D7FF],
  ['Emoji and Pictographs', 0x1F300, 0x1FAFF],
];
/** Special Characters: [name, character, the command that inserts it] (SPECIAL). */
export const SPECIAL = [
  ['Em Dash', '—', null], ['En Dash', '–', null], ['Nonbreaking Hyphen', '‑', 'text.nbHyphen'], ['Optional Hyphen', '­', 'text.optionalHyphen'],
  ['Em Space', ' ', null], ['En Space', ' ', null], ['1/4 Em Space', ' ', null], ['Nonbreaking Space', ' ', 'text.nbsp'],
  ['Copyright', '©', null], ['Registered', '®', null], ['Trademark', '™', null], ['Section Mark', '§', null], ['Paragraph Mark', '¶', null],
  ['Ellipsis', '…', null], ['Single Opening Quote', '‘', null], ['Single Closing Quote', '’', null], ['Double Opening Quote', '“', null],
  ['Double Closing Quote', '”', null], ['No-Width Optional Break', '​', null], ['No-Width Non Break', '⁠', null],
];

/** The subset a code point belongs to (subset_of). */
export const subsetOf = cp => SUBSETS.find(([, a, b]) => cp >= a && cp <= b)?.[0] ?? null;
const hex4 = cp => cp.toString(16).toUpperCase().padStart(4, '0');

/** A character by typed code (hex, U+ allowed), or null (select_code). */
export function codePoint(code) {
  const s = String(code ?? '').trim().replace(/^u\+/i, '');
  if (!/^[0-9a-f]{1,6}$/i.test(s)) return null;
  const cp = Number.parseInt(s, 16);
  return cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) ? cp : null;
}

export default defineDialog({
  id: 'dialog.symbol',
  title: 'Symbol',
  command: 'insert.symbol',
  init(ctx) {
    const recent = Array.isArray(ctx.prefs?.recentSymbols) ? ctx.prefs.recentSymbols.slice(0, RECENT_SYMBOLS) : [];
    const last = recent[0];
    const cp = last ? last.ch.codePointAt(0) : 0x00A9;
    return {font: last?.font || NORMAL_TEXT, subset: subsetOf(cp) ?? 'Latin-1 Supplement', grid: cp, recent: null, recentSymbols: recent, code: hex4(cp), from: 'unicode',
      name: '', list: null};
  },
  derive(v, changed) {
    if (changed.includes('subset')) {
      // The subset's first character (jump_to), past its control characters.
      const s = SUBSETS.find(([n]) => n === v.subset);
      if (!s) return {};
      let cp = s[1];
      while (isControl(cp) && cp < s[2]) cp++;
      return {grid: cp, code: hex4(cp)};
    }
    if (changed.includes('grid') && typeof v.grid === 'number') return {code: hex4(v.grid), subset: subsetOf(v.grid) ?? v.subset};
    if (changed.includes('code')) { const cp = codePoint(v.code); return cp === null ? {} : {grid: cp, subset: subsetOf(cp) ?? v.subset}; }
    if (changed.includes('recent') && v.recent) { const r = v.recentSymbols.find(x => x.ch === v.recent); return r ? {grid: r.ch.codePointAt(0), code: hex4(r.ch.codePointAt(0)), font: r.font || NORMAL_TEXT} : {}; }
    return {};
  },
  validate(v) {
    if (v.list) return [];
    return typeof v.grid === 'number' ? [] : [{field: 'code', message: 'Choose a symbol.'}];
  },
  toCommand(v) {
    // The Special Characters tab: its character, or the command that inserts it.
    if (v.list) {
      const sp = SPECIAL.find(([name]) => name === v.list);
      if (sp?.[2]) return {command: sp[2], params: {}};
      return {command: 'insert.symbol', params: {char: sp ? sp[1] : v.list}};
    }
    const ch = String.fromCodePoint(v.grid);
    return {command: 'insert.symbol', params: ownFont(v.font) ? {char: ch, font: ownFont(v.font)} : {char: ch}};
  },
});
