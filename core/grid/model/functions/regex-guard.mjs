// Backtracking-risk check for the REGEX* spreadsheet functions.
//
// A cell formula comes from the document, so its pattern is untrusted, and V8 has no step limit:
// REGEXTEST("aaaaaaaaaaaaaaaaaaaaaaaaaaaab", "^(a+)+$") runs for minutes. Before a pattern is
// compiled for use it is parsed here and refused when it can blow up:
//   - a repeated group that contains a repeated or optional part ((a+)+, (a*)*, (a?)*, (a{1,3})+)
//   - a repeated group whose alternatives can start with the same character ((a|a)*, (a|ab)*)
//   - an alternative that can match nothing inside a repeated group ((a|)*)
//   - too many overlapping alternations in a row (2^n)
//   - polynomial blow-up: unbounded repeats ^ (subject length + 1) above a work budget
// Excel's own answer to a pattern it refuses is #VALUE!, which the caller throws.

export const MAX_PATTERN = 1_000;
export const MAX_SUBJECT = 32_767;
const WORK_BUDGET = 2e9;
const MAX_COUNT = 10_000;
const MAX_FINITE_LOOP = 16;
const MAX_OVERLAPPING_ALTERNATIONS = 6;
const PROBE_LIMIT = 0x300;

class Unsafe extends Error {}
const fail = () => { throw new Unsafe('unsafe regex'); };

function parse(p, flags) {
  let i = 0, nodes = 0;
  const tok = src => {
    const re = new RegExp(`^(?:${src})$`, flags);
    return {kind: 'tok', src, test: code => re.test(String.fromCodePoint(code)), any: src === '.', min: 1, max: 1};
  };
  function escapeSource() {
    // p[i] === '\\'; returns the source of the escape and moves past it.
    const start = i++;
    const c = p[i++];
    if (c === undefined) fail();
    if (c === 'x') i += 2;
    else if (c === 'u') { if (p[i] === '{') { const e = p.indexOf('}', i); if (e < 0) fail(); i = e + 1; } else i += 4; }
    else if (c === 'p' || c === 'P') { const e = p.indexOf('}', i); if (e < 0) fail(); i = e + 1; }
    else if (c === 'c') i += 1;
    else if (c === 'k') { const e = p.indexOf('>', i); if (e < 0) fail(); i = e + 1; }
    else if (c >= '1' && c <= '9') while (p[i] >= '0' && p[i] <= '9') i++;
    return {src: p.slice(start, i), c};
  }
  function parseAtom(depth) {
    if (++nodes > 4000) fail();
    const c = p[i];
    if (c === '(') {
      i++;
      let look = false;
      if (p[i] === '?') {
        if (p[i + 1] === ':') i += 2;
        else if (p[i + 1] === '=' || p[i + 1] === '!') { look = true; i += 2; }
        else if (p[i + 1] === '<' && (p[i + 2] === '=' || p[i + 2] === '!')) { look = true; i += 3; }
        else if (p[i + 1] === '<') { const e = p.indexOf('>', i); if (e < 0) fail(); i = e + 1; }
        else fail();
      }
      const alts = parseAlts(depth + 1);
      if (p[i] !== ')') fail();
      i++;
      return {kind: 'group', alts, look, min: 1, max: 1};
    }
    if (c === '[') {
      const start = i++;
      if (p[i] === '^') i++;
      while (i < p.length && p[i] !== ']') i += p[i] === '\\' ? 2 : 1;
      if (i >= p.length) fail();
      i++;
      return tok(p.slice(start, i));
    }
    if (c === '\\') {
      const {src, c: e} = escapeSource();
      if (e === 'b' || e === 'B') return {kind: 'zero', min: 1, max: 1};
      if ((e >= '1' && e <= '9') || e === 'k') return {...tok('(?:[^]|^)'), any: true};
      return tok(src);
    }
    if (c === '.') { i++; return tok('.'); }
    if (c === '^' || c === '$') { i++; return {kind: 'zero', min: 1, max: 1}; }
    if (c === '*' || c === '+' || c === '?' || c === '{' || c === '}' || c === ']') fail();
    const cp = p.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    return tok(String.fromCodePoint(cp).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'));
  }
  function parseQuant(item) {
    const c = p[i];
    let min, max;
    if (c === '*') { min = 0; max = Infinity; i++; }
    else if (c === '+') { min = 1; max = Infinity; i++; }
    else if (c === '?') { min = 0; max = 1; i++; }
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(p.slice(i, i + 40));
      if (!m) fail();
      min = Number(m[1]);
      max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min;
      if (min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT)) fail();
      i += m[0].length;
    } else return;
    if (p[i] === '?') i++;
    item.min = min; item.max = max;
  }
  function parseAlts(depth) {
    if (depth > 24) fail();
    const alts = [[]];
    while (i < p.length) {
      const c = p[i];
      if (c === ')') break;
      if (c === '|') { i++; alts.push([]); continue; }
      const item = parseAtom(depth);
      parseQuant(item);
      alts[alts.length - 1].push(item);
    }
    return alts;
  }
  const alts = parseAlts(0);
  if (i < p.length) fail();
  return alts;
}

