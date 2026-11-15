// Word's Find and Replace patterns: special characters (^p, ^t, ^# …) and the "Use wildcards"
// language (?, *, [a-z], {n,m}, @, <, >, ( )), translated to a JavaScript regular expression
// (Unicode mode). Replace with text understands the same codes plus ^& (the found text), ^c (the
// clipboard) and, with wildcards, \1–\9 (the groups); with regular expressions $n, ${n}, ${name},
// $name, $$, \n (a paragraph mark) and \t.
//
// Translated from wordcraft crates/engine/src/cmd/find_pattern.rs (PARA_MARK, SECT_MARK,
// MAX_PATTERN, Opts, Compiled, find_code, replace_code, code_char, ansi, numeric_code, lit,
// compile, special, is_punct, is_space, wildcards, count, class, Piece, parse_replace,
// caret_code, regex_ref, group_ref, resolve_names, as_inserted, expand) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Differences forced by the engine: upstream builds patterns for the Rust `regex` crate, which runs
// in linear time and has Unicode-aware \b, \w, \d and \s. JavaScript's engine backtracks and its
// \b, \w, \d are ASCII, so word boundaries and classes are written out with Unicode properties
// here, and a regular expression (the "Regular expressions" option, Rust syntax) is translated:
// (?P<name>…) → (?<name>…), \x{…} → \u{…}, \A / \z, and the Unicode classes. Pattern length stays
// capped at MAX_PATTERN and counts at MAX_COUNT, as upstream.

/** A paragraph mark in the searched text. */
export const PARA_MARK = '\r';
/** The mark of a paragraph that ends a section (^b), in the searched text only. */
export const SECT_MARK = String.fromCharCode(0x1D);
/** Longest Find what text, in characters. */
export const MAX_PATTERN = 1024;
/** Largest count in {n,m}. */
const MAX_COUNT = 1000;
/** Any character except a paragraph mark (?, ^?, *). */
const ANY = '[^\\r\\u{1D}]';
/** A word character as Rust's Unicode \w reads it. */
const W = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]';
const B_START = `(?<!${W})(?=${W})`;
const B_END = `(?<=${W})(?!${W})`;
const B = `(?:${B_START}|${B_END})`;

/** Default options (Opts::default). */
export const defaultOpts = () => ({matchCase: false, wholeWord: false, prefix: false, suffix: false, ignorePunct: false, ignoreSpace: false,
  wildcards: false, regex: false, literal: false});

const FIND_CODES = {
  p: '\\r', b: '\\u{1D}', t: '\\t', '?': ANY, '#': '[0-9]', $: '\\p{L}', '^': '\\^', l: '\\n', m: '\\u{C}', n: '\\u{E}',
  '+': '\\u{2014}', '=': '\\u{2013}', s: '\\u{A0}', '~': '\\u{2011}', '-': '\\u{AD}', w: '[ \\t\\u{A0}]+', g: '\\u{FFFC}', '%': '§', v: '¶',
};
/** What a ^ code stands for in Find what (find_code). */
const findCode = c => FIND_CODES[c] ?? null;

const REPLACE_CODES = {
  p: PARA_MARK, t: '\t', '^': '^', l: '\n', m: String.fromCharCode(0x0C), n: String.fromCharCode(0x0E), '+': '—', '=': '–',
  s: ' ', '~': '‑', '-': '­', '%': '§', v: '¶',
};
/** What a ^ code stands for in Replace with (replace_code). */
const replaceCode = c => REPLACE_CODES[c] ?? null;

const isControl = c => /\p{Cc}/u.test(c);

