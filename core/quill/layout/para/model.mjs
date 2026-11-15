// Laid-out paragraph types: clusters, lines, labels, and the caret geometry read from them.
//
// Translated from wordcraft crates/layout/src/para/model.rs and the `ParaLayout` methods of
// crates/layout/src/para.rs (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c).
// Offsets are UTF-16 code units (upstream: UTF-8 bytes). A cluster carries the text it draws
// (`shown`) where upstream carries glyph ids: the renderer draws text through the shaper's font.

/** Cluster kinds (upstream `ClKind`; an object cluster also has `obj`, its index in `objects`). */
export const CL = Object.freeze({TEXT: 'text', SPACE: 'space', TAB: 'tab', LINE_BREAK: 'lineBreak', PAGE_BREAK: 'pageBreak',
  COLUMN_BREAK: 'columnBreak', OBJECT: 'object', MARKER: 'marker'});
/** How a line ends (upstream `LineEnd`). */
export const END = Object.freeze({WRAP: 'wrap', LINE_BREAK: 'lineBreak', PAGE_BREAK: 'pageBreak', COLUMN_BREAK: 'columnBreak', PARA: 'para'});

export const isBreakKind = k => k === CL.LINE_BREAK || k === CL.PAGE_BREAK || k === CL.COLUMN_BREAK;
export const isBreakEnd = e => e === END.LINE_BREAK || e === END.PAGE_BREAK || e === END.COLUMN_BREAK;

/** Width of a paragraph mark's box, points (PARA_MARK_WIDTH). */
export const PARA_MARK_WIDTH = 5.0;

/** A cluster: one drawing segment of a grapheme (or an object, tab, break). */
export function cluster(start, end, adv, kind, style, shown = '') {
  return {start, end, adv, kind, style, shown, breakAfter: false, objH: 0, objD: 0, dot: false, obj: -1, dx: 0, dy: 0};
}

/** Where a cluster of a bidirectional line is drawn (VisCl). */
export const visRtl = v => v.level % 2 === 1;
export const visLeading = v => (visRtl(v) ? v.x + v.w : v.x);
export const visTrailing = v => (visRtl(v) ? v.x : v.x + v.w);

/** A laid-out line (Line). Coordinates: x from the column's left edge, y from the paragraph's first line top. */
export class Line {
  constructor(f) { Object.assign(this, f); }
  /** Left edge of cluster `k`. */
  clLeft(k) {
    const i = k - this.c0;
    if (i < 0) return null;
    return this.vis.length === 0 ? this.xs[i] ?? null : this.vis[i]?.x ?? null;
  }
  /** Right edge of cluster `k`. */
  clRight(k) {
    const i = k - this.c0;
    if (i < 0) return null;
    if (this.vis.length === 0) return this.xs[i + 1] ?? null;
    const v = this.vis[i];
    return v ? v.x + v.w : null;
  }
  clRtl(k) { const v = this.vis[k - this.c0]; return !!v && visRtl(v); }
  /** Caret x after the line's last cluster (its logical end), hyphen included. */
  endX() {
    const h = this.hyphen ? this.hyphen.adv : 0;
    const v = this.vis[this.vis.length - 1];
    if (v) return visRtl(v) ? v.x - h : v.x + v.w + h;
    return this.xs.length ? this.xs[this.xs.length - 1] : this.left;
  }
  /** x of the line's visual end for the paragraph's direction. */
  visualEndX() {
    const end = this.endX();
    if (this.rtl) return this.vis.reduce((m, v) => Math.min(m, v.x), end);
    return this.vis.reduce((m, v) => Math.max(m, v.x + v.w), end);
  }
  /** The box of the mark ending the line: [left, width]. */
  markBox() { const x = this.visualEndX(); return [this.rtl ? x - PARA_MARK_WIDTH : x, PARA_MARK_WIDTH]; }
  /** x where the hyphen (advance `adv`) is drawn. */
  hyphenX(adv) {
    const v = this.vis[this.vis.length - 1];
    if (v) return visRtl(v) ? v.x - adv : v.x + v.w;
    return (this.xs.length ? this.xs[this.xs.length - 1] : 0) - adv;
  }
  /** Visual extents, left to right, of clusters k0..k1. */
  spans(k0, k1) {
    k0 = Math.max(k0, this.c0); k1 = Math.min(k1, this.c1);
    if (k0 >= k1) return [];
    if (this.vis.length === 0) {
      const a = this.clLeft(k0), b = this.clLeft(k1) ?? this.xs[this.xs.length - 1];
      return a !== null && b !== null && b !== undefined ? [[a, b]] : [];
    }
    const boxes = this.vis.slice(k0 - this.c0, k1 - this.c0).filter(v => v.w > 0).map(v => [v.x, v.x + v.w]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [a, b] of boxes) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 0.01) last[1] = Math.max(last[1], b); else out.push([a, b]);
    }
    return out;
  }
}

