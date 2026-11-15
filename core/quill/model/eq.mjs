// The EQ field's overstrike switch (ECMA-376 Part 1 §17.16.5.20, \o): arguments drawn on top of
// one another, centred (\ac, the default), left (\al) or right (\ar). Home › Font › Enclose
// Characters stores a character in a circle, square, triangle or diamond as one: ` eq \o\ac(○,字)`.
// Which enclosure style a field has is kept in the model as a trailing `\* enlarge` (nothing for
// the default "shrink text"); in a .docx the style is the field code runs' font sizes, so the
// marker never reaches a file.
// Translated from wordcraft crates/doc/src/eq.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {OBJ} from './text.mjs';

export const O_ALIGNS = Object.freeze(['left', 'center', 'right']);
const MAX_ARGS = 16;
const isWs = c => /\s/u.test(c);

/** An argument's text: escapes become the character; nested switches and brackets are dropped. */
function argText(s) {
  const cs = [...s];
  let out = '';
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === '\\') {
      const n = cs[i + 1];
      if (n === undefined) continue;
      if ([',', '(', ')', '\\', ';'].includes(n)) { out += n; i++; continue; }
      while (/[A-Za-z]/.test(cs[i + 1] ?? '')) i++;
      while (cs[i + 1] === ' ') i++;
      while (/[0-9.-]/.test(cs[i + 1] ?? '')) i++;
    } else if (c !== '(' && c !== ')') out += c;
  }
  return out;
}

const escapeArg = s => [...s].map(c => ([',', '(', ')', '\\', ';'].includes(c) ? '\\' + c : c)).join('');

/** Parse an `EQ \o` field code: {align, args}; null for any other field or switch. */
export function parseOverstrike(instr) {
  const t = String(instr).replace(/^\s+/u, '');
  let nameEnd = [...t].findIndex(c => isWs(c) || c === '\\');
  nameEnd = nameEnd < 0 ? t.length : [...t].slice(0, nameEnd).join('').length;
  if (t.slice(0, nameEnd).toLowerCase() !== 'eq') return null;
  let rest = t.slice(nameEnd).replace(/^\s+/u, '');
  if (!rest.startsWith('\\')) return null;
  rest = rest.slice(1);
  if (!rest.length || rest[0].toLowerCase() !== 'o') return null;
  rest = rest.slice(1);
  let align = 'center';
  for (;;) {
    rest = rest.replace(/^\s+/u, '');
    if (rest.startsWith('(')) { rest = rest.slice(1); break; }
    if (!rest.startsWith('\\')) return null;
    const sw = rest.slice(1, 3);
    if (sw.length < 2) return null;
    const a = {al: 'left', ac: 'center', ar: 'right'}[sw.toLowerCase()];
    if (!a) return null;
    align = a;
    rest = rest.slice(3);
  }
  const args = [];
  let cur = '', depth = 0, closed = false;
  const cs = [...rest];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === '\\') { cur += c; if (i + 1 < cs.length) cur += cs[++i]; }
    else if (c === '(') { depth++; cur += c; }
    else if (c === ')' && depth === 0) { closed = true; break; }
    else if (c === ')') { depth--; cur += c; }
    else if ((c === ',' || c === ';') && depth === 0) { if (args.length < MAX_ARGS) args.push(argText(cur)); cur = ''; }
    else cur += c;
  }
  if (!closed) return null;
  if (args.length < MAX_ARGS) args.push(argText(cur));
  return {align, args};
}

export const ENCLOSE_SHAPES = Object.freeze(['circle', 'square', 'triangle', 'diamond']);
const SYMBOL = {circle: '○', square: '□', triangle: '△', diamond: '◇'};
/** The symbol in the field code. */
export const encloseSymbol = shape => SYMBOL[shape];
/** The shape a field-code symbol stands for (the usual symbols and their variants), or null. */
export function encloseShapeFromSymbol(s) {
  const cs = [...String(s).trim()];
  if (cs.length !== 1) return null;
  const c = cs[0];
  if ('○◯⭘◦〇'.includes(c)) return 'circle';
  if ('□◻⬜▢◽'.includes(c)) return 'square';
  if ('△▵⊿'.includes(c)) return 'triangle';
  if ('◇◊⬦⋄'.includes(c)) return 'diamond';
  return null;
}
export const parseEncloseShape = s => ENCLOSE_SHAPES.find(k => k === String(s).trim().toLowerCase()) ?? null;
export const ENCLOSE_STYLES = Object.freeze(['shrink', 'enlarge']);
export const parseEncloseStyle = s => ENCLOSE_STYLES.find(k => k === String(s).trim().toLowerCase()) ?? null;

const ENLARGE = '\\* enlarge';

/** Enclosed characters from a field code ({shape, style, text}), or null. */
export function parseEnclosure(instr) {
  const o = parseOverstrike(instr);
  if (!o || o.args.length !== 2) return null;
  const [a, b] = o.args;
  let shape, text;
  if (encloseShapeFromSymbol(a)) { shape = encloseShapeFromSymbol(a); text = b; }
  else if (encloseShapeFromSymbol(b)) { shape = encloseShapeFromSymbol(b); text = a; }
  else return null;
  if (!text.trim()) return null;
  const close = String(instr).lastIndexOf(')');
  if (close < 0) return null;
  const tail = String(instr).slice(close + 1).trim();
  return {shape, style: tail.toLowerCase() === ENLARGE ? 'enlarge' : 'shrink', text};
}

/** The field code as Word writes it: `eq \o\ac(○,字)`. */
export const enclosureWordInstr = e => `eq \\o\\ac(${encloseSymbol(e.shape)},${escapeArg(e.text)})`;
/** The field code in the model (with the style marker). */
export const enclosureInstr = e => (e.style === 'enlarge' ? `${enclosureWordInstr(e)} ${ENLARGE}` : enclosureWordInstr(e));

/** East Asian wide or fullwidth (two half-width or one full-width character fit an enclosure). */
export function isFullWidth(cp) {
  const c = typeof cp === 'number' ? cp : String(cp).codePointAt(0);
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e) || (c >= 0x3041 && c <= 0x33ff) || (c >= 0x3400 && c <= 0x4dbf)
    || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa000 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
}

/** Whether `text` fits an enclosure: one full-width character or one or two half-width ones. */
export function fitsEnclosure(text) {
  const cs = [...String(text)];
  const wide = cs.filter(c => isFullWidth(c)).length;
  return !cs.some(c => /\p{Cc}/u.test(c) || c === OBJ) && (cs.length === 1 || (cs.length === 2 && wide === 0));
}