/** A character code (^13, ^0151, ^u8212) as the character it stands for here (code_char). */
function codeChar(n) {
  switch (n) {
    case 13: return PARA_MARK;
    case 11: return '\n';
    case 12: return String.fromCharCode(0x0C);
    case 14: return String.fromCharCode(0x0E);
    case 30: return '‑';
    case 31: return '­';
    default: {
      if (n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return null;
      const c = String.fromCodePoint(n);
      return !isControl(c) || c === '\t' ? c : null;
    }
  }
}

const HIGH = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F, 0x90, 0x2018,
  0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
/** A Windows-1252 code as its Unicode scalar (ansi). */
const ansi = n => (n >= 128 && n < 160 ? HIGH[n - 128] : n);

/** Read a numeric code after ^ at chars[i]: [character, characters used] or null (numeric_code). */
function numericCode(chars, i) {
  const [start, max] = chars[i] === 'u' ? [i + 1, 5] : [i, 4];
  let digits = '';
  for (let k = start; k < chars.length && digits.length < max && /[0-9]/.test(chars[k]); k++) digits += chars[k];
  if (!digits) return null;
  let n = Number(digits);
  if (start === i && digits.startsWith('0')) n = ansi(n);
  const c = codeChar(n);
  return c === null ? null : [c, start - i + digits.length];
}

const SYNTAX = new Set([...'^$\\.*+?()[]{}|/']);
/** A literal character as a regex atom (lit). */
function lit(c) {
  if (c === PARA_MARK) return '\\r';
  if (c === '\n') return '\\n';
  if (c === '\t') return '\\t';
  if (SYNTAX.has(c)) return '\\' + c;
  const cp = c.codePointAt(0);
  if (cp < 0x20 || cp === 0x2028 || cp === 0x2029) return `\\u{${cp.toString(16)}}`;
  return c;
}
/** A literal character inside a character class. */
function litClass(c) {
  if (c === '-' || c === ']' || c === '[' || c === '\\' || c === '^') return '\\' + c;
  return lit(c).replace(/^\\([.*+?(){}|/$])$/, '$1');
}
/** regex::escape for a whole string, as JS atoms. */
export const escapeText = s => [...s].map(lit).join('');

/** Translate a regular expression written for the Rust regex crate to a JavaScript (Unicode mode) one. */
export function rustRegex(src) {
  let out = '';
  let inClass = 0;
  const cs = [...src];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === '\\' && i + 1 < cs.length) {
      const n = cs[i + 1];
      if (n === 'x' && cs[i + 2] === '{') { const end = cs.indexOf('}', i + 3); if (end > 0) { out += `\\u{${cs.slice(i + 3, end).join('')}}`; i = end; continue; } }
      if (n === 'A') { out += '^'; i++; continue; }
      if (n === 'z') { out += '$'; i++; continue; }
      if (!inClass && n === 'b' && cs[i + 2] === '{') {
        const end = cs.indexOf('}', i + 3);
        const kind = cs.slice(i + 3, end).join('');
        if (end > 0 && (kind === 'start' || kind === 'end')) { out += kind === 'start' ? B_START : B_END; i = end; continue; }
      }
      if (!inClass && n === 'b') { out += B; i++; continue; }
      if (!inClass && n === 'B') { out += `(?!${B})`; i++; continue; }
      const cls = {w: W.slice(1, -1), d: '\\p{Nd}', s: '\\p{White_Space}'}[n];
      if (cls) { out += inClass ? cls : `[${cls}]`; i++; continue; }
      const neg = {W: W.slice(1, -1), D: '\\p{Nd}', S: '\\p{White_Space}'}[n];
      if (neg) { out += inClass ? (n === 'D' ? '\\P{Nd}' : n === 'S' ? '\\P{White_Space}' : '\\W') : `[^${neg}]`; i++; continue; }
      out += c + n; i++; continue;
    }
    if (c === '[') inClass++;
    else if (c === ']' && inClass) inClass--;
    else if (!inClass && c === '(' && cs[i + 1] === '?' && cs[i + 2] === 'P' && cs[i + 3] === '<') { out += '(?<'; i += 3; continue; }
    out += c;
  }
  return out;
}

/** Translate Word's Find what text: {pattern, caseInsensitive, spansParas} (compile). Throws a message string. */
export function compile(query, o = defaultOpts()) {
  if ([...query].length > MAX_PATTERN) throw new Error(`the Find what text is longer than ${MAX_PATTERN} characters`);
  let pat, spans = false;
  if (o.regex) pat = rustRegex(query);
  else if (o.literal) pat = escapeText(query);
  else if (o.wildcards) [pat, spans] = wildcards(query);
  else [pat, spans] = special(query, o);
  const wrap = p => `(?:${p})`;
  if (!(o.wildcards && !o.regex)) {
    if (o.wholeWord || (o.prefix && o.suffix)) pat = `${B}${wrap(pat)}${B}`;
    else if (o.prefix) pat = `${B}${wrap(pat)}`;
    else if (o.suffix) pat = `${wrap(pat)}${B}`;
  }
  // Word's wildcard search always matches case.
  const caseInsensitive = !o.matchCase && (!o.wildcards || o.regex);
  return {pattern: pat, caseInsensitive, spansParas: spans};
}

