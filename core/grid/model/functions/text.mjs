// Text functions.
// Translated from gridcraft crates/functions/src/text.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Characters are Unicode code points, as in Rust's `chars()`. The REGEX* functions use the host's
// regular-expression engine (ECMAScript), where upstream uses the Rust `regex` crate; patterns
// valid in both behave the same.

import {CellError, ERR, GArray, numberToText, toText, toFixedExact} from '../../lib/value.mjs';
import {parseNumberTextIn} from '../../lib/parse.mjs';
import {wildcardFind} from './criteria.mjs';
import {isSafeRegex} from './regex-guard.mjs';
import {f, register, VAR, S, A, MAX_CELLS, MAX_TEXT, arg, asArray, arrayVal, boolean, has, int, num, numVal, optBool, optInt, optNum, roundHalfAway, scalar, text, ok} from './registry.mjs';

const TJ = [false, true, false], TB = [true, false, true, true, true, false], TS = [true, false, false, true, true, false], ATT = [false, true];
const chars = s => [...s];
function checkLen(s) { if (s.length > MAX_TEXT && [...s].length > MAX_TEXT) throw ERR.Value; return s; }
function pushCapped(out, piece) { const r = out + piece; if (r.length > MAX_TEXT * 4) throw ERR.Value; return r; }

function concatenate(a) { let out = ''; for (const x of a) out = pushCapped(out, ok(toText(scalar(x)))); return checkLen(out); }
function concat(a) { let out = ''; for (const x of a) for (const v of asArray(x.value).data) out = pushCapped(out, ok(toText(v))); return checkLen(out); }
function textjoin(a) {
  const delims = asArray(arg(a, 0).value).data.map(v => ok(toText(v)));
  const ignore = boolean(a, 1);
  const items = [];
  for (const x of a.slice(2)) for (const v of asArray(x.value).data) { const s = ok(toText(v)); if (!(ignore && s === '')) items.push(s); }
  let out = '';
  items.forEach((s, i) => { if (i > 0 && delims.length) out = pushCapped(out, delims[(i - 1) % delims.length]); out = pushCapped(out, s); });
  return checkLen(out);
}
function countArg(a, i, d) {
  const n = optNum(a, i, d);
  if (n < 0 || Number.isNaN(n)) throw ERR.Value;
  return n > 1e9 ? 1_000_000_000 : Math.trunc(n);
}
const left = a => { const s = chars(text(a, 0)); return s.slice(0, countArg(a, 1, 1)).join(''); };
const right = a => { const s = chars(text(a, 0)); const n = Math.min(countArg(a, 1, 1), s.length); return s.slice(s.length - n).join(''); };
function mid(a) {
  const s = chars(text(a, 0));
  const start = num(a, 1);
  if (Number.isNaN(start) || start < 1) throw ERR.Value;
  const n = countArg(a, 2, 0);
  const st = start > 1e9 ? 1_000_000_000 : Math.trunc(start);
  return s.slice(st - 1, st - 1 + n).join('');
}
function proper(a) {
  let out = '', prev = false;
  for (const ch of text(a, 0)) {
    if (/\p{Alphabetic}/u.test(ch)) { out += prev ? ch.toLowerCase() : ch.toUpperCase(); prev = true; }
    else { out += ch; prev = false; }
  }
  return out;
}
const trim = a => text(a, 0).split(' ').filter(Boolean).join(' ');
const clean = a => chars(text(a, 0)).filter(c => c.codePointAt(0) >= 32).join('');
function substitute(a) {
  const s = text(a, 0), old = text(a, 1), nw = text(a, 2);
  if (old === '') return s;
  if (has(a, 3)) {
    const inst = num(a, 3);
    if (Number.isNaN(inst) || inst < 1) throw ERR.Value;
    let pos = -1, from = 0;
    for (let k = 0; k < Math.trunc(inst); k++) { pos = s.indexOf(old, from); if (pos < 0) break; from = pos + old.length; }
    return pos < 0 ? s : checkLen(s.slice(0, pos) + nw + s.slice(pos + old.length));
  }
  const parts = s.split(old);
  if (nw.length > old.length && s.length + (parts.length - 1) * (nw.length - old.length) > MAX_TEXT * 4) throw ERR.Value;
  return checkLen(parts.join(nw));
}
function replace(a) {
  const s = chars(text(a, 0));
  const start = num(a, 1);
  if (Number.isNaN(start) || start < 1) throw ERR.Value;
  const n = countArg(a, 2, 0), nw = text(a, 3);
  const st = Math.min((start > 1e9 ? 1_000_000_000 : Math.trunc(start)) - 1, s.length);
  const en = Math.min(st + n, s.length);
  return checkLen(s.slice(0, st).join('') + nw + s.slice(en).join(''));
}
function rept(a) {
  const s = text(a, 0), n = num(a, 1);
  if (Number.isNaN(n) || n < 0) throw ERR.Value;
  const k = Math.trunc(n);
  if ([...s].length * k > MAX_TEXT) throw ERR.Value;
  return s.repeat(k);
}
function findImpl(a, wild) {
  const needle = text(a, 0), hay = text(a, 1), start = optNum(a, 2, 1);
  const hc = chars(hay);
  if (Number.isNaN(start) || start < 1 || start > Math.max(hc.length, 1)) throw ERR.Value;
  const st = Math.trunc(start) - 1;
  if (needle === '') return st + 1;
  let pos = null;
  if (wild) pos = wildcardFind(needle, hay, st);
  else {
    const nc = chars(needle);
    outer: for (let i = st; i + nc.length <= hc.length; i++) {
      for (let j = 0; j < nc.length; j++) if (hc[i + j] !== nc[j]) continue outer;
      pos = i; break;
    }
  }
  if (pos === null) throw ERR.Value;
  return pos + 1;
}
const CP1252 = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F, 0x90, 0x2018, 0x2019,
  0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
