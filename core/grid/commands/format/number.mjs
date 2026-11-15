// Home › Number: the Number Format list, Accounting Number Format (with its currency choices),
// Percent Style, Comma Style, Increase Decimal and Decrease Decimal.
// Translated from gridcraft crates/engine/src/cmd/format.rs (`ACCOUNTING`, `COMMA`, `accounting`,
// `accounting_format`, `format_code_for`, `number_format`, `set_fmt`, `adjust_decimals`,
// `decimals`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {applyStyle, activeStyle} from '../../lib/format-ranges.mjs';
import {RANGE, SHEET, UPSTREAM_COMMIT, withDoc} from '../../lib/format-params.mjs';
import {areaAddress, bad, gridSel, baseDoc} from '../../lib/edit-targets.mjs';
import {numberToText} from '../../lib/value.mjs';
import {valueAt} from '../../model/index.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/format.rs']};
const ranges = (ctx, t) => t.areas.map(a => areaAddress(ctx.doc, t.sheet, a));

export const ACCOUNTING = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
export const COMMA = '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)';
export const FORMAT_NAMES = Object.freeze(['General', 'Number', 'Currency', 'Accounting', 'Short Date', 'Long Date', 'Time', 'Percentage', 'Fraction', 'Scientific', 'Text']);

/** format.rs `accounting_format`: Accounting with a currency symbol. */
export const accountingFormat = symbol => {
  const q = `"${symbol}"`;
  return `_(${q}* #,##0.00_);_(${q}* \\(#,##0.00\\);_(${q}* "-"??_);_(@_)`;
};

/** format.rs `format_code_for`: ribbon format names -> codes (anything else is a code). */
export function formatCodeFor(name) {
  switch (name) {
    case 'General': return 'General';
    case 'Number': return '0.00';
    case 'Currency': return '"$"#,##0.00';
    case 'Accounting': return ACCOUNTING;
    case 'Short Date': return 'm/d/yyyy';
    case 'Long Date': return '[$-F800]dddd, mmmm dd, yyyy';
    case 'Time': return '[$-F400]h:mm:ss AM/PM';
    case 'Percentage': return '0.00%';
    case 'Fraction': return '# ?/?';
    case 'Scientific': return '0.00E+00';
    case 'Text': return '@';
    case 'Comma': return COMMA;
    default: return name;
  }
}
/** The Number Format box's text for a code: its ribbon name, else Custom (Excel). */
export function formatNameOf(code) {
  for (const n of FORMAT_NAMES) if (formatCodeFor(n) === code) return n;
  return 'Custom';
}

/**
 * format.rs `adjust_decimals`: adds or removes one decimal place in a number format. General
 * starts from the displayed number of decimals of the value.
 */
export function adjustDecimals(code, value, delta) {
  if (code === 'General') {
    const text = typeof value === 'number' ? numberToText(value) : '';
    const dot = text.indexOf('.');
    const dec = dot >= 0 ? text.length - dot - 1 : 0;
    const n = Math.max(dec + delta, 0);
    return n === 0 ? '0' : `0.${'0'.repeat(n)}`;
  }
  return code.split(';').map(sec => {
    const chars = Array.from(sec);
    let inQuote = false, inBracket = false, lastDigit = null, point = null;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === '"') inQuote = !inQuote;
      if (c === '[' && !inQuote) inBracket = true;
      if (c === ']' && !inQuote) { inBracket = false; continue; }
      if (inQuote || inBracket) continue;
      if (c === '0' || c === '#' || c === '?') lastDigit = i;
      if (c === '.' && point === null) point = i;
      if (c === 'E' || c === 'e') break;
    }
    if (lastDigit === null) return sec;
    const out = chars.slice();
    if (delta > 0) {
      if (point !== null) out.splice(lastDigit + 1, 0, '0');
      else out.splice(lastDigit + 1, 0, '.', '0');
    } else if (point !== null && lastDigit > point) {
      out.splice(lastDigit, 1);
      if (lastDigit === point + 1) out.splice(point, 1);
    }
    return out.join('');
  }).join(';');
}

