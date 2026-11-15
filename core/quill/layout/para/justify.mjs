// Justification: space shrinking (Word 2013+), hyphen glyphs, hyphenation points.
//
// Translated from wordcraft crates/layout/src/para/justify.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c), checked against wordcraft 0.13.1 (f2dfa0d). Automatic hyphenation (`hyphenationPoints`
// with `auto`) is the dictionary and pattern hyphenator of upstream's `wordcraft_proof` crate, translated in core/quill/lib/hyphen.mjs.
import {CL} from './model.mjs';
import {hyphenPoints, defaultLimits, isVietnameseWord, looksVietnamese} from '../../lib/hyphen.mjs';

/** Word's default hyphenation zone (0.25"), points. */
export const HYPHENATION_ZONE = 18;
const MAX_SPACE_SHRINK = 0.25;
const MAX_WORD_OVERRUN = 0.355;

/** How far a justified line may run past its edge, its spaces shrinking (space_room). */
export const spaceRoom = (spaces, word) => Math.min(spaces * MAX_SPACE_SHRINK, Math.max(0, word) * MAX_WORD_OVERRUN);

/** Take `-slack` out of the line's inner spaces in proportion to their widths (shrink_line_spaces). */
export function shrinkLineSpaces(pl, xs, c0, c1, contentEnd, slack) {
  const spaces = [];
  for (let k = c0; k < c1; k++) {
    const c = pl.clusters[k];
    if (c && c.kind === CL.SPACE && (xs[k - c0] ?? Infinity) < contentEnd - 0.01) spaces.push([k, c.adv]);
  }
  const total = spaces.reduce((s, v) => s + v[1], 0);
  if (total <= 0 || !Number.isFinite(slack)) return;
  const ratio = Math.max(0, Math.min(MAX_SPACE_SHRINK, -slack / total));
  let take = 0, si = 0;
  for (let k = c0; k < c1; k++) {
    if (k - c0 < xs.length) xs[k - c0] -= take;
    if (spaces[si] && spaces[si][0] === k) { take += spaces[si][1] * ratio; si++; }
  }
  if (xs.length) xs[xs.length - 1] -= take;
}

/** The hyphen drawn at a hyphenation break in a style: {style, adv} (hyphen_glyph), cached per paragraph. */
export function hyphenGlyph(pl, style, cache, shaper) {
  const hit = cache.find(h => h.style === style);
  if (hit) return hit;
  const st = pl.styles[style];
  const adv = st ? shaper.advance('-', st.font) * (st.rc.scale / 100) : 0;
  const h = {style, adv};
  cache.push(h);
  return h;
}

/** The language of the run holding paragraph offset `off` (English past the last run), `runs`: [{from, to, lang}]. */
function langAt(runs, off) {
  for (const r of runs) if (r.from <= off && off < r.to) return r.lang;
  return 'en';
}
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const isAllCaps = w => [...w].filter(c => /\p{Alphabetic}/u.test(c)).every(c => /\p{Uppercase}/u.test(c));

/**
 * Clusters after which a line may end with a hyphen (hyphenation_points): soft hyphens always, and the dictionary or pattern
 * hyphenation points of each word, in the language of its run, when automatic hyphenation is on (`auto`; words in capitals only with
 * `caps`), found in the text as laid out (`text`, mapped to the paragraph by `toPara`).
 */
export function hyphenationPoints(text, toPara, pl, auto = false, caps = true, runs = []) {
  const ends = [];
  for (let i = text.indexOf('­'); i >= 0; i = text.indexOf('­', i + 1)) {
    const e = toPara(i + 1);
    if (e !== null) ends.push(e);
  }
  // Vietnamese words are single syllables and never take a hyphen; the patterns are for Latin-script languages, so Persian and Arabic
  // words are left alone; words in capitals only when the document allows it.
  if (auto && !looksVietnamese(text)) {
    const lim = defaultLimits();
    for (const m of text.matchAll(/[\p{Alphabetic}'\u2019]+/gu)) {
      const w = m[0];
      if ([...w].length < lim.minWord || RTL.test(w) || isVietnameseWord(w) || (!caps && isAllCaps(w))) continue;
      const a = m.index;
      const first = w.codePointAt(0) > 0xFFFF ? 2 : 1;
      const e = toPara(a + first);
      const lang = e === null ? 'en' : langAt(runs, Math.max(0, e - first));
      const offs = [];
      let o = 0;
      for (const c of w) { offs.push(o); o += c.length; }
      for (const pt of hyphenPoints(w, lim, lang)) {
        const at = offs[pt];
        if (at !== undefined) { const q = toPara(a + at); if (q !== null) ends.push(q); }
      }
    }
  }
  if (!ends.length) return [];
  const set = new Set(ends);
  const out = [];
  pl.clusters.forEach((c, i) => { if ((c.kind === CL.TEXT || c.kind === CL.MARKER) && set.has(c.end)) out.push(i); });
  return out;
}
