// Field results computed at layout time (PAGE, NUMPAGES, SECTIONPAGES, SECTION, PAGEREF, TITLE,
// AUTHOR, FILENAME, ASK/SET) and note numbering marks.
//
// Translated from wordcraft crates/layout/src/fields.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). STYLEREF (`styleref.rs`) is not translated yet: a
// STYLEREF field shows its stored result.
import {formatNumber} from '../model/numfmt.mjs';

/** A field context (FieldCtx) with upstream's defaults. */
export function fieldCtx(f = {}) {
  return {page: 0, pageFormat: 'decimal', pages: 0, sectionPages: 0, section: 0, notes: new Map(), title: '', author: '', filename: '',
    filepath: '', bookmarkPages: new Map(), bookmarksKey: 0, pageFrom: [], ...f};
}

/** The mark of note `id` (note_mark). */
export function noteMark(ctx, id, fmt) {
  const n = ctx.notes.get(id);
  return n ? formatNumber(n.fmt, n.n) : formatNumber(fmt, 1);
}
/** The page a field at offset `off` of the paragraph being laid out is on (page_at). */
export function pageAt(ctx, off) {
  for (let i = ctx.pageFrom.length - 1; i >= 0; i--) if (ctx.pageFrom[i][0] <= off) return ctx.pageFrom[i][1];
  return ctx.page;
}
/** A cache key for what a page-dependent paragraph depends on (page_key). */
export const pageKey = ctx => `${ctx.page}|${ctx.pages}|${ctx.sectionPages}|${ctx.section}|${ctx.bookmarksKey}|${ctx.pageFormat}`;

/** The field's name: the first word of the instruction, upper-cased (field_name). */
export function fieldName(instr) {
  const w = String(instr).trim().split(/\s+/)[0] ?? '';
  return w.replace(/^=+/, '').toUpperCase();
}

/** REF's hyperlink switch links its result (reference_link). */
export function referenceLink(instr) {
  const m = /^\s*(\S+)\s+([\s\S]*)$/.exec(instr);
  if (!m || m[1].toUpperCase() !== 'REF') return null;
  const args = m[2].trimStart();
  let target, switches;
  if (args.startsWith('"')) {
    const end = args.indexOf('"', 1);
    if (end < 0) return null;
    target = args.slice(1, end);
    switches = args.slice(end + 1);
  } else {
    let end = args.search(/[\s\\]/);
    if (end < 0) end = args.length;
    target = args.slice(0, end);
    switches = args.slice(end);
  }
  if (!target) return null;
  let quoted = false;
  for (let i = 0; i < switches.length; i++) {
    const c = switches[i];
    if (quoted && c === '\\') i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === '\\') {
      const s = switches[i + 1];
      i++;
      if (s && s.toLowerCase() === 'h' && !/[\p{L}\p{N}]/u.test(switches[i + 1] ?? '')) return `#${target}`;
    }
  }
  return null;
}

/** The `\* FORMAT` switch's number format (format_switch). */
export function formatSwitch(instr) {
  const words = String(instr).trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('\\*')) continue;
    let v = w.slice(2);
    if (!v) { v = words[++i]; if (v === undefined) return null; }
    v = v.split('\\')[0];
    const map = {roman: 'lowerRoman', ROMAN: 'upperRoman', Roman: 'upperRoman', alphabetic: 'lowerLetter', ALPHABETIC: 'upperLetter',
      Alphabetic: 'upperLetter', CardText: 'cardinalText', cardtext: 'cardinalText', OrdText: 'ordinalText', ordtext: 'ordinalText',
      Ordinal: 'ordinal', ordinal: 'ordinal', Arabic: 'decimal', arabic: 'decimal', ArabicDash: 'numberInDash', arabicdash: 'numberInDash',
      ARABICDASH: 'numberInDash', DollarText: 'dollarText', dollartext: 'dollarText', DOLLARTEXT: 'dollarText', Hex: 'hex', hex: 'hex', HEX: 'hex'};
    if (Object.hasOwn(map, v)) return map[v];
    const lv = v.toLowerCase();
    if (lv === 'chinesenum1') return 'chineseCountingThousand';
    if (lv === 'chinesenum2') return 'chineseLegalSimplified';
    if (lv === 'chinesenum3') return 'ideographDigital';
  }
  return null;
}

/** The capitalization switches in order (case_switches); quoted text is no switch. */
function caseSwitches(instr) {
  const out = [];
  let quoted = false;
  const s = String(instr);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && quoted) { i++; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (c === '\\' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && /\s/.test(s[i])) i++;
      let word = '';
      while (i < s.length && !/\s/.test(s[i]) && s[i] !== '\\' && s[i] !== '"') word += s[i++];
      i--;
      const k = {upper: 'upper', lower: 'lower', caps: 'caps', firstcap: 'firstCap'}[word.toLowerCase()];
      if (k) out.push(k);
    }
  }
  return out;
}

/** `text` with the field's capitalization switches applied in order (apply_case_switch). */
export function applyCaseSwitch(instr, text) {
  return caseSwitches(instr).reduce(applyCase, text);
}
const ALNUM = /[\p{L}\p{N}]/u;
function applyCase(text, k) {
  if (k === 'upper') return text.toUpperCase();
  if (k === 'lower') return text.toLowerCase();
  let out = '', wordStart = true, done = false;
  for (const c of text) {
    if (/\s/u.test(c)) { wordStart = true; out += c; } else if (wordStart && !done && ALNUM.test(c)) {
      out += c.toUpperCase();
      wordStart = false;
      done = k === 'firstCap';
    } else {
      if (ALNUM.test(c)) wordStart = false;
      out += c;
    }
  }
  return out;
}

