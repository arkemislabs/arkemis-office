// Bidirectional text: embedding levels (UAX #9), visual order, line reordering.
//
// Translated from wordcraft crates/layout/src/para/bidi.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Upstream takes the levels from the `unicode-bidi`
// crate; here `bidiLevels` implements UAX #9 for one paragraph: the bidi classes of the
// characters Word documents use (strong L/R/AL, numbers EN/AN, separators ES/ET/CS, NSM, BN,
// B/S/WS/ON), the isolate and embedding controls (X1-X10 with the 125-level stack), weak types
// (W1-W7), neutrals (N1-N2) and implicit levels (I1-I2). Levels are per UTF-16 unit.

const R_RANGES = [[0x0590, 0x05ff], [0x07c0, 0x085f], [0xfb1d, 0xfb4f], [0x10800, 0x10cff], [0x10d40, 0x10eff], [0x1e800, 0x1ec6f], [0x1ed00, 0x1edff]];
const AL_RANGES = [[0x0600, 0x07bf], [0x0860, 0x08ff], [0xfb50, 0xfdcf], [0xfdf0, 0xfdff], [0xfe70, 0xfeff], [0x10d00, 0x10d3f], [0x10f30, 0x10f6f],
  [0x1ec70, 0x1ecbf], [0x1ee00, 0x1eeff]];
const NSM_RANGES = [[0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7],
  [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0711, 0x0711],
  [0x0730, 0x074a], [0x07a6, 0x07b0], [0x07eb, 0x07f3], [0x0816, 0x0819], [0x081b, 0x0823], [0x0825, 0x0827], [0x0829, 0x082d], [0x0859, 0x085b],
  [0x08d3, 0x08e1], [0x08e3, 0x0902], [0x093a, 0x093a], [0x093c, 0x093c], [0x0941, 0x0948], [0x094d, 0x094d], [0x0951, 0x0957], [0x0962, 0x0963],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f]];
const inRanges = (c, rs) => {
  let lo = 0, hi = rs.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c < rs[m][0]) hi = m - 1; else if (c > rs[m][1]) lo = m + 1; else return true; }
  return false;
};
const LETTER = /\p{L}|\p{Mc}/u;

/** The bidi class of code point `c` (UAX #9 Table 4, for the classes layout tells apart). */
export function bidiClass(c) {
  if (c < 0x80) {
    if (c >= 0x30 && c <= 0x39) return 'EN';
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return 'L';
    if (c === 0x2b || c === 0x2d) return 'ES';
    if (c === 0x23 || c === 0x24 || c === 0x25) return 'ET';
    if (c === 0x2c || c === 0x2e || c === 0x2f || c === 0x3a) return 'CS';
    if (c === 0x0a || c === 0x0d || c === 0x1c || c === 0x1d || c === 0x1e) return 'B';
    if (c === 0x09 || c === 0x0b || c === 0x1f) return 'S';
    if (c === 0x0c || c === 0x20) return 'WS';
    if (c < 0x20 || c === 0x7f) return 'BN';
    return 'ON';
  }
  switch (c) {
    case 0x200e: return 'LRM'; case 0x200f: return 'RLM'; case 0x061c: return 'ALM';
    case 0x202a: return 'LRE'; case 0x202b: return 'RLE'; case 0x202c: return 'PDF'; case 0x202d: return 'LRO'; case 0x202e: return 'RLO';
    case 0x2066: return 'LRI'; case 0x2067: return 'RLI'; case 0x2068: return 'FSI'; case 0x2069: return 'PDI';
    case 0x00a0: case 0x2007: case 0x202f: return 'CS';
    case 0x00a2: case 0x00a3: case 0x00a4: case 0x00a5: case 0x00b0: case 0x00b1: case 0x2030: case 0x2031: case 0x2032: case 0x2033:
    case 0x20ac: case 0x20b9: case 0x2212: case 0x066a: return 'ET';
    case 0x00b2: case 0x00b3: case 0x00b9: return 'EN';
    case 0x060c: case 0x066c: return 'CS';
    case 0x066b: return 'AN';
    case 0x2028: return 'WS'; case 0x2029: return 'B'; case 0x0085: return 'B';
    case 0x00ad: case 0x200b: case 0x200c: case 0x200d: case 0x2060: case 0xfeff: return 'BN';
    case 0xfffc: return 'ON';
    default: break;
  }
  if (c >= 0x0660 && c <= 0x0669) return 'AN';
  if (c >= 0x06f0 && c <= 0x06f9) return 'EN';
  if (c >= 0x0600 && c <= 0x0605) return 'AN';
  if (c >= 0x2000 && c <= 0x200a) return 'WS';
  if (c === 0x3000) return 'WS';
  if (c >= 0x2070 && c <= 0x2079 && c !== 0x2071 && c !== 0x2072 && c !== 0x2073) return 'EN';
  if (c >= 0x2080 && c <= 0x2089) return 'EN';
  if (c >= 0xff10 && c <= 0xff19) return 'EN';
  if (inRanges(c, NSM_RANGES)) return 'NSM';
  if (inRanges(c, AL_RANGES)) return 'AL';
  if (inRanges(c, R_RANGES)) return 'R';
  if (LETTER.test(String.fromCodePoint(c))) return 'L';
  if (c >= 0x2e80) return 'L'; // CJK and later scripts are strong left to right
  return 'ON';
}