function charFn(a) {
  const n = Math.trunc(num(a, 0));
  if (!(n >= 1 && n <= 255)) throw ERR.Value;
  return String.fromCodePoint(n >= 128 && n < 160 ? CP1252[n - 128] : n);
}
function code(a) {
  const s = text(a, 0);
  if (!s) throw ERR.Value;
  const cp = s.codePointAt(0);
  if (cp < 128 || (cp >= 160 && cp < 256)) return cp;
  const i = CP1252.indexOf(cp);
  return i >= 0 ? 128 + i : 63;
}
function unichar(a) {
  const n = Math.trunc(num(a, 0));
  if (!(n >= 1 && n <= 1_114_111)) throw ERR.Value;
  if (n >= 0xd800 && n <= 0xdfff) throw ERR.NA;
  return String.fromCodePoint(n);
}
function unicode(a) { const s = text(a, 0); if (!s) throw ERR.Value; return s.codePointAt(0); }
function value(a, c) {
  const v = scalar(arg(a, 0));
  if (typeof v === 'number') return numVal(v);
  if (v === null || v === undefined) return 0;
  if (v instanceof CellError) throw v;
  if (typeof v === 'string') { const n = parseNumberTextIn(v, c.dateSystem()); if (n === null) throw ERR.Value; return numVal(n); }
  throw ERR.Value;
}
function numbervalue(a, c) {
  const s = text(a, 0);
  const dec = a.length > 1 ? [...text(a, 1)][0] : '.';
  const grp = a.length > 2 ? [...text(a, 2)][0] : ',';
  if (dec === undefined || grp === undefined || dec === grp) throw ERR.Value;
  let body = chars(s).filter(ch => !/\s/u.test(ch)).join('');
  if (!body) return 0;
  let pct = 0;
  while (body.endsWith('%')) { body = body.slice(0, -1); pct++; }
  let seenDec = false, out = '';
  for (const ch of body) {
    if (ch === dec) { if (seenDec) throw ERR.Value; seenDec = true; out += '.'; }
    else if (ch === grp) { if (seenDec) throw ERR.Value; }
    else if (ch === '.' || ch === ',') throw ERR.Value;
    else out += ch;
  }
  let n = parseNumberTextIn(out, c.dateSystem());
  if (n === null) throw ERR.Value;
  for (let i = 0; i < pct; i++) n /= 100;
  return numVal(n);
}
function formatFixed(x, decimals, commas) {
  const s = toFixedExact(Math.abs(x), Math.max(0, decimals));
  const [intPart, frac] = s.split('.');
  const ip = commas ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
  return frac !== undefined ? `${ip}.${frac}` : ip;
}
function rounded(a, dd) {
  const x = num(a, 0);
  const d0 = Math.trunc(optNum(a, 1, dd));
  if (d0 > 127) throw ERR.Value;
  const d = Math.max(d0, -308);
  const r = roundHalfAway(x, d);
  if (!Number.isFinite(r) || Math.abs(r) >= 1e300) throw ERR.Num;
  return [r, d];
}
function fixed(a) { const [r, d] = rounded(a, 2); const body = formatFixed(r, d, !optBool(a, 2, false)); return r < 0 ? `-${body}` : body; }
function dollar(a) { const [r, d] = rounded(a, 2); const body = formatFixed(r, d, true); return r < 0 ? `($${body})` : `$${body}`; }