/** A laid-out paragraph (ParaLayout). */
export class ParaLayout {
  constructor(f) { Object.assign(this, f); }

  /** Is `off` a legal caret and edit boundary (not inside a joined grapheme)? */
  isEditBoundary(off) { return !this.joinedStarts.length || !binHas(this.joinedStarts, off); }

  /** A grapheme's advance including the following drawing segments of it (atomic_advance). */
  atomicAdvance(k) {
    const c = this.clusters[k];
    if (!c) return 0;
    let a = c.adv;
    if (!this.joinedStarts.length || !this.isEditBoundary(c.start)) return a;
    for (let j = k + 1; j < this.clusters.length; j++) {
      if (this.isEditBoundary(this.clusters[j].start)) break;
      a += this.clusters[j].adv;
    }
    return a;
  }
  /** The automatic space in cluster `k`'s advance (auto_space_after). */
  autoSpaceAfter(k) { const a = this.autoSpace.find(e => e[0] === k); return a ? a[1] : 0; }

  /** The line the list label is drawn on: 1 when the paragraph opens with a page break (label_line). */
  labelLine() {
    const l = this.lines[0];
    const opens = this.lines.length > 1 && l && l.end === END.PAGE_BREAK
      && this.clusters.slice(l.c0, l.c1).every(c => c.kind === CL.PAGE_BREAK || c.kind === CL.MARKER);
    return opens ? 1 : 0;
  }

