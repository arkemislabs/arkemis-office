// Symbol (Insert › Symbols › Symbol › More Symbols…; submit: insert.symbol). OneNote's dialog:
// Font and Subset over a grid of the subset's characters drawn in the font, the 20 recently used
// symbols, and the Character code in Unicode (hex), ASCII (decimal) or ASCII (hex). The Unicode
// name has no name table behind it and shows the code point. Slate has no ArtCraft upstream; the
// subset helpers are Quill's (same Unicode blocks).
import {defineDialog} from '../../kernel/dialog.mjs';
import {SUBSETS, NORMAL_TEXT, isControl, subsetOf} from '../../quill/dialogs/symbol.mjs';
import {RECENT_SYMBOLS_PREF, RECENT_SYMBOLS} from '../commands/insert.mjs';

export const FROM = Object.freeze({unicode: 'Unicode (hex)', decimal: 'ASCII (decimal)', ascii: 'ASCII (hex)'});
const hex4 = cp => cp.toString(16).toUpperCase().padStart(4, '0');

/** Text of a code point in the "from" base. */
export function codeText(cp, from) {
  return from === FROM.decimal ? String(cp) : hex4(cp);
}
/** The code point a typed code names, or null. */
export function parseCode(code, from) {
  const s = String(code ?? '').trim().replace(/^u\+/i, '');
  if (!s) return null;
  const ok = from === FROM.decimal ? /^\d{1,7}$/ : /^[0-9a-f]{1,6}$/i;
  if (!ok.test(s)) return null;
  const cp = Number.parseInt(s, from === FROM.decimal ? 10 : 16);
  if (from !== FROM.unicode && cp > 255) return null;
  return cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) ? cp : null;
}

export default defineDialog({
  id: 'dialog.symbol',
  title: 'Symbol',
  command: 'insert.symbol',
  init(ctx) {
    const recent = Array.isArray(ctx.prefs?.[RECENT_SYMBOLS_PREF]) ? ctx.prefs[RECENT_SYMBOLS_PREF].slice(0, RECENT_SYMBOLS) : [];
    const last = recent[0];
    const cp = last ? last.ch.codePointAt(0) : 0x00A9;
    return {font: last?.font || NORMAL_TEXT, subset: subsetOf(cp) ?? 'Latin-1 Supplement', grid: cp, recentlyUsed: null, recent,
      characterCode: hex4(cp), from: FROM.unicode, unicodeName: `U+${hex4(cp)}`};
  },
  derive(v, changed) {
    if (changed.includes('subset')) {
      const sub = SUBSETS.find(([n]) => n === v.subset);
      if (!sub) return {};
      let cp = sub[1];
      while (isControl(cp) && cp < sub[2]) cp++;
      return {grid: cp, characterCode: codeText(cp, v.from), unicodeName: `U+${hex4(cp)}`};
    }
    if (changed.includes('grid') && typeof v.grid === 'number') return {characterCode: codeText(v.grid, v.from), subset: subsetOf(v.grid) ?? v.subset, unicodeName: `U+${hex4(v.grid)}`};
    if (changed.includes('characterCode')) {
      const cp = parseCode(v.characterCode, v.from);
      return cp === null ? {} : {grid: cp, subset: subsetOf(cp) ?? v.subset, unicodeName: `U+${hex4(cp)}`};
    }
    if (changed.includes('from') && typeof v.grid === 'number') return {characterCode: codeText(v.grid, v.from)};
    if (changed.includes('recentlyUsed') && v.recentlyUsed) {
      const r = (v.recent ?? []).find(x => x.ch === v.recentlyUsed);
      if (r) { const cp = r.ch.codePointAt(0); return {grid: cp, characterCode: codeText(cp, v.from), font: r.font || NORMAL_TEXT, subset: subsetOf(cp) ?? v.subset, unicodeName: `U+${hex4(cp)}`}; }
    }
    return {};
  },
  validate: v => (typeof v.grid === 'number' ? [] : [{field: 'characterCode', message: 'Choose a symbol.'}]),
  toCommand(v) {
    const font = String(v.font ?? '').trim();
    const params = {char: String.fromCodePoint(v.grid)};
    if (font && font !== NORMAL_TEXT) params.font = font;
    return {command: 'insert.symbol', params};
  },
});