// BAHTTEXT
const THAI_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const THAI_PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
function thaiGroup(digits, after) {
  const n = digits.length;
  const higher = after || digits.slice(0, Math.max(0, n - 1)).some(d => d !== 0);
  let out = '';
  digits.forEach((d, i) => {
    const place = n - 1 - i;
    if (d === 0) return;
    if (place === 0 && d === 1 && higher) out += 'เอ็ด';
    else if (place === 1 && d === 1) out += 'สิบ';
    else if (place === 1 && d === 2) out += 'ยี่สิบ';
    else out += THAI_DIGITS[d] + THAI_PLACES[place];
  });
  return out;
}
function thaiNumber(digits) {
  const d = [...digits].filter(c => c >= '0' && c <= '9').map(Number);
  while (d.length && d[0] === 0) d.shift();
  if (!d.length) return 'ศูนย์';
  let out = '', start = 0, len = d.length % 6 || 6;
  while (start + len <= d.length) {
    out += thaiGroup(d.slice(start, start + len), start > 0);
    start += len; len = 6;
    if (start < d.length) out += 'ล้าน';
  }
  return out;
}
function bahttext(a) {
  const x = roundHalfAway(num(a, 0), 2);
  if (!Number.isFinite(x)) throw ERR.Num;
  const [whole, frac] = Math.abs(x).toFixed(2).split('.');
  const baht = /[1-9]/.test(whole), satang = /[1-9]/.test(frac);
  let out = x < 0 && (baht || satang) ? 'ลบ' : '';
  if (baht || !satang) out += thaiNumber(whole) + 'บาท';
  out += satang ? thaiNumber(frac) + 'สตางค์' : 'ถ้วน';
  return out;
}
function tFn(a) { const v = scalar(arg(a, 0)); if (typeof v === 'string') return v; if (v instanceof CellError) throw v; return ''; }