/** Strong direction of `c`: true (R, AL), false (L) or null (strong_rtl). */
export function strongRtl(c) {
  const k = bidiClass(c);
  return k === 'R' || k === 'AL' ? true : k === 'L' ? false : null;
}
/** A right-to-left character: one that makes a paragraph need the bidi algorithm. */
export const isRtlChar = c => { const k = bidiClass(c); return k === 'R' || k === 'AL' || k === 'RLE' || k === 'RLO' || k === 'RLI' || k === 'AN'; };

const isIsolateInit = k => k === 'LRI' || k === 'RLI' || k === 'FSI';
const isRemovedX9 = k => k === 'LRE' || k === 'RLE' || k === 'LRO' || k === 'RLO' || k === 'PDF' || k === 'BN';
const isNI = k => k === 'B' || k === 'S' || k === 'WS' || k === 'ON' || k === 'LRI' || k === 'RLI' || k === 'FSI' || k === 'PDI';
const MAX_DEPTH = 125;

/**
 * Embedding level of each UTF-16 unit of `text` (bidi_levels). Empty when the paragraph is
 * left to right and has no right-to-left text.
 */
export function bidiLevels(text, rtlPara) {
  const n = text.length;
  const cls = new Array(n);
  let any = rtlPara;
  for (let i = 0; i < n; i++) {
    const c = text.codePointAt(i);
    const k = bidiClass(c);
    cls[i] = k;
    if (c > 0xffff) { cls[i + 1] = k; i++; }
    if (!any && (k === 'R' || k === 'AL' || k === 'RLE' || k === 'RLO' || k === 'RLI' || k === 'AN')) any = true;
  }
  if (!any) return [];
  const base = rtlPara ? 1 : 0;
  const levels = new Array(n).fill(base);
  const types = cls.slice();
  // X1-X8: explicit embeddings, overrides and isolates.
  const stack = [{level: base, override: null, isolate: false}];
  let overflowIsolates = 0, overflowEmbeddings = 0, validIsolates = 0;
  const nextOdd = l => (l + 1) | 1;
  const nextEven = l => (l + 2) & ~1;
  for (let i = 0; i < n; i++) {
    const k = cls[i];
    const top = stack[stack.length - 1];
    if (k === 'RLE' || k === 'LRE' || k === 'RLO' || k === 'LRO') {
      const lvl = k === 'RLE' || k === 'RLO' ? nextOdd(top.level) : nextEven(top.level);
      levels[i] = top.level;
      if (lvl <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
        stack.push({level: lvl, override: k === 'RLO' ? 'R' : k === 'LRO' ? 'L' : null, isolate: false});
      } else if (overflowIsolates === 0) overflowEmbeddings++;
    } else if (isIsolateInit(k)) {
      levels[i] = top.level;
      if (top.override) types[i] = top.override;
      let rtl = k === 'RLI';
      if (k === 'FSI') rtl = firstStrong(cls, i + 1) === true;
      const lvl = rtl ? nextOdd(top.level) : nextEven(top.level);
      if (lvl <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
        validIsolates++;
        stack.push({level: lvl, override: null, isolate: true});
      } else overflowIsolates++;
    } else if (k === 'PDI') {
      if (overflowIsolates > 0) overflowIsolates--;
      else if (validIsolates > 0) {
        overflowEmbeddings = 0;
        while (stack.length > 1 && !stack[stack.length - 1].isolate) stack.pop();
        stack.pop();
        validIsolates--;
      }
      const t = stack[stack.length - 1];
      levels[i] = t.level;
      if (t.override) types[i] = t.override;
    } else if (k === 'PDF') {
      levels[i] = top.level;
      if (overflowIsolates > 0) { /* nothing */ } else if (overflowEmbeddings > 0) overflowEmbeddings--;
      else if (!top.isolate && stack.length >= 2) stack.pop();
    } else if (k === 'B') {
      levels[i] = base;
    } else {
      levels[i] = top.level;
      if (top.override && k !== 'BN') types[i] = top.override;
    }
  }
  // X9: removed characters take the level of what they follow; they're skipped by W/N rules.
  const idx = [];
  for (let i = 0; i < n; i++) if (!isRemovedX9(cls[i]) && types[i] !== undefined) idx.push(i);
  // X10: level runs, chained into isolating run sequences (approximation: per level run, isolates
  // connected through matching PDI as UAX #9 BD13 says).
  const runs = [];
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const last = runs[runs.length - 1];
    if (last && levels[last[last.length - 1]] === levels[i]) last.push(i); else runs.push([i]);
  }
  const seqs = [];
  const used = new Set();
  for (let r = 0; r < runs.length; r++) {
    if (used.has(r)) continue;
    let seq = runs[r].slice();
    used.add(r);
    let cur = r;
    while (isIsolateInit(cls[runs[cur][runs[cur].length - 1]])) {
      const open = runs[cur][runs[cur].length - 1];
      const close = matchingPdi(cls, open);
      if (close < 0) break;
      const nr = runs.findIndex((run, q) => q > cur && run[0] === close);
      if (nr < 0) break;
      seq = seq.concat(runs[nr]);
      used.add(nr);
      cur = nr;
    }
    seqs.push(seq);
  }
  for (const seq of seqs) resolveSequence(seq, cls, types, levels, base, text);
  // L1 partly: segment and paragraph separators, and whitespace before them, take the paragraph level
  // (the rest of L1 is per line: `reorderLine`).
  for (let i = n - 1, trailing = true; i >= 0; i--) {
    const k = cls[i];
    if (k === 'B' || k === 'S') { levels[i] = base; trailing = true; } else if (trailing && (k === 'WS' || isIsolateInit(k) || k === 'PDI' || isRemovedX9(k))) levels[i] = base;
    else trailing = false;
  }
  for (let i = 0; i < n; i++) if (isRemovedX9(cls[i]) && cls[i] !== 'BN') levels[i] = i > 0 ? levels[i - 1] : base;
  return levels;
}

