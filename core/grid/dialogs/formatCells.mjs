// Format Cells dialog model (Ctrl+1; submit: home.formatCells, with home.borders for the Border page).
// Translated from gridcraft crates/ui-egui/src/dialogs/format_cells.rs (six pages: Number with
// Category and Sample, Alignment, Font, Border with its preview, Fill, Protection) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, laid out and completed as Excel's dialog: Number has
// Excel's categories (Date and Time with their Type lists, Special, Custom) with Decimal places,
// Use 1000 Separator, Symbol and Negative numbers; Font has Font style; Border applies its edges
// to the outline and inside of the selection as Excel does. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// OK applies only what was changed on the pages (Excel leaves untouched settings of a mixed
// selection alone), as one undo step. Pure: no DOM.

import {defineDialog} from '../../kernel/dialog.mjs';
import {activeStyle} from '../lib/format-ranges.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {formatValue} from '../lib/numfmt.mjs';
import {colorHex, DEFAULT_FONT, DEFAULT_FONT_SIZE} from '../model/style.mjs';
import {valueAt} from '../model/index.mjs';
import {isSingle} from '../lib/addr.mjs';
import {mergeAt} from '../model/sheet.mjs';

export const CATEGORIES = Object.freeze(['General', 'Number', 'Currency', 'Accounting', 'Date', 'Time', 'Percentage', 'Fraction', 'Scientific', 'Text', 'Special', 'Custom']);
export const SYMBOLS = Object.freeze(['None', '$', '£', '€', '¥', '₹', 'CHF', 'R$', '₩', '₽']);
export const DATE_TYPES = Object.freeze(['m/d/yyyy', '[$-F800]dddd, mmmm dd, yyyy', 'm/d;@', 'm/d/yy;@', 'mm/dd/yy;@', '[$-409]d-mmm;@', '[$-409]d-mmm-yy;@',
  '[$-409]dd-mmm-yy;@', '[$-409]mmm-yy;@', '[$-409]mmmm-yy;@', '[$-409]mmmm d, yyyy;@', '[$-409]m/d/yy h:mm AM/PM;@', 'm/d/yy h:mm;@', '[$-409]mmmmm;@',
  '[$-409]mmmmm-yy;@', 'm/d/yyyy;@', '[$-409]d-mmm-yyyy;@']);
export const TIME_TYPES = Object.freeze(['[$-F400]h:mm:ss AM/PM', 'h:mm;@', '[$-409]h:mm AM/PM;@', 'h:mm:ss;@', '[$-409]h:mm:ss AM/PM;@', 'mm:ss.0;@', '[h]:mm:ss;@',
  '[$-409]m/d/yy h:mm AM/PM;@', 'm/d/yy h:mm;@']);
export const FRACTION_TYPES = Object.freeze([['# ?/?', 'Up to one digit (1/4)'], ['# ??/??', 'Up to two digits (21/25)'], ['# ???/???', 'Up to three digits (312/943)'],
  ['# ?/2', 'As halves (1/2)'], ['# ?/4', 'As quarters (2/4)'], ['# ?/8', 'As eighths (4/8)'], ['# ??/16', 'As sixteenths (8/16)'], ['# ?/10', 'As tenths (3/10)'],
  ['# ??/100', 'As hundredths (30/100)']]);
export const SPECIAL_TYPES = Object.freeze([['00000', 'Zip Code'], ['00000-0000', 'Zip Code + 4'], ['[<=9999999]###-####;(###) ###-####', 'Phone Number'],
  ['000-00-0000', 'Social Security Number']]);
export const CUSTOM_CODES = Object.freeze(['General', '0', '0.00', '#,##0', '#,##0.00', '#,##0;[Red]-#,##0', '#,##0.00;[Red]-#,##0.00', '0%', '0.00%', '0.00E+00',
  '##0.0E+0', '# ?/?', '# ??/??', 'm/d/yyyy', 'd-mmm-yy', 'd-mmm', 'mmm-yy', 'mmmm d, yyyy', 'h:mm AM/PM', 'h:mm:ss AM/PM', 'h:mm', 'h:mm:ss', 'm/d/yyyy h:mm',
  'mm:ss', 'mm:ss.0', '@', '[h]:mm:ss', '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)', '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)']);