// TEXTBEFORE / TEXTAFTER / TEXTSPLIT
const fold = cs => cs.map(ch => [...ch.toLowerCase()][0] ?? ch);
const delimiters = v => asArray(v).data.map(d => chars(ok(toText(d))));
const eqAt = (t, i, d) => { if (i < 0 || i + d.length > t.length) return false; for (let k = 0; k < d.length; k++) if (t[i + k] !== d[k]) return false; return true; };
function findMatches(textCs, delims, insensitive, fromEnd) {
  const t = insensitive ? fold(textCs) : textCs;
  const ds = delims.filter(d => d.length).map(d => (insensitive ? fold(d) : d));
  if (!ds.length) return Array.from({length: t.length + 1}, (_, i) => [i, i]);
  const out = [];
  if (fromEnd) {
    let j = t.length;
    while (j > 0) {
      let best = 0;
      for (const d of ds) if (j - d.length >= 0 && eqAt(t, j - d.length, d)) best = Math.max(best, d.length);
      if (best) { out.push([j - best, j]); j -= best; } else j--;
    }
    return out.reverse();
  }
  let i = 0;
  while (i < t.length) {
    let best = 0;
    for (const d of ds) if (eqAt(t, i, d)) best = Math.max(best, d.length);
    if (best) { out.push([i, i + best]); i += best; } else i++;
  }
  return out;
}
function textBeforeAfter(a, before) {
  const s = chars(text(a, 0));
  const delims = delimiters(arg(a, 1).value);
  const inst = has(a, 2) ? int(a, 2) : 1;
  const mode = optInt(a, 3, 0);
  const matchEnd = optBool(a, 4, false);
  if (!(mode === 0 || mode === 1) || inst === 0 || Math.abs(inst) > Math.max(s.length, 1)) throw ERR.Value;
  const m = findMatches(s, delims, mode === 1, inst < 0);
  if (matchEnd) {
    if (inst > 0) { if (!m.length || m[m.length - 1][0] !== s.length) m.push([s.length, s.length]); }
    else if (!m.length || m[0][0] !== 0) m.unshift([0, 0]);
  }
  const k = Math.abs(inst);
  const hit = inst > 0 ? m[k - 1] : m[m.length - k];
  if (hit) return before ? s.slice(0, hit[0]).join('') : s.slice(hit[1]).join('');
  if (a[5]) return scalar(a[5]);
  throw ERR.NA;
}
function splitBy(s, delims, insensitive) {
  if (delims.every(d => !d.length)) return [s];
  const out = [];
  let last = 0;
  for (const [st, en] of findMatches(s, delims, insensitive, false)) { out.push(s.slice(last, st)); last = en; }
  out.push(s.slice(last));
  return out;
}
function textsplit(a) {
  const s = chars(text(a, 0));
  const colD = has(a, 1) ? delimiters(arg(a, 1).value) : [];
  const rowD = has(a, 2) ? delimiters(arg(a, 2).value) : [];
  if (colD.every(d => !d.length) && rowD.every(d => !d.length)) throw ERR.Value;
  const ignore = optBool(a, 3, false), mode = optInt(a, 4, 0);
  if (!(mode === 0 || mode === 1)) throw ERR.Value;
  const pad = has(a, 5) ? scalar(arg(a, 5)) : ERR.NA;
  const rows = [];
  for (const r of splitBy(s, rowD, mode === 1)) {
    if (ignore && !r.length) continue;
    const cells = splitBy(r, colD, mode === 1).filter(c => !(ignore && !c.length)).map(c => c.join(''));
    if (ignore && !cells.length) continue;
    rows.push(cells);
  }
  if (!rows.length) throw ERR.Calc;
  const ncols = Math.max(1, ...rows.map(r => r.length));
  if (rows.length * ncols > MAX_CELLS) throw ERR.Num;
  const data = [];
  for (const r of rows) { data.push(...r); for (let i = r.length; i < ncols; i++) data.push(pad); }
  return arrayVal(rows.length, ncols, data);
}
function valueText(v, strict) {
  if (typeof v === 'string') return strict ? `"${v.replace(/"/g, '""')}"` : v;
  if (v instanceof CellError) return v.text;
  if (typeof v === 'number') return numberToText(v);
  const t = toText(v);
  return typeof t === 'string' ? t : '';
}
function formatArg(a, i) { const m = optInt(a, i, 0); if (m === 0) return false; if (m === 1) return true; throw ERR.Value; }
function arraytotext(a) {
  const strict = formatArg(a, 1), arr = asArray(arg(a, 0).value);
  let out = strict ? '{' : '';
  for (let r = 0; r < arr.rows; r++) for (let c = 0; c < arr.cols; c++) {
    if (r > 0 && c === 0) out += strict ? ';' : ', ';
    else if (c > 0) out += strict ? ',' : ', ';
    out = pushCapped(out, valueText(arr.get(r, c) ?? null, strict));
  }
  return checkLen(strict ? out + '}' : out);
}
// The pattern comes from the document, so a pattern that can backtrack without bound (or a subject
// too long for it) is refused with #VALUE! before it ever runs (regex-guard.mjs).
function buildRegex(pattern, insensitive, global = false, subject = '') {
  let re;
  try { re = new RegExp(pattern, `u${insensitive ? 'i' : ''}${global ? 'g' : ''}`); } catch { throw ERR.Value; }
  if (!isSafeRegex(pattern, subject.length, insensitive)) throw ERR.Value;
  return re;
}
const caseArg = (a, i) => formatArg(a, i);
const regextest = a => { const s = text(a, 0); return buildRegex(text(a, 1), caseArg(a, 2), false, s).test(s); };
function regexextract(a) {
  const s = text(a, 0), mode = optInt(a, 2, 0);
  if (mode === 0) { const m = buildRegex(text(a, 1), caseArg(a, 3), false, s).exec(s); if (!m) throw ERR.NA; return m[0]; }
  if (mode === 1) {
    const all = [...s.matchAll(buildRegex(text(a, 1), caseArg(a, 3), true, s))].slice(0, 1_000_000).map(m => m[0]);
    if (!all.length) throw ERR.NA;
    return arrayVal(all.length, 1, all);
  }
  if (mode === 2) {
    const m = buildRegex(text(a, 1), caseArg(a, 3), false, s).exec(s);
    if (!m) throw ERR.NA;
    if (m.length <= 1) return m[0];
    const groups = m.slice(1).map(g => g ?? '');
    return arrayVal(1, groups.length, groups);
  }
  throw ERR.Value;
}
function expandTemplate(rep, m) {
  return rep.replace(/\$(\$|\{([^}]*)\}|(\d+)|([A-Za-z_][A-Za-z0-9_]*))/g, (all, _x, braced, idx, name) => {
    if (all === '$$') return '$';
    const key = braced ?? idx ?? name;
    if (/^\d+$/.test(key)) return m[Number(key)] ?? '';
    return m.groups?.[key] ?? '';
  });
}
function regexreplace(a) {
  const s = text(a, 0), rep = text(a, 2), occ = optInt(a, 3, 0);
  const re = buildRegex(text(a, 1), caseArg(a, 4), true, s);
  const limit = MAX_TEXT * 4;
  const matches = [...s.matchAll(re)];
  const pick = occ === 0 ? matches : occ > 0 ? [matches[occ - 1]].filter(Boolean) : [matches[matches.length + occ]].filter(Boolean);
  let out = '', last = 0;
  for (const m of pick) {
    out += s.slice(last, m.index);
    const piece = expandTemplate(rep, m);
    if (out.length + piece.length > limit) throw ERR.Value;
    out += piece;
    last = m.index + m[0].length;
  }
  out += s.slice(last);
  return checkLen(out);
}