function firstStrong(cls, from) {
  let depth = 0;
  for (let i = from; i < cls.length; i++) {
    const k = cls[i];
    if (isIsolateInit(k)) depth++;
    else if (k === 'PDI') { if (depth === 0) return null; depth--; } else if (depth === 0 && (k === 'L')) return false;
    else if (depth === 0 && (k === 'R' || k === 'AL')) return true;
    else if (k === 'B') return null;
  }
  return null;
}
function matchingPdi(cls, open) {
  let depth = 0;
  for (let i = open + 1; i < cls.length; i++) {
    if (isIsolateInit(cls[i])) depth++;
    else if (cls[i] === 'PDI') { if (depth === 0) return i; depth--; } else if (cls[i] === 'B') return -1;
  }
  return -1;
}

function resolveSequence(seq, cls, types, levels, base, text) {
  if (!seq.length) return;
  const lvl = levels[seq[0]];
  const first = seq[0], last = seq[seq.length - 1];
  // sos/eos: the higher of the levels on either side.
  let before = base;
  for (let i = first - 1; i >= 0; i--) if (!isRemovedX9(cls[i])) { before = levels[i]; break; }
  let after = base;
  if (!isIsolateInit(cls[last])) for (let i = last + 1; i < cls.length; i++) if (!isRemovedX9(cls[i])) { after = levels[i]; break; }
  const sos = Math.max(before, lvl) % 2 ? 'R' : 'L';
  const eos = Math.max(after, lvl) % 2 ? 'R' : 'L';
  const t = seq.map(i => types[i]);
  const m = t.length;
  // W1: NSM takes the previous type (ON after an isolate initiator or PDI).
  for (let j = 0; j < m; j++) {
    if (t[j] === 'NSM') t[j] = j === 0 ? sos : isIsolateInit(t[j - 1]) || t[j - 1] === 'PDI' ? 'ON' : t[j - 1];
  }
  // W2: EN after AL becomes AN. W3: AL becomes R.
  let lastStrong = sos;
  for (let j = 0; j < m; j++) {
    if (t[j] === 'EN' && lastStrong === 'AL') t[j] = 'AN';
    if (t[j] === 'L' || t[j] === 'R' || t[j] === 'AL') lastStrong = t[j];
  }
  for (let j = 0; j < m; j++) if (t[j] === 'AL') t[j] = 'R';
  // W4: a single ES between ENs becomes EN; a single CS between two numbers of one type becomes it.
  for (let j = 1; j < m - 1; j++) {
    if (t[j] === 'ES' && t[j - 1] === 'EN' && t[j + 1] === 'EN') t[j] = 'EN';
    else if (t[j] === 'CS' && t[j - 1] === 'EN' && t[j + 1] === 'EN') t[j] = 'EN';
    else if (t[j] === 'CS' && t[j - 1] === 'AN' && t[j + 1] === 'AN') t[j] = 'AN';
  }
  // W5: ETs next to EN become EN.
  for (let j = 0; j < m; j++) {
    if (t[j] !== 'ET') continue;
    let e = j;
    while (e < m && t[e] === 'ET') e++;
    if ((j > 0 && t[j - 1] === 'EN') || (e < m && t[e] === 'EN')) for (let q = j; q < e; q++) t[q] = 'EN';
    j = e - 1;
  }
  // W6: remaining separators and terminators become ON.
  for (let j = 0; j < m; j++) if (t[j] === 'ES' || t[j] === 'ET' || t[j] === 'CS') t[j] = 'ON';
  // W7: EN after L (or sos L) becomes L.
  lastStrong = sos;
  for (let j = 0; j < m; j++) {
    if (t[j] === 'EN' && lastStrong === 'L') t[j] = 'L';
    if (t[j] === 'L' || t[j] === 'R') lastStrong = t[j];
  }
  // N0 (brackets) is left to N1/N2. N1-N2: neutrals between strong types of one direction take
  // it (numbers count as R), else the embedding direction.
  const e = lvl % 2 ? 'R' : 'L';
  const dir = k => (k === 'L' ? 'L' : k === 'R' || k === 'EN' || k === 'AN' ? 'R' : null);
  for (let j = 0; j < m; j++) {
    if (!isNI(t[j])) continue;
    let k = j;
    while (k < m && isNI(t[k])) k++;
    const a = j === 0 ? sos : dir(t[j - 1]) ?? e;
    const b = k === m ? eos : dir(t[k]) ?? e;
    const v = a === b ? a : e;
    for (let q = j; q < k; q++) t[q] = v;
    j = k - 1;
  }
  // I1-I2: implicit levels.
  for (let j = 0; j < m; j++) {
    const i = seq[j];
    const k = t[j];
    if (lvl % 2 === 0) {
      if (k === 'R') levels[i] = lvl + 1;
      else if (k === 'AN' || k === 'EN') levels[i] = lvl + 2;
    } else if (k === 'L' || k === 'EN' || k === 'AN') levels[i] = lvl + 1;
    if (text.codePointAt(i) > 0xffff) levels[i + 1] = levels[i];
  }
}