/** gridcraft `set_fmt`. */
function setFmt(ctx, p, code) {
  if (typeof code !== 'string' || !code || code.length > 255) throw bad('home.numberFormat', 'a format code has 1 to 255 characters');
  const t = applyStyle(ctx, p, st => { st.numFmt = code; });
  return {numFmt: code, ranges: ranges(ctx, t)};
}

const activeValue = ctx => {
  const sel = gridSel(ctx);
  try { return valueAt(baseDoc(ctx), sel.sheet, sel.active.row, sel.active.col); } catch { return null; }
};

const P = s.object({range: RANGE, sheet: SHEET});

export default defineCommands({
  family: 'format/number',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'home.numberFormat', label: 'Number Format', risk: 'edit',
      description: 'Set the number format of a range (default: the selection): a ribbon name (General, Number, Currency, Accounting, Short Date, Long Date, Time, Percentage, Fraction, Scientific, Text) or a code.',
      params: s.object({range: RANGE, sheet: SHEET, format: s.optional(s.string({min: 1, max: 255})), code: s.optional(s.string({min: 1, max: 255})),
        value: s.optional(s.string({min: 1, max: 255}))}),
      state: ctx => withDoc(ctx, () => ({value: formatNameOf(activeStyle(ctx).numFmt)})),
      run(ctx, p) {
        const code = p.code ?? (p.format !== undefined ? formatCodeFor(p.format) : p.value !== undefined ? formatCodeFor(p.value) : undefined);
        if (code === undefined) throw bad('home.numberFormat', 'missing `format` or `code`');
        return setFmt(ctx, p, code);
      },
    },
    {
      id: 'home.accounting', label: 'Accounting Number Format', risk: 'edit',
      description: 'Accounting number format for a range (default: the selection), with the currency symbol to use (default $).',
      params: s.object({range: RANGE, sheet: SHEET, symbol: s.optional(s.string({min: 1, max: 20}))}),
      state: ctx => withDoc(ctx, () => ({})),
      run(ctx, p) {
        const symbol = p.symbol ?? '$';
        // The symbol goes into a quoted literal: a quote or a backslash would end it, and a control
        // character would reach the format's text as-is.
        if (/["\\]/.test(symbol) || /[\u0000-\u001f\u007f-\u009f]/.test(symbol)) {
          throw bad('home.accounting', "the symbol can't contain a quote, a backslash or a control character");
        }
        return setFmt(ctx, p, accountingFormat(symbol));
      },
    },
    {id: 'home.percent', label: 'Percent Style', shortcut: 'Ctrl+Shift+5', risk: 'edit', description: 'Show the values of a range (default: the selection) as percentages (0%).',
      params: P, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => setFmt(ctx, p, '0%')},
    {id: 'home.comma', label: 'Comma Style', risk: 'edit', description: 'Show the values of a range (default: the selection) with a thousands separator and two decimals (Comma style).',
      params: P, state: ctx => withDoc(ctx, () => ({})), run: (ctx, p) => setFmt(ctx, p, COMMA)},
    ...[['home.increaseDecimal', 'Increase Decimal', 1], ['home.decreaseDecimal', 'Decrease Decimal', -1]].map(([id, label, delta]) => ({
      id, label, risk: 'edit',
      description: `${delta > 0 ? 'Show one more' : 'Show one fewer'} decimal place in a range (default: the selection), from the active cell's format.`,
      params: P, state: ctx => withDoc(ctx, () => ({})),
      run(ctx, p) {
        baseDoc(ctx);
        const code = adjustDecimals(activeStyle(ctx).numFmt, activeValue(ctx), delta);
        return setFmt(ctx, p, code);
      },
    })),
  ],
});