const MAX_TEXT_NUMBER = 999_999;

/** `n` in `fmt` as a field shows it (field_number). */
export function fieldNumber(instr, fmt, n) {
  let text;
  if ((fmt === 'cardinalText' || fmt === 'ordinalText' || fmt === 'dollarText') && n > MAX_TEXT_NUMBER) text = String(n);
  else if (fmt === 'cardinalText' || fmt === 'ordinalText') text = formatNumber(fmt, n).toLowerCase();
  else if (fmt === 'dollarText') text = dollarText(n) ?? String(n);
  else if (fmt === 'hex') text = n.toString(16).toUpperCase();
  else text = formatNumber(fmt, n);
  return applyCaseSwitch(instr, text);
}

/** `value` as `\* DollarText` writes it (dollar_text); null out of range. */
export function dollarText(value) {
  const cents = Math.round(value * 100);
  if (!(cents >= 0 && cents <= MAX_TEXT_NUMBER * 100 + 99)) return null;
  const whole = Math.floor(cents / 100), rest = cents % 100;
  return `${formatNumber('cardinalText', whole).toLowerCase()} and ${String(rest).padStart(2, '0')}/100`;
}

/** The light grey behind a field shown as its code (FIELD_SHADING). */
export const FIELD_SHADING = Object.freeze([0xd9, 0xd9, 0xd9]);
/** What a field shows in code view: `{ PAGE }` (field_code_text). */
export const fieldCodeText = instr => `{ ${String(instr).trim()} }`;

/** Display text for a field and whether it depends on the page (field_text). */
export const fieldText = (instr, result, ctx) => fieldTextOn(instr, result, ctx, ctx.page);

/** Display text for a field on page `page` (field_text_on): [text, pageDependent]. */
export function fieldTextOn(instr, result, ctx, page) {
  const name = fieldName(instr);
  const fmt = formatSwitch(instr);
  switch (name) {
    case 'PAGE': return [fieldNumber(instr, fmt ?? ctx.pageFormat, page), true];
    case 'NUMPAGES': return [fieldNumber(instr, fmt ?? 'decimal', ctx.pages), true];
    case 'SECTIONPAGES': return [fieldNumber(instr, fmt ?? 'decimal', ctx.sectionPages), true];
    case 'SECTION': return [fieldNumber(instr, fmt ?? 'decimal', ctx.section), true];
    case 'PAGEREF': {
      const p = pagerefPage(instr, ctx);
      return p ? [fieldNumber(instr, fmt ?? p[1], p[0]), true] : [result, false];
    }
    case 'TITLE': if (!result) return [applyCaseSwitch(instr, ctx.title), false]; break;
    case 'AUTHOR': if (!result) return [applyCaseSwitch(instr, ctx.author), false]; break;
    case 'FILENAME': if (!result) {
      const text = hasSwitch(instr, 'p') && ctx.filepath ? ctx.filepath : ctx.filename ? ctx.filename : 'Document1';
      return [applyCaseSwitch(instr, text), false];
    } break;
    case 'ASK': case 'SET': return ['', false];
    default: break;
  }
  return [result, false];
}

/** The bookmark a PAGEREF names (pageref_target). */
function pagerefTarget(instr) {
  const words = String(instr).trim().split(/\s+/);
  const name = words[0];
  if (!name) return null;
  const after = instr.slice(instr.indexOf(name) + name.length).trimStart();
  if (after.startsWith('"')) {
    const b = after.slice(1).split('"')[0];
    if (b) return b;
  }
  const word = words[1];
  if (word === undefined) return null;
  const target = word.split('\\')[0].replace(/^"+|"+$/g, '');
  return target || null;
}
function pagerefPage(instr, ctx) {
  const t = pagerefTarget(instr);
  if (!t || hasSwitch(instr, 'p')) return null;
  return ctx.bookmarkPages.get(t) ?? null;
}
/** Whether `instr` has the one-letter switch `\sw` (has_switch). */
function hasSwitch(instr, sw) {
  return String(instr).split('\\').slice(1).some(s => s.length > 0 && s[0].toLowerCase() === sw.toLowerCase() && !(s.length > 1 && /[\p{L}\p{N}]/u.test(s[1])));
}

/** Does `p` show fields whose text depends on the page (has_page_fields)? */
export const hasPageFields = p => (p.objects ?? []).some(o => o.type === 'field' && ['PAGE', 'NUMPAGES', 'SECTIONPAGES', 'SECTION', 'PAGEREF'].includes(fieldName(o.instr ?? '')));
/** Does `p` show a PAGE field (has_page_number_fields)? */
export const hasPageNumberFields = p => (p.objects ?? []).some(o => o.type === 'field' && fieldName(o.instr ?? '') === 'PAGE');
/** Does `p` show a page total (has_total_fields)? */
export const hasTotalFields = p => (p.objects ?? []).some(o => o.type === 'field' && ['NUMPAGES', 'SECTIONPAGES'].includes(fieldName(o.instr ?? '')));