/** The visual order of items with these levels (L2): indices left to right (visual_order). */
export function visualOrder(levels) {
  const order = levels.map((_, i) => i);
  let minOdd = Infinity, max = 0;
  for (const l of levels) { if (l % 2 === 1 && l < minOdd) minOdd = l; if (l > max) max = l; }
  if (minOdd === Infinity) return order;
  for (let lvl = max; lvl >= minOdd; lvl--) {
    let i = 0;
    while (i < order.length) {
      if (levels[order[i]] >= lvl) {
        let j = i;
        while (j < order.length && levels[order[j]] >= lvl) j++;
        const run = order.slice(i, j).reverse();
        for (let q = i; q < j; q++) order[q] = run[q - i];
        i = j;
      } else i++;
    }
    if (lvl === 0) break;
  }
  return order;
}

/** Give the lines of one row (beside floating objects) the row's height (even_row). */
export function evenRow(row) {
  let h = 0;
  for (const l of row) h = Math.max(h, l.height);
  for (const l of row) { l.baseline += h - l.height; l.height = h; }
  return h;
}

/** Reorder a line's clusters for display, mirroring a right-to-left paragraph (reorder_line). */
export function reorderLine(pl, line, width) {
  const rtlPara = line.rtl;
  if (rtlPara) { const l = line.left, r = line.right; line.left = width - r; line.right = width - l; }
  const {c0, c1} = line;
  const n = Math.max(0, c1 - c0);
  if (n === 0) {
    if (rtlPara) line.xs = line.xs.map(x => width - x);
    return;
  }
  const paraLevel = rtlPara ? 1 : 0;
  const levels = [];
  for (let k = c0; k < c1; k++) { const c = pl.clusters[k]; levels.push(c ? pl.bidiLevels[c.start] ?? paraLevel : paraLevel); }
  let trailing = true;
  for (let i = n - 1; i >= 0; i--) {
    const kind = pl.clusters[c0 + i]?.kind;
    let reset;
    if (kind === 'tab' || kind === 'lineBreak') { trailing = true; reset = true; } else if (kind === 'space' || kind === 'pageBreak' || kind === 'columnBreak' || kind === 'marker') reset = trailing;
    else { trailing = false; reset = false; }
    if (reset) levels[i] = paraLevel;
  }
  if (!rtlPara && levels.every(l => l === 0)) return;
  const order = visualOrder(levels);
  const hyph = line.hyphen ? line.hyphen.adv : 0;
  const w = [];
  for (let i = 0; i < n; i++) w.push((line.xs[i + 1] ?? 0) - (line.xs[i] ?? 0));
  if (w.length) w[w.length - 1] -= hyph;
  const total = w.reduce((s, v) => s + v, 0);
  const x0 = line.xs[0] ?? 0;
  let x = rtlPara ? width - x0 - total : x0;
  const vis = new Array(n);
  for (const i of order) { vis[i] = {x, w: w[i], level: levels[i]}; x += w[i]; }
  line.vis = vis;
  const end = line.endX();
  line.xs = vis.map(v => v.x).concat([end]);
}