register([
  f('CONCATENATE', 1, VAR, 'Text', S, 'CONCATENATE(text1, [text2], ...)', 'Joins several text values into one.', concatenate),
  f('CONCAT', 1, VAR, 'Text', A, 'CONCAT(text1, [text2], ...)', 'Joins text from values and every cell of ranges, without a separator.', concat),
  f('TEXTJOIN', 3, VAR, 'Text', TJ, 'TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)', 'Joins text from values and ranges with a delimiter, optionally skipping empty items.', textjoin),
  f('LEFT', 1, 2, 'Text', S, 'LEFT(text, [num_chars])', 'Returns the first characters of a text.', left),
  f('LEFTB', 1, 2, 'Text', S, 'LEFTB(text, [num_bytes])', 'Byte version of LEFT (same as LEFT for single-byte text).', left),
  f('RIGHT', 1, 2, 'Text', S, 'RIGHT(text, [num_chars])', 'Returns the last characters of a text.', right),
  f('RIGHTB', 1, 2, 'Text', S, 'RIGHTB(text, [num_bytes])', 'Byte version of RIGHT (same as RIGHT for single-byte text).', right),
  f('MID', 3, 3, 'Text', S, 'MID(text, start_num, num_chars)', 'Returns characters from the middle of a text.', mid),
  f('MIDB', 3, 3, 'Text', S, 'MIDB(text, start_num, num_bytes)', 'Byte version of MID (same as MID for single-byte text).', mid),
  f('LEN', 1, 1, 'Text', S, 'LEN(text)', 'Counts the characters in a text.', a => [...text(a, 0)].length),
  f('LENB', 1, 1, 'Text', S, 'LENB(text)', 'Byte version of LEN (same as LEN for single-byte text).', a => [...text(a, 0)].length),
  f('LOWER', 1, 1, 'Text', S, 'LOWER(text)', 'Converts text to lower case.', a => text(a, 0).toLowerCase()),
  f('UPPER', 1, 1, 'Text', S, 'UPPER(text)', 'Converts text to upper case.', a => text(a, 0).toUpperCase()),
  f('PROPER', 1, 1, 'Text', S, 'PROPER(text)', 'Capitalises the first letter of each word and lower-cases the rest.', proper),
  f('TRIM', 1, 1, 'Text', S, 'TRIM(text)', 'Removes leading and trailing spaces and collapses runs of spaces to one.', trim),
  f('CLEAN', 1, 1, 'Text', S, 'CLEAN(text)', 'Removes non-printable control characters from text.', clean),
  f('SUBSTITUTE', 3, 4, 'Text', S, 'SUBSTITUTE(text, old_text, new_text, [instance_num])', 'Replaces occurrences of one text with another, optionally only a given occurrence.', substitute),
  f('REPLACE', 4, 4, 'Text', S, 'REPLACE(old_text, start_num, num_chars, new_text)', 'Replaces part of a text by position.', replace),
  f('REPLACEB', 4, 4, 'Text', S, 'REPLACEB(old_text, start_num, num_bytes, new_text)', 'Byte version of REPLACE.', replace),
  f('REPT', 2, 2, 'Text', S, 'REPT(text, number_times)', 'Repeats a text a given number of times.', rept),
  f('FIND', 2, 3, 'Text', S, 'FIND(find_text, within_text, [start_num])', 'Finds the position of one text in another (case-sensitive).', a => findImpl(a, false)),
  f('FINDB', 2, 3, 'Text', S, 'FINDB(find_text, within_text, [start_num])', 'Byte version of FIND.', a => findImpl(a, false)),
  f('SEARCH', 2, 3, 'Text', S, 'SEARCH(find_text, within_text, [start_num])', 'Finds the position of one text in another, ignoring case and allowing wildcards.', a => findImpl(a, true)),
  f('SEARCHB', 2, 3, 'Text', S, 'SEARCHB(find_text, within_text, [start_num])', 'Byte version of SEARCH.', a => findImpl(a, true)),
  f('EXACT', 2, 2, 'Text', S, 'EXACT(text1, text2)', 'TRUE when two texts are identical, including case.', a => text(a, 0) === text(a, 1)),
  f('CHAR', 1, 1, 'Text', S, 'CHAR(number)', 'Returns the character for a code from the Windows-1252 character set.', charFn),
  f('CODE', 1, 1, 'Text', S, 'CODE(text)', 'Returns the Windows-1252 code of the first character of a text.', code),
  f('UNICHAR', 1, 1, 'Text', S, 'UNICHAR(number)', 'Returns the character for a Unicode code point.', unichar),
  f('UNICODE', 1, 1, 'Text', S, 'UNICODE(text)', 'Returns the Unicode code point of the first character of a text.', unicode),
  f('VALUE', 1, 1, 'Text', S, 'VALUE(text)', 'Converts text that looks like a number, date or time into a number.', value),
  f('NUMBERVALUE', 1, 3, 'Text', S, 'NUMBERVALUE(text, [decimal_separator], [group_separator])', 'Converts text to a number using the given decimal and group separators.', numbervalue),
  f('FIXED', 1, 3, 'Text', S, 'FIXED(number, [decimals], [no_commas])', 'Rounds a number and formats it as text with fixed decimals and optional thousands separators.', fixed),
  f('DOLLAR', 1, 2, 'Text', S, 'DOLLAR(number, [decimals])', 'Formats a number as currency text.', dollar),
  f('USDOLLAR', 1, 2, 'Compatibility', S, 'USDOLLAR(number, [decimals])', 'Formats a number as currency text, like DOLLAR.', dollar),
  f('BAHTTEXT', 1, 1, 'Text', S, 'BAHTTEXT(number)', 'Spells out a number in Thai words with Baht.', bahttext),
  f('T', 1, 1, 'Text', S, 'T(value)', 'Returns the value if it is text, otherwise empty text.', tFn),
  f('TEXTBEFORE', 2, 6, 'Text', TB, 'TEXTBEFORE(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])', 'Returns the text that comes before a delimiter.', a => textBeforeAfter(a, true)),
  f('TEXTAFTER', 2, 6, 'Text', TB, 'TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])', 'Returns the text that comes after a delimiter.', a => textBeforeAfter(a, false)),
  f('TEXTSPLIT', 2, 6, 'Text', TS, 'TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with])', 'Splits text into a grid of columns and rows at the given delimiters.', textsplit),
  f('VALUETOTEXT', 1, 2, 'Text', S, 'VALUETOTEXT(value, [format])', 'Converts any value to text, optionally in strict (quoted) form.', a => checkLen(valueText(scalar(arg(a, 0)), formatArg(a, 1)))),
  f('ARRAYTOTEXT', 1, 2, 'Text', ATT, 'ARRAYTOTEXT(array, [format])', 'Converts an array to text, either as a comma list or as a strict array constant.', arraytotext),
  f('REGEXTEST', 2, 3, 'Text', S, 'REGEXTEST(text, pattern, [case_sensitivity])', 'TRUE when a regular expression matches somewhere in the text.', regextest),
  f('REGEXEXTRACT', 2, 4, 'Text', S, 'REGEXEXTRACT(text, pattern, [return_mode], [case_sensitivity])', 'Extracts the first match, all matches or the capture groups of a regular expression.', regexextract),
  f('REGEXREPLACE', 3, 5, 'Text', S, 'REGEXREPLACE(text, pattern, replacement, [occurrence], [case_sensitivity])', 'Replaces matches of a regular expression, all of them or a chosen occurrence.', regexreplace),
  f('ASC', 1, 1, 'Text', S, 'ASC(text)', 'Converts full-width characters to half-width (no change for single-byte text).', a => text(a, 0)),
  f('DBCS', 1, 1, 'Text', S, 'DBCS(text)', 'Converts half-width characters to full-width (no change in this locale).', a => text(a, 0)),
  f('JIS', 1, 1, 'Text', S, 'JIS(text)', 'Converts half-width characters to full-width (no change in this locale).', a => text(a, 0)),
  f('PHONETIC', 1, 1, 'Text', S, 'PHONETIC(reference)', 'Returns the phonetic (furigana) text; here the text itself.', a => text(a, 0)),
]);