  /** x of offset `off` within line `li` (x_of). */
  xOf(li, off) {
    const l = this.lines[li];
    if (!l) return null;
    if (!this.isEditBoundary(off)) {
      let k = 0;
      while (k < this.clusters.length && this.clusters[k].start < off) k++;
      let lead = 0;
      for (let j = k - 1; j >= 0; j--) if (this.isEditBoundary(this.clusters[j].start)) { lead = this.clusters[j].start; break; }
      off = lead;
    }
    return this._xFrom(l, off, {k: l.c0});
  }
  _xFrom(l, off, from) {
    if (l.vis.length) return this._xOfBidi(l, off, from);
    for (let k = from.k; k < l.c1; k++) {
      const c = this.clusters[k];
      if (!c) return null;
      if (off <= c.start || off < c.end) { from.k = k; return l.xs[k - l.c0] ?? null; }
    }
    from.k = l.c1;
    return l.xs.length ? l.xs[l.xs.length - 1] : null;
  }
  _xOfBidi(l, off, from) {
    let k = null;
    for (let j = from.k; j < l.c1; j++) { const c = this.clusters[j]; if (c && (off < c.end || off <= c.start)) { k = j; break; } }
    from.k = k ?? l.c1;
    if (k === null) return l.endX();
    const c = this.clusters[k];
    const here = l.vis[k - l.c0];
    if (!here) return null;
    if (off > c.start || k === l.c0) return visLeading(here);
    const prev = l.vis[k - 1 - l.c0];
    if (!prev) return null;
    return prev.level > here.level ? visTrailing(prev) : visLeading(here);
  }
  /** Each caret offset on line `li` with its x (line_carets). */
  lineCarets(li) {
    const l = this.lines[li];
    if (!l) return [];
    const from = {k: l.c0};
    let last = 0;
    return this.lineOffsets(li).map(off => {
      if (off < last) from.k = l.c0;
      last = off;
      return [off, this._xFrom(l, off, from)];
    });
  }
  /** The farthest right a caret goes on a left-to-right line (caret_limit); null on bidi lines. */
  caretLimit(li) {
    const l = this.lines[li];
    if (!l || l.vis.length) return null;
    let ink = null;
    for (let k = l.c1 - 1; k >= l.c0; k--) if (this.clusters[k] && this.clusters[k].kind !== CL.SPACE) { ink = k; break; }
    const end = ink !== null ? l.xs[ink + 1 - l.c0] : l.xs[0];
    return Math.max(end ?? l.left, l.right);
  }
  /** The line holding offset `off` (a position at a wrap point belongs to the next line). */
  lineOf(off) {
    // Upstream walks the lines for the first whose successor starts after `off` (a line ending in
    // a break holds the offsets before its stop, which are before the next start too); the line
    // starts ascend, so a binary search finds the same line.
    const ls = this.lines;
    if (ls.length <= 1) return 0;
    let lo = 1, hi = ls.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ls[mid].start > off) hi = mid; else lo = mid + 1;
    }
    return lo - 1;
  }
  /** Visual extents of offsets from..to on line `li` (x_spans). */
  xSpans(li, from, to) {
    const l = this.lines[li];
    if (!l) return [];
    if (!l.vis.length) {
      const a = this.xOf(li, from), b = this.xOf(li, to);
      return a !== null && b !== null ? [[a, b]] : [];
    }
    const ks = [];
    for (let k = l.c0; k < l.c1; k++) { const c = this.clusters[k]; if (c && c.start < to && c.end > from) ks.push(k); }
    return ks.length ? l.spans(ks[0], ks[ks.length - 1] + 1) : [];
  }
  /** Caret offsets a click or arrow key can reach on line `li` (line_offsets). */
  lineOffsets(li) {
    const l = this.lines[li];
    if (!l) return [];
    const v = [];
    for (let k = l.c0; k < l.c1; k++) { const c = this.clusters[k]; if (c && this.isEditBoundary(c.start)) v.push(c.start); }
    const lastBreak = l.c1 > l.c0 && isBreakKind(this.clusters[l.c1 - 1]?.kind);
    const wrapped = l.c1 > l.c0 && l.end === END.WRAP && !!this.lines[li + 1];
    if ((!lastBreak && !wrapped) || l.c1 === l.c0) v.push(l.stop);
    return v;
  }
  /** Offset closest to x on line `li` (off_at_x). */
  offAtX(li, x) {
    const l = this.lines[li];
    if (!l) return this.textLen;
    if (l.vis.length) {
      let best = [l.start, Infinity];
      for (const [off, cx] of this.lineCarets(li)) {
        const d = cx === null ? Infinity : Math.abs(cx - x);
        if (d < best[1]) best = [off, d];
      }
      return best[0];
    }
    let best = l.start, bestd = Infinity;
    for (let k = l.c0; k <= l.c1; k++) {
      const cx = l.xs[k - l.c0];
      if (cx === undefined) break;
      const off = k < l.c1 ? this.clusters[k]?.start ?? l.stop : l.stop;
      if (!this.isEditBoundary(off)) continue;
      if (k === l.c1 && k > l.c0) {
        if (isBreakKind(this.clusters[k - 1]?.kind)) continue;
        if (l.end === END.WRAP && this.lines[li + 1]) continue;
      }
      const d = Math.abs(cx - x);
      if (d < bestd) { bestd = d; best = off; }
    }
    return best;
  }
  /** The caret's ascent and descent on a line (caret_metrics). */
  caretMetrics(li) {
    const l = this.lines[li];
    if (!l) return [10, 3];
    return [Math.min(l.textAsc, l.baseline - l.top), Math.min(l.textDesc, l.top + l.height - l.baseline)];
  }
}

function binHas(a, v) {
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] === v) return true; if (a[m] < v) lo = m + 1; else hi = m - 1; }
  return false;
}
export {binHas};

/** Insert into a sorted array of numbers if missing. */
export function binIndexOf(a, v) {
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] === v) return m; if (a[m] < v) lo = m + 1; else hi = m - 1; }
  return -1;
}
