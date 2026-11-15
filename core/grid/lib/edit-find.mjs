// Find and Replace matching for Grid: `*`/`?` wildcards with `~` escapes, Match case, Match
// entire cell contents, and case-insensitive replacement (U:grid/edit; other units may import).
// Translated from gridcraft crates/engine/src/cmd/edit/find.rs (`matches`, `wildcard`,
// `folds_in_place`, `replace_ci`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

/** `*`/`?` wildcard match with `~` escapes (whole text). */
export function wildcard(text, pat) {
  const t = [...text];
  const p = [];
  const it = [...pat];
  for (let i = 0; i < it.length; i++) {
    if (it[i] === '~') { if (i + 1 < it.length) { p.push([it[i + 1], true]); i++; } }
    else p.push([it[i], false]);
  }
  const isStar = q => q && q[0] === '*' && !q[1];
  const isQ = q => q && q[0] === '?' && !q[1];
  let ti = 0, pi = 0, star = -1, mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (isQ(p[pi]) || (p[pi][0] === t[ti] && !isStar(p[pi])))) { ti++; pi++; }
    else if (pi < p.length && isStar(p[pi])) { star = pi; mark = ti; pi++; }
    else if (star >= 0) { pi = star + 1; mark++; ti = mark; }
    else return false;
  }
  while (pi < p.length && isStar(p[pi])) pi++;
  return pi === p.length;
}

/** find.rs `matches`. */
export function matches(hay, what, matchCase, whole) {
  const h = matchCase ? hay : hay.toLowerCase();
  const w = matchCase ? what : what.toLowerCase();
  if (/[*?]/.test(w)) return wildcard(h, whole ? w : `*${w}*`);
  return whole ? h === w : h.includes(w);
}

const utf8Len = cp => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
/** Whether lower-casing keeps every character one character of the same UTF-8 length. */
export function foldsInPlace(s) {
  for (const ch of s) {
    const l = [...ch.toLowerCase()];
    if (l.length !== 1 || utf8Len(l[0].codePointAt(0)) !== utf8Len(ch.codePointAt(0))) return false;
  }
  return true;
}
const utf8Bytes = s => { let n = 0; for (const ch of s) n += utf8Len(ch.codePointAt(0)); return n; };

/** find.rs `replace_ci`: case-insensitive replacement; foldings that move boundaries fall back to case-sensitive. */
export function replaceCi(text, what, withText) {
  const lower = text.toLowerCase();
  const w = what.toLowerCase();
  if (utf8Bytes(lower) !== utf8Bytes(text) || !w || !foldsInPlace(text) || !foldsInPlace(what)) return text.split(what).join(withText);
  let out = '', i = 0;
  for (;;) {
    const pos = lower.indexOf(w, i);
    if (pos < 0) break;
    out += text.slice(i, pos) + withText;
    i = pos + w.length;
  }
  return out + text.slice(i);
}
