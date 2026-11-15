// Numbers written the way a language writes them (1 250,50 in Polish, 1.250,50 in German,
// 1,250.50 in English), for table sort and table formulas.
// Translated from wordcraft crates/doc/src/locale_number.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {language} from './collate.mjs';

const POINT_REGIONS = ['de-ch', 'de-li', 'it-ch', 'es-mx', 'es-us', 'es-419', 'es-pr', 'es-do', 'es-gt', 'es-hn', 'es-ni', 'es-pa', 'es-sv', 'es-cu', 'es-pe'];
const COMMA = new Set(['af', 'az', 'be', 'bg', 'bs', 'ca', 'cs', 'da', 'de', 'el', 'es', 'et', 'eu', 'fi', 'fo', 'fr', 'gl', 'hr', 'hu', 'hy', 'id', 'is', 'it',
  'ka', 'kk', 'ky', 'lb', 'lt', 'lv', 'mk', 'mn', 'nb', 'nl', 'nn', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sq', 'sr', 'sv', 'tr', 'uk', 'uz', 'vi']);

/** The decimal separator of language `lang` (BCP 47; null = English). */
export function decimalSeparator(lang = null) {
  const tag = String(lang ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (POINT_REGIONS.some(r => tag === r || tag.startsWith(`${r}-`))) return '.';
  return COMMA.has(language(lang)) ? ',' : '.';
}

const SPACES = [' ', ' ', ' ', ' '];
const CURRENCY = new Set(['$', '€', '£', '¥', '¢', '₽', '₴', '₺', '₹', '₩', '₪', '₫', '฿', '₱', '₸', '₼', '₾']);
const isWs = c => /\s/u.test(c);
const trimCurrency = s => {
  const cs = [...s];
  let a = 0, b = cs.length;
  while (a < b && (isWs(cs[a]) || CURRENCY.has(cs[a]))) a++;
  while (b > a && (isWs(cs[b - 1]) || CURRENCY.has(cs[b - 1]))) b--;
  return cs.slice(a, b).join('');
};
const lastSpace = s => Math.max(...SPACES.map(c => s.lastIndexOf(c)));
const firstSpace = s => { const xs = SPACES.map(c => s.indexOf(c)).filter(i => i >= 0); return xs.length ? Math.min(...xs) : -1; };

/** Strip a currency symbol or a short currency word (zł, kr, PLN) from either end. */
function stripCurrency(s) {
  s = trimCurrency(s);
  const r = lastSpace(s);
  if (r >= 0) {
    const word = [...s.slice(r + 1)];
    if (word.length >= 1 && word.length <= 3 && word.every(c => /\p{L}/u.test(c) || c === '.')) s = s.slice(0, r);
  }
  const f = firstSpace(s);
  if (f >= 0) {
    const word = s.slice(0, f);
    if ([...word].length === 3 && /^[A-Z]{3}$/.test(word)) s = s.slice(f + 1);
  }
  return trimCurrency(s);
}

/** Digits of an integer part grouped by `groups`: first group 1–3 digits, later ones exactly 3. */
function groupedDigits(int, groups) {
  if (/^[0-9]*$/.test(int)) return int;
  const parts = [];
  let cur = '';
  for (const c of int) { if (groups.includes(c)) { parts.push(cur); cur = ''; } else cur += c; }
  parts.push(cur);
  const [first, ...rest] = parts;
  const ok = first.length >= 1 && first.length <= 3 && !first.startsWith('0') && /^[0-9]+$/.test(first) && rest.every(g => /^[0-9]{3}$/.test(g));
  return ok ? parts.join('') : null;
}

/**
 * `s` read as a number written in `lang`, or null. Group separators are spaces (and . or ' in
 * comma languages, , or ' in point languages) between groups of three; a currency sign or short
 * currency word and a trailing % are ignored; in comma languages a lone . that can't group (1.5)
 * is a decimal point; a trailing separator (1.) is the whole number; minus may be -, − or –.
 */
export function parseNumber(s, lang = null) {
  const dec = decimalSeparator(lang);
  let t = String(s).trim();
  if (t.endsWith('%')) t = t.slice(0, -1).trimEnd();
  let body = stripCurrency(t);
  let neg = false;
  if (body.startsWith('-') || body.startsWith('−') || body.startsWith('–')) { neg = true; body = stripCurrency(body.slice(1)); }
  else if (body.startsWith('+')) body = stripCurrency(body.slice(1));
  if (!body.length || new TextEncoder().encode(body).length > 400) return null;
  const groups = [...SPACES, '\'', '’', dec === ',' ? '.' : ','];
  const at = body.indexOf(dec);
  const int = at >= 0 ? body.slice(0, at) : body;
  const frac = at >= 0 ? body.slice(at + 1) : null;
  let intDigits = groupedDigits(int, groups);
  if (intDigits === null) {
    if (dec === ',' && frac === null && int.split('.').length - 1 === 1) return parseNumber(`${neg ? '-' : ''}${int.replace('.', ',')}`, lang);
    return null;
  }
  let fracDigits = '';
  if (frac !== null) { if (!/^[0-9]*$/.test(frac)) return null; fracDigits = frac; }
  if (!intDigits.length && !fracDigits.length) return null;
  const v = Number(`0${intDigits}.${fracDigits}0`);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

/** `v` the way `lang` writes a formula result: whole numbers bare, others with two decimals. */
export function formatNumber(v, lang = null) {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v) && Math.abs(v) < 9.2e18) return BigInt(v).toString();
  let s = v.toFixed(2);
  if (s === '-0.00') s = '0.00';
  return decimalSeparator(lang) === ',' ? s.replace('.', ',') : s;
}