export const NEGATIVE_LABELS = Object.freeze(['-1234.10', '1234.10 (red)', '(1234.10)', '(1234.10) (red)']);
export const LINE_STYLES = Object.freeze(['none', 'hair', 'dotted', 'dashDotDot', 'dashDot', 'dashed', 'thin', 'mediumDashDotDot', 'slantDashDot', 'mediumDashDot',
  'mediumDashed', 'medium', 'thick', 'double']);
export const PATTERNS = Object.freeze(['none', 'solid', 'gray0625', 'gray125', 'lightGray', 'mediumGray', 'darkGray', 'lightHorizontal', 'lightVertical', 'lightDown',
  'lightUp', 'lightGrid', 'lightTrellis', 'darkHorizontal', 'darkVertical', 'darkDown', 'darkUp', 'darkGrid', 'darkTrellis']);
export const EDGES = Object.freeze(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical', 'diagDown', 'diagUp']);
/** The date the Date and Time type lists show their samples with (Excel: 3/14/2012 1:30:55 PM). */
export const SAMPLE_DATE = 40982.56313657407;

const zeros = d => (d > 0 ? `.${'0'.repeat(d)}` : '');
const quoteSym = sym => (sym && sym !== 'None' ? `"${sym}"` : '');
/** Number category code (Excel's four negative-number forms). */
export function numberCode(decimals, separator, negative) {
  const b = `${separator ? '#,##0' : '0'}${zeros(decimals)}`;
  return [b, `${b};[Red]${b}`, `${b}_);(${b})`, `${b}_);[Red](${b})`][negative] ?? b;
}
/** Currency category code. */
export function currencyCode(decimals, symbol, negative) {
  const b = `${quoteSym(symbol)}#,##0${zeros(decimals)}`;
  return [b, `${b};[Red]${b}`, `${b}_);(${b})`, `${b}_);[Red](${b})`][negative] ?? b;
}
/** Accounting category code (gridcraft `accounting_format` with Excel's decimals). */
export function accountingCode(decimals, symbol) {
  const q = symbol && symbol !== 'None' ? `${quoteSym(symbol)}* ` : '* ';
  const n = `#,##0${zeros(decimals)}`;
  const dash = `"-"${'?'.repeat(decimals)}`;
  return `_(${q}${n}_);_(${q}\\(${n}\\);_(${q}${dash}_);_(@_)`;
}
const percentCode = d => `0${zeros(d)}%`;
const scientificCode = d => `0${zeros(d)}E+00`;

/** Reads a code back into its category and settings (anything unrecognised is Custom). */
export function categoryOf(code) {
  const out = {category: 'Custom', decimalPlaces: 2, useSeparator: false, negativeNumbers: 0, symbol: '$', type: null, code};
  if (code === 'General') return {...out, category: 'General'};
  if (code === '@') return {...out, category: 'Text'};
  for (let d = 0; d <= 30; d++) {
    for (const sep of [false, true]) for (let n = 0; n < 4; n++) if (numberCode(d, sep, n) === code) return {...out, category: 'Number', decimalPlaces: d, useSeparator: sep, negativeNumbers: n};
    for (const sym of SYMBOLS) {
      for (let n = 0; n < 4; n++) if (currencyCode(d, sym, n) === code) return {...out, category: 'Currency', decimalPlaces: d, symbol: sym, negativeNumbers: n};
      if (accountingCode(d, sym) === code) return {...out, category: 'Accounting', decimalPlaces: d, symbol: sym};
    }
    if (percentCode(d) === code) return {...out, category: 'Percentage', decimalPlaces: d};
    if (scientificCode(d) === code) return {...out, category: 'Scientific', decimalPlaces: d};
  }
  if (DATE_TYPES.includes(code)) return {...out, category: 'Date', type: code};
  if (TIME_TYPES.includes(code)) return {...out, category: 'Time', type: code};
  if (FRACTION_TYPES.some(([c]) => c === code)) return {...out, category: 'Fraction', type: code};
  if (SPECIAL_TYPES.some(([c]) => c === code)) return {...out, category: 'Special', type: code};
  return out;
}
/** The code the Number page's settings make. */
export function codeFor(v) {
  const d = Math.max(0, Math.min(30, Math.trunc(Number(v.decimalPlaces ?? 2)) || 0));
  switch (v.category) {
    case 'General': return 'General';
    case 'Number': return numberCode(d, !!v.useSeparator, Number(v.negativeNumbers ?? 0));
    case 'Currency': return currencyCode(d, v.symbol ?? '$', Number(v.negativeNumbers ?? 0));
    case 'Accounting': return accountingCode(d, v.symbol ?? '$');
    case 'Date': return DATE_TYPES.includes(v.type) ? v.type : DATE_TYPES[0];
    case 'Time': return TIME_TYPES.includes(v.type) ? v.type : TIME_TYPES[0];
    case 'Percentage': return percentCode(d);
    case 'Fraction': return FRACTION_TYPES.some(([c]) => c === v.type) ? v.type : FRACTION_TYPES[0][0];
    case 'Scientific': return scientificCode(d);
    case 'Text': return '@';
    case 'Special': return SPECIAL_TYPES.some(([c]) => c === v.type) ? v.type : SPECIAL_TYPES[0][0];
    default: return String(v.code ?? 'General');
  }
}

const hexOf = (c, theme) => (c === null || c === undefined ? 'auto' : typeof c === 'string' ? c : colorHex(c, theme) ?? 'auto');
const fontStyleOf = (bold, italic) => (bold && italic ? 'Bold Italic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular');

export default defineDialog({
  id: 'dialog.formatCells',
  title: 'Format Cells',
  command: 'home.formatCells',
  init(ctx) {
    const st = activeStyle(ctx);
    const theme = ctx.doc?.theme;
    const sel = gridSel(ctx);
    const multi = sel.ranges.length > 1 || !isSingle(sel.ranges[0]);
    const edge = b => (b && b.style && b.style !== 'none' ? b.style : 'none');
    const fill = st.fill;
    const values = {
      ...categoryOf(st.numFmt),
      horizontal: st.align.h, vertical: st.align.v, indent: st.align.indent ?? 0,
      rotation: st.align.rotation === 255 ? 0 : st.align.rotation ?? 0, verticalText: st.align.rotation === 255,
      wrap: !!st.align.wrap, shrink: !!st.align.shrink, merge: !!mergeAt(ctx.doc.sheets[sel.sheet], sel.active.row, sel.active.col),
      font: st.font.name, fontStyle: fontStyleOf(st.font.bold, st.font.italic), bold: !!st.font.bold, italic: !!st.font.italic,
      size: st.font.size, underline: st.font.underline ?? 'none', color: hexOf(st.font.color, theme), strike: !!st.font.strike,
      vert: st.font.vert ?? 'baseline', normalFont: false,
      lineStyle: 'thin', lineColor: 'auto', multi,
      top: edge(st.borders.top), bottom: edge(st.borders.bottom), left: edge(st.borders.left), right: edge(st.borders.right),
      insideHorizontal: 'none', insideVertical: 'none', diagDown: edge(st.borders.diagDown), diagUp: edge(st.borders.diagUp),
      edgeColors: {top: hexOf(st.borders.top?.color, theme), bottom: hexOf(st.borders.bottom?.color, theme), left: hexOf(st.borders.left?.color, theme),
        right: hexOf(st.borders.right?.color, theme), diagDown: hexOf(st.borders.diagDown?.color, theme), diagUp: hexOf(st.borders.diagUp?.color, theme)},
      background: fill.pattern === 'none' ? 'none' : hexOf(fill.pattern === 'solid' ? fill.fg : fill.bg, theme),
      patternColor: fill.pattern !== 'none' && fill.pattern !== 'solid' ? hexOf(fill.fg, theme) : 'auto',
      patternStyle: fill.pattern === 'solid' || fill.pattern === 'none' ? 'none' : fill.pattern,
      locked: !!st.protection.locked, hidden: !!st.protection.hidden,
    };
    try {
      const v = valueAt(ctx.doc, sel.sheet, sel.active.row, sel.active.col);
      values.sampleValue = v === undefined ? null : v;
    } catch { values.sampleValue = null; }
    values._base = JSON.stringify(values);
    return values;
  },
  derive(v, changed) {
    const out = {};
    const has = k => changed.includes(k);
    if (has('code')) Object.assign(out, {category: 'Custom'});
    else if (['category', 'decimalPlaces', 'useSeparator', 'negativeNumbers', 'symbol', 'type'].some(has)) {
      const next = {...v};
      if (has('category')) {
        if (v.category === 'Date') next.type = DATE_TYPES.includes(v.type) ? v.type : DATE_TYPES[0];
        if (v.category === 'Time') next.type = TIME_TYPES.includes(v.type) ? v.type : TIME_TYPES[0];
        if (v.category === 'Fraction') next.type = FRACTION_TYPES.some(([c]) => c === v.type) ? v.type : FRACTION_TYPES[0][0];
        if (v.category === 'Special') next.type = SPECIAL_TYPES.some(([c]) => c === v.type) ? v.type : SPECIAL_TYPES[0][0];
        if (v.category === 'Custom') return {code: v.code};
        out.type = next.type;
      }
      out.code = codeFor(next);
    }
    if (has('fontStyle')) Object.assign(out, {bold: /Bold/.test(v.fontStyle), italic: /Italic/.test(v.fontStyle)});
    if (has('bold') || has('italic')) out.fontStyle = fontStyleOf(v.bold, v.italic);
    if (has('normalFont') && v.normalFont) Object.assign(out, {font: DEFAULT_FONT, size: DEFAULT_FONT_SIZE, fontStyle: 'Regular', bold: false, italic: false,
      underline: 'none', color: 'auto', strike: false, vert: 'baseline'});
    if (has('presets')) {
      const line = v.lineStyle === 'none' ? 'thin' : v.lineStyle;
      const colors = {...(v.edgeColors ?? {})};
      const paint = edges => { for (const e of edges) { out[e] = line; colors[e] = v.lineColor; } out.edgeColors = colors; };
      if (v.presets === 'none') for (const e of EDGES) out[e] = 'none';
      else if (v.presets === 'outline') paint(['top', 'bottom', 'left', 'right']);
      else if (v.presets === 'inside' && v.multi) paint(['insideHorizontal', 'insideVertical']);
      out.presets = null;
    }
    return out;
  },
  validate(v) {
    const out = [];
    if (v.category === 'Custom' && (typeof v.code !== 'string' || !v.code.trim() || v.code.length > 255)) out.push({field: 'code', message: 'Type a number format code.'});
    if (!(Number(v.size) >= 1 && Number(v.size) <= 409)) out.push({field: 'size', message: 'The number must be between 1 and 409.'});
    if (!(Number(v.indent) >= 0 && Number(v.indent) <= 250)) out.push({field: 'indent', message: 'Indent must be between 0 and 250.'});
    if (!(Number(v.rotation) >= -90 && Number(v.rotation) <= 90)) out.push({field: 'rotation', message: 'Orientation must be between -90 and 90 degrees.'});
    if (['Number', 'Currency', 'Accounting', 'Percentage', 'Scientific'].includes(v.category) && !(Number(v.decimalPlaces) >= 0 && Number(v.decimalPlaces) <= 30)) {
      out.push({field: 'decimalPlaces', message: 'Decimal places must be between 0 and 30.'});
    }
    return out;
  },
  preview(ctx, v) {
    const code = v.category === 'Custom' ? String(v.code ?? 'General') : codeFor(v);
    let number;
    try {
      const sys = ctx.doc?.dateSystem === 1904 ? 1904 : 1900;
      number = v.sampleValue === null || v.sampleValue === undefined ? {text: '', color: null} : formatValue(v.sampleValue, code, sys);
    } catch { number = {text: '', color: null}; }
    const sample = c => { try { return formatValue(SAMPLE_DATE, c, 1900).text; } catch { return c; } };
    const d = Math.max(0, Math.min(30, Math.trunc(Number(v.decimalPlaces ?? 2)) || 0));
    const negCode = n => (v.category === 'Currency' ? currencyCode(d, v.symbol ?? '$', n) : numberCode(d, !!v.useSeparator, n));
    const negatives = [0, 1, 2, 3].map(n => {
      try { const r = formatValue(-1234.1, negCode(n), 1900); return {value: n, label: r.text, red: !!r.color}; } catch { return {value: n, label: NEGATIVE_LABELS[n], red: n % 2 === 1}; }
    });
    return {
      code, negatives, number: {text: number.text ?? '', color: number.color ?? null},
      types: v.category === 'Date' ? DATE_TYPES.map(c => ({value: c, label: sample(c)})) : v.category === 'Time' ? TIME_TYPES.map(c => ({value: c, label: sample(c)}))
        : v.category === 'Fraction' ? FRACTION_TYPES.map(([c, l]) => ({value: c, label: l})) : v.category === 'Special' ? SPECIAL_TYPES.map(([c, l]) => ({value: c, label: l})) : [],
      font: {name: v.font, size: Number(v.size) || 11, bold: !!v.bold, italic: !!v.italic, underline: v.underline, strike: !!v.strike, color: v.color, vert: v.vert},
      borders: Object.fromEntries(EDGES.map(e => [e, v[e] && v[e] !== 'none' ? {style: v[e], color: v.edgeColors?.[e] ?? 'auto'} : null])),
      fill: {background: v.background, patternColor: v.patternColor, patternStyle: v.patternStyle},
    };
  },
  toCommand(v) {
    let base = {};
    try { base = JSON.parse(v._base ?? '{}'); } catch { base = {}; }
    const ch = k => JSON.stringify(v[k]) !== JSON.stringify(base[k]);
    const style = {};
    const code = v.category === 'Custom' ? String(v.code ?? 'General') : codeFor(v);
    if (code !== (base.category === 'Custom' ? base.code : codeFor(base))) style.numFmt = code;
    const align = {};
    if (ch('horizontal')) align.h = v.horizontal;
    if (ch('vertical')) align.v = v.vertical;
    if (ch('indent')) align.indent = Math.trunc(Number(v.indent) || 0);
    if (ch('rotation') || ch('verticalText')) align.rotation = v.verticalText ? 255 : Math.trunc(Number(v.rotation) || 0);
    if (ch('wrap')) align.wrap = !!v.wrap;
    if (ch('shrink')) align.shrink = !!v.shrink;
    if (Object.keys(align).length) style.align = align;
    const font = {};
    if (ch('font')) font.name = v.font;
    if (ch('size')) font.size = Number(v.size);
    if (ch('bold') || ch('fontStyle')) font.bold = !!v.bold;
    if (ch('italic') || ch('fontStyle')) font.italic = !!v.italic;
    if (ch('underline')) font.underline = v.underline;
    if (ch('color')) font.color = v.color === 'auto' ? null : v.color;
    if (ch('strike')) font.strike = !!v.strike;
    if (ch('vert')) font.vert = v.vert;
    if (Object.keys(font).length) style.font = font;
    if (ch('background') || ch('patternColor') || ch('patternStyle')) {
      const bg = v.background === 'none' || v.background === 'auto' ? null : v.background;
      if (v.patternStyle && v.patternStyle !== 'none') style.fill = {pattern: v.patternStyle, fg: v.patternColor === 'auto' ? null : v.patternColor, bg};
      else style.fill = bg ? {pattern: 'solid', fg: bg, bg: null} : {pattern: 'none', fg: null, bg: null};
    }
    const prot = {};
    if (ch('locked')) prot.locked = !!v.locked;
    if (ch('hidden')) prot.hidden = !!v.hidden;
    if (Object.keys(prot).length) style.protection = prot;
    const batch = [];
    if (v.merge && !base.merge) batch.push({command: 'home.mergeCells', params: {}});
    if (!v.merge && base.merge) batch.push({command: 'home.unmergeCells', params: {}});
    batch.push({command: 'home.formatCells', params: {style}});
    // Border page: each changed edge on the outline (or inside) of the selection, as Excel applies it.
    for (const e of EDGES) {
      if (v[e] === base[e] && (v.edgeColors?.[e] ?? 'auto') === (base.edgeColors?.[e] ?? 'auto')) continue;
      const preset = {diagDown: 'diagonalDown', diagUp: 'diagonalUp'}[e] ?? e;
      const color = v.edgeColors?.[e];
      batch.push({command: 'home.borders', params: {preset, style: v[e] ?? 'none', ...(color && color !== 'auto' ? {color} : {})}});
    }
    return batch.length === 1 ? batch[0] : {batch};
  },
});
