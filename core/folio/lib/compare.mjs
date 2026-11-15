// Compare files: the text differences between two documents.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/compare/src/lib.rs        compare (both documents' words diffed with Myers' O((N+M)D) algorithm after the common prefix
//                                    and suffix are set aside, long segments split at patience anchors first), the changes
//                                    (inserted, deleted or replaced runs of words with the rectangles to highlight, one per
//                                    line), report (the report's text)
//   crates/engine/src/compare.rs     colour (replaced blue, inserted green, deleted red), words (every word with page and box)
// A word is {text, page (0-based), rect [x0, y0, x1, y1]} in page view points (top-left origin). Not translated: the visual
// compare (visual_regions renders both files) and Office export. No DOM, no Node built-ins.

/** Segments longer than this (old + new words) are first split at anchors, so Myers' saved frontiers (O(D^2) memory) stay small. */
const DIRECT = 3000;
const EQUAL = 0, DELETE = 1, INSERT = 2;

export const KINDS = Object.freeze(['Replaced', 'Inserted', 'Deleted']);
/** Acrobat's compare colours: replaced blue, inserted green, deleted red. */
export const colour = kind => ({Replaced: [0.2, 0.45, 0.95], Inserted: [0.2, 0.75, 0.3], Deleted: [0.9, 0.25, 0.25]})[kind];

/** Patience anchors: words that occur once in each side, in an order both sides agree on (the longest increasing subsequence). */
function anchors(a, b) {
  const count = new Map();
  a.forEach((h, i) => { const e = count.get(h); if (e) { e[0]++; e[2] = i; } else count.set(h, [1, 0, i, 0]); });
  b.forEach((h, j) => { const e = count.get(h); if (e) { e[1]++; e[3] = j; } });
  const pairs = [...count.values()].filter(e => e[0] === 1 && e[1] === 1).map(e => [e[2], e[3]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const tails = [];
  const prev = new Array(pairs.length).fill(-1);
  pairs.forEach(([, y], k) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < y) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tails[lo - 1];
    if (lo === tails.length) tails.push(k); else tails[lo] = k;
  });
  const out = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k !== -1; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

/** Myers' diff of `a` and `b`: the edit script. */
function myers(a, b) {
  const n = a.length, m = b.length;
  const replaceAll = () => [...Array(n).fill(DELETE), ...Array(m).fill(INSERT)];
  if (n === 0 || m === 0) return replaceAll();
  const max = n + m;
  const off = max + 1;
  const v = new Array(2 * max + 3).fill(0);
  // Frontier d only spans diagonals -d..=d: save just that slice.
  const trace = [];
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(Math.max(off - d - 1, 0), off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const i = k + off;
      let x = k === -d || (k !== d && v[i - 1] < v[i + 1]) ? v[i + 1] : v[i - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[i] = x;
      if (x >= n && y >= m) { found = true; break outer; }
    }
  }
  if (!found) return replaceAll();
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const k = x - y;
    const base = Math.max(off - d - 1, 0);
    const at = kk => kk + off - base;
    const prevK = k === -d || (k !== d && t[at(k - 1)] < t[at(k + 1)]) ? k + 1 : k - 1;
    const prevX = t[at(prevK)];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(EQUAL); x--; y--; }
    if (d > 0) ops.push(x === prevX ? INSERT : DELETE);
    x = prevX; y = prevY;
  }
  return ops.reverse();
}

/** The edit script for `a` to `b`. */
function diff(a, b, out, depth) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  for (let i = 0; i < prefix; i++) out.push(EQUAL);
  const ma = a.slice(prefix, a.length - suffix), mb = b.slice(prefix, b.length - suffix);
  if (ma.length + mb.length <= DIRECT) for (const op of myers(ma, mb)) out.push(op);
  else {
    const list = depth > 8 ? [] : anchors(ma, mb);
    if (!list.length) {
      // A long stretch with nothing in common: one replacement.
      for (let i = 0; i < ma.length; i++) out.push(DELETE);
      for (let i = 0; i < mb.length; i++) out.push(INSERT);
    } else {
      let i = 0, j = 0;
      for (const [x, y] of list) { diff(ma.slice(i, x), mb.slice(j, y), out, depth + 1); out.push(EQUAL); i = x + 1; j = y + 1; }
      diff(ma.slice(i), mb.slice(j), out, depth + 1);
    }
  }
  for (let i = 0; i < suffix; i++) out.push(EQUAL);
}