/** The RegExp for a compiled pattern (global, Unicode; case-insensitive when asked). */
export function toRegExp(c) {
  try {
    return new RegExp(c.pattern, `gu${c.caseInsensitive ? 'i' : ''}`);
  } catch (e) {
    throw new Error(`bad pattern: ${e.message.replace(/^Invalid regular expression: /, '')}`);
  }
}

const isPunct = c => /[!-/:-@[-`{-~]/.test(c) || /[‐-‧¡¿«»]/u.test(c);
const isSpace = c => c === ' ' || c === '\t' || c === ' ';

/** Normal search: literal text with ^ codes, optionally skipping punctuation and white space (special). */
function special(query, o) {
  const chars = [...query];
  const atoms = [];
  let spans = false;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i++];
    if (c === '^' && i < chars.length) {
      const n = chars[i];
      const code = findCode(n);
      if (code !== null) { if (n === 'p' || n === 'b') spans = true; atoms.push(code); i++; continue; }
      const num = numericCode(chars, i);
      if (num) { if (num[0] === PARA_MARK) spans = true; atoms.push(lit(num[0])); i += num[1]; continue; }
    }
    if ((o.ignorePunct && isPunct(c)) || (o.ignoreSpace && isSpace(c))) continue;
    atoms.push(lit(c));
  }
  const filler = o.ignorePunct && o.ignoreSpace ? '[\\p{P} \\t\\u{A0}]*' : o.ignorePunct ? '\\p{P}*' : o.ignoreSpace ? '[ \\t\\u{A0}]*' : '';
  return [atoms.join(filler), spans];
}

/** "Use wildcards" search (wildcards). */
function wildcards(query) {
  const chars = [...query];
  let out = '';
  let spans = false;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i++];
    switch (c) {
      case '?': out += ANY; break;
      case '*': out += ANY + '*?'; break;
      case '@': out += '+'; break;
      case '<': out += B_START; break;
      case '>': out += B_END; break;
      case '(': case ')': out += c; break;
      case '{': {
        const end = chars.indexOf('}', i);
        if (end < 0) throw new Error('a { needs a closing }');
        out += count(chars.slice(i, end).join(''));
        i = end + 1;
        break;
      }
      case '[': {
        const end = chars.indexOf(']', i);
        if (end < 0) throw new Error('a [ needs a closing ]');
        out += cls(chars.slice(i, end));
        i = end + 1;
        break;
      }
      case '\\': {
        const n = chars[i];
        if (n !== undefined && /[0-9]/.test(n)) throw new Error('back-references (\\1) work in Replace with, not in Find what');
        if (n !== undefined) { out += lit(n); i++; } else out += '\\\\';
        break;
      }
      case '^': {
        const n = chars[i];
        if (n === undefined) { out += '\\^'; break; }
        const code = findCode(n);
        if (code !== null) { if (n === 'p' || n === 'b') spans = true; out += code; i++; break; }
        const num = numericCode(chars, i);
        if (num) { if (num[0] === PARA_MARK) spans = true; out += lit(num[0]); i += num[1]; } else out += '\\^';
        break;
      }
      default: out += lit(c);
    }
  }
  return [out, spans];
}

/** {n}, {n,}, {n,m} (and {,m}) (count). */
function count(body) {
  const bad = () => new Error(`{${body}} is not a valid count`);
  const num = s => {
    const t = s.trim();
    if (!t) return null;
    if (!/^\d+$/.test(t)) throw bad();
    const n = Number(t);
    if (n > MAX_COUNT) throw new Error(`counts go up to ${MAX_COUNT}`);
    return n;
  };
  const k = body.search(/[,;]/);
  if (k < 0) { const n = num(body); if (n === null) throw bad(); return `{${n}}`; }
  const a = num(body.slice(0, k)) ?? 0;
  const b = num(body.slice(k + 1));
  if (b !== null && b < a) throw bad();
  return b !== null ? `{${a},${b}}` : `{${a},}`;
}

/** [abc], [a-z], [!x]: the characters inside are literal (class). */
function cls(inner0) {
  let inner = inner0, neg = false;
  if (inner[0] === '!') { neg = true; inner = inner.slice(1); }
  if (!inner.length) throw new Error('[ ] needs at least one character');
  let out = neg ? '[^\\r\\u{1D}' : '[';
  let i = 0;
  while (i < inner.length) {
    let c = inner[i];
    if (c === '\\' && i + 1 < inner.length) { i++; c = inner[i]; }
    i++;
    if (inner[i] === '-' && i + 1 < inner.length) {
      const hi = inner[i + 1];
      if (hi.codePointAt(0) < c.codePointAt(0)) throw new Error(`[${c}-${hi}] is not in ascending order`);
      out += `${litClass(c)}-${litClass(hi)}`;
      i += 2;
    } else out += litClass(c);
  }
  return out + ']';
}

// ---- Replace with -------------------------------------------------------------------------------------

/** Pieces of Replace with text: {lit}, {found}, {group: n}, {named: name}, {clip} (Piece). */
export function parseReplace(withText, o = defaultOpts()) {
  if (o.literal && !o.regex) return [{lit: withText}];
  const chars = [...withText];
  const out = [];
  let cur = '';
  const flush = () => { if (cur) { out.push({lit: cur}); cur = ''; } };
  let i = 0;
  while (i < chars.length) {
    const c = chars[i++];
    if (o.regex && (c === '$' || c === '\\')) {
      const r = regexRef(chars, i, c);
      if (r && r[0].char !== undefined) { cur += r[0].char; i += r[1]; }
      else if (r) { flush(); if (r[0].group) out.push(r[0].group); i += r[1]; }
      else cur += c;
      continue;
    }
    if (c === '\\' && o.wildcards) {
      const n = chars[i];
      if (n !== undefined && /[1-9]/.test(n)) { flush(); out.push({group: Number(n)}); i++; continue; }
      if (n !== undefined) { cur += n; i++; continue; }
    }
    if (c === '^' && !o.literal) {
      const n = chars[i];
      if (n === '&' || n === 'c') { flush(); out.push(n === '&' ? {found: true} : {clip: true}); i++; continue; }
      if (n !== undefined) {
        const rc = replaceCode(n);
        if (rc !== null) { cur += rc; i++; continue; }
        const num = numericCode(chars, i);
        if (num) { cur += num[0]; i += num[1]; continue; }
      }
    }
    cur += c;
  }
  flush();
  return out;
}

/** A group named by its number or name (group_ref). */
const groupRef = name => (/^\d+$/.test(name) ? {group: Number(name)} : {named: name});

/** A regex reference or escape after `c` ($ or \) at chars[i]: [{char}|{group}, used] or null (regex_ref). */
function regexRef(chars, i, c) {
  const next = chars[i];
  if (next === undefined) return null;
  if (c === '\\') {
    if (next === 'n') return [{char: PARA_MARK}, 1];
    if (next === 't') return [{char: '\t'}, 1];
    if (next === '\\' || next === '$' || next === '^') return [{char: next}, 1];
    if (/[1-9]/.test(next)) return [{group: {group: Number(next)}}, 1];
    return null;
  }
  if (next === '$') return [{char: '$'}, 1];
  const rest = chars.slice(i);
  if (next === '{') {
    const close = rest.indexOf('}');
    if (close < 0) return null;
    const name = rest.slice(1, close).join('');
    if (!name) return null;
    return [{group: /^\d+$/.test(name) && name.length > 9 ? null : groupRef(name)}, close + 1];
  }
  let len = 0;
  while (len < rest.length && /[A-Za-z0-9_]/.test(rest[len])) len++;
  if (!len) return null;
  const name = rest.slice(0, len).join('');
  return [{group: /^\d+$/.test(name) && name.length > 9 ? null : groupRef(name)}, len];
}

/** Named group references as numbered ones; unknown names dropped (resolve_names). */
export function resolveNames(pieces, index) {
  const out = [];
  for (const p of pieces) {
    if (p.named !== undefined) { const n = index(p.named); if (n !== null && n !== undefined) out.push({group: n}); } else out.push(p);
  }
  return out;
}

/** Searched text as it is inserted again: marks become paragraph breaks (as_inserted). */
const asInserted = s => s.split(SECT_MARK).join('\r');

/** Fill in Replace with text for one match (expand). */
export function expand(pieces, found, group, clip) {
  let out = '';
  for (const p of pieces) {
    if (p.lit !== undefined) out += p.lit;
    else if (p.found) out += asInserted(found);
    else if (p.group !== undefined) out += asInserted(group(p.group) ?? '');
    else if (p.clip) out += clip.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  }
  return out;
}