/** First characters a sequence can start with: {toks, nullable}. */
function firstOfSeq(seq) {
  const toks = [];
  for (const it of seq) {
    let nullable = it.min === 0;
    if (it.kind === 'tok') toks.push(it);
    else if (it.kind === 'group') {
      for (const alt of it.alts) { const f = firstOfSeq(alt); toks.push(...f.toks); if (f.nullable) nullable = true; }
    } else nullable = true;
    if (!nullable) return {toks, nullable: false};
  }
  return {toks, nullable: true};
}
function tokensOverlap(a, b) {
  if (a.some(t => t.any) && b.length) return true;
  if (b.some(t => t.any) && a.length) return true;
  for (let code = 0; code < PROBE_LIMIT; code++) {
    if (a.some(t => t.test(code)) && b.some(t => t.test(code))) return true;
  }
  return false;
}
function hasAmbiguousRepeat(node) {
  // a repeat that can match a different number of times: it multiplies the ways to split the input.
  if (node.max > node.min && node.max > 0 && node.kind !== 'zero') return true;
  if (node.kind === 'group') return node.alts.some(alt => alt.some(hasAmbiguousRepeat));
  return false;
}

function analyse(alts, ctx) {
  // ctx: {loop: inside a repeated group, mult: product of the finite repeat counts around, st: totals}
  const multi = alts.length > 1;
  if (multi) {
    const firsts = alts.map(firstOfSeq);
    let overlap = false;
    for (let a = 0; a < firsts.length && !overlap; a++) {
      if (firsts[a].nullable && ctx.loop) fail();
      for (let b = a + 1; b < firsts.length; b++) if (tokensOverlap(firsts[a].toks, firsts[b].toks)) { overlap = true; break; }
    }
    if (overlap) {
      if (ctx.loop) fail();
      if (++ctx.st.overlapping > MAX_OVERLAPPING_ALTERNATIONS) fail();
    }
  }
  for (const seq of alts) {
    for (const it of seq) {
      if (it.kind === 'tok' || it.kind === 'group') {
        if (it.max === Infinity) ctx.st.unbounded += ctx.mult;
        else if (it.max > MAX_FINITE_LOOP && it.max > it.min) ctx.st.unbounded += ctx.mult;
      }
      if (it.kind !== 'group') continue;
      const looped = it.max > 1;
      let mult = ctx.mult;
      if (looped) {
        if (it.max === Infinity || it.max > MAX_FINITE_LOOP) {
          if (it.alts.some(alt => alt.some(hasAmbiguousRepeat))) fail();
        } else mult *= it.max;
      }
      analyse(it.alts, {loop: ctx.loop || (looped && (it.max === Infinity || it.max > MAX_FINITE_LOOP)), mult, st: ctx.st});
    }
  }
}

const cache = new Map();
/** Cost class of a pattern: {unbounded} (number of unbounded repeats), or null when it is unsafe. */
function classify(pattern, insensitive) {
  const key = `${insensitive ? 'i' : 's'}:${pattern}`;
  if (cache.has(key)) return cache.get(key);
  let result = null;
  try {
    const st = {unbounded: 0, overlapping: 0};
    analyse(parse(pattern, `u${insensitive ? 'i' : ''}`), {loop: false, mult: 1, st});
    result = {unbounded: st.unbounded};
  } catch { result = null; }
  if (cache.size > 256) cache.clear();
  cache.set(key, result);
  return result;
}

/** True when the pattern is safe to run on a subject of this length (the pattern has already compiled). */
export function isSafeRegex(pattern, subjectLength, insensitive = false) {
  if (pattern.length > MAX_PATTERN || subjectLength > MAX_SUBJECT) return false;
  const c = classify(pattern, insensitive);
  if (!c) return false;
  return c.unbounded === 0 || (subjectLength + 1) ** (c.unbounded + 1) <= WORK_BUDGET;
}