/** Merge word boxes on the same page and line into one rectangle per line. */
function rects(words) {
  const out = [];
  for (const w of words) {
    const r = w.rect;
    const l = out.at(-1);
    if (l && Math.abs(l[1] - r[1]) < Math.max(r[3] - r[1], 1) * 0.5 && r[0] - l[2] < Math.max(r[3] - r[1], 4) * 2 && r[0] >= l[0] - 1) {
      l[0] = Math.min(l[0], r[0]); l[1] = Math.min(l[1], r[1]); l[2] = Math.max(l[2], r[2]); l[3] = Math.max(l[3], r[3]);
    } else out.push([...r]);
  }
  return out;
}

const side = (words, neighbour) => ({
  text: words.map(w => w.text).join(' '),
  page: words[0]?.page ?? neighbour?.page ?? 0,
  rects: rects(words),
  near: words.length ? null : neighbour ? [...neighbour.rect] : null,
});

/** Compare two documents' words: {changes: [{kind, old, new}], oldWords, newWords}. */
export function compare(oldWords, newWords) {
  const ids = new Map();
  const id = t => { let i = ids.get(t); if (i === undefined) { i = ids.size; ids.set(t, i); } return i; };
  const a = oldWords.map(w => id(w.text)), b = newWords.map(w => id(w.text));
  const ops = [];
  diff(a, b, ops, 0);
  const changes = [];
  let i = 0, j = 0, k = 0;
  while (k < ops.length) {
    if (ops[k] === EQUAL) { i++; j++; k++; continue; }
    const del = [], ins = [];
    while (k < ops.length && ops[k] !== EQUAL) {
      if (ops[k] === DELETE) del.push(oldWords[i++]); else ins.push(newWords[j++]);
      k++;
    }
    const kind = del.length && ins.length ? 'Replaced' : del.length ? 'Deleted' : 'Inserted';
    // Where a one-sided change sits in the other document: next to the neighbouring word.
    const oldNear = oldWords[i] ?? oldWords.at(-1), newNear = newWords[j] ?? newWords.at(-1);
    changes.push({kind, old: side(del, oldNear), new: side(ins, newNear)});
  }
  return {changes, oldWords: oldWords.length, newWords: newWords.length};
}

export const count = (c, kind) => c.changes.filter(x => x.kind === kind).length;
export const identical = c => c.changes.length === 0;

/** The compare report's text: a summary, then each change with its pages. */
export function report(c, oldName, newName) {
  let s = `Compare Report\n\nOld file: ${oldName}\nNew file: ${newName}\n\n${c.changes.length} changes: ${count(c, 'Replaced')} replaced, ${count(c, 'Inserted')} inserted, ${count(c, 'Deleted')} deleted.\n`;
  if (identical(c)) s += '\nThe documents\' text is identical.\n';
  c.changes.forEach((ch, n) => {
    s += `\n${n + 1}. ${ch.kind} (old page ${ch.old.page + 1}, new page ${ch.new.page + 1})\n`;
    if (ch.old.text) s += `   Old: ${ch.old.text}\n`;
    if (ch.new.text) s += `   New: ${ch.new.text}\n`;
  });
  return s;
}

/**
 * The words of a document in reading order: one per whitespace-separated run of a page's text, with its page and view box.
 * `texts` is each page's PageText (model/text.mjs), in page order.
 */
export function wordsOf(texts) {
  const out = [];
  texts.forEach((t, page) => {
    if (!t) return;
    let cur = null;
    const flush = () => { if (cur && cur.text.trim()) out.push({text: cur.text.trim(), page, rect: cur.rect}); cur = null; };
    for (let i = 0; i < t.glyphs.length; i++) {
      const g = t.glyphs[i];
      const breaks = i > 0 && (t.lineOf[i] !== t.lineOf[i - 1] || t.spaceBefore[i]);
      if (breaks) flush();
      if (!g.text.trim()) { flush(); continue; }
      if (!cur) cur = {text: '', rect: [...g.rect]};
      cur.text += g.text;
      cur.rect = [Math.min(cur.rect[0], g.rect[0]), Math.min(cur.rect[1], g.rect[1]), Math.max(cur.rect[2], g.rect[2]), Math.max(cur.rect[3], g.rect[3])];
    }
    flush();
  });
  return out;
}
