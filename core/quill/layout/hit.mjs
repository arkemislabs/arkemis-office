// Hit testing: point -> position, caret geometry, line navigation, selection rectangles, the
// story / object / cell under a point.
//
// Translated from wordcraft crates/layout/src/hit.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: turned (vertical) text, equation
// hit testing (`math_edit`), column (Alt+drag) selection.
import {PARA_MARK_WIDTH, END, isBreakEnd} from './para/model.mjs';
import {DECOR_STORY} from './notes.mjs';
import {pathKey, storyKey} from './placed.mjs';

/** Document order of two paths. */
export function cmpPath(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cmpPos = (a, b) => cmpPath(a.path, b.path) || a.off - b.off;

/** Every paragraph path of a story's blocks, tables descended, in document order. */
export function paraPaths(blocks, prefix = [], out = []) {
  blocks.forEach((b, i) => {
    if (b.kind === 'table') b.rows.forEach((r, ri) => r.cells.forEach((c, ci) => paraPaths(c.blocks, prefix.concat([i, ri, ci]), out)));
    else out.push(prefix.concat([i]));
  });
  return out;
}

function itemsOf(page, story) {
  return story === 'body' ? page.items : page.header.concat(page.footer, page.items);
}

/** Every line of `story` on a page with its page geometry (page_lines). */
export function pageLines(page, story) {
  const v = [];
  for (const it of itemsOf(page, story)) {
    if (it.kind !== 'lines' || it.story !== story) continue;
    const first = it.para.lines[it.l0];
    if (!first) continue;
    for (let li = it.l0; li < it.l1; li++) {
      const l = it.para.lines[li];
      const top = it.y + (l.top - first.top);
      v.push({story: it.story, path: it.path, para: it.para, li, x: it.x, top, bottom: top + l.height, left: it.x + l.left, right: it.x + l.right});
    }
  }
  return v;
}

function score(l, x, y) {
  const dy = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0;
  const dx = x < l.left - 4 ? l.left - 4 - x : x > l.right + 4 ? x - l.right - 4 : 0;
  return dy * 4 + dx;
}
const nearest = (lines, dir) => (lines.length ? lines.reduce((a, b) => (dir < 0 ? (b.top > a.top ? b : a) : (b.top < a.top ? b : a))) : null);
const beside = (p, l) => { const n = Math.min(p.length, l.length); for (let i = 0; i < n; i++) if (p[i] !== l[i]) return i % 3 === 2; return false; };
function between(a, b, l) {
  const [lo, hi] = cmpPath(a, b) <= 0 ? [a, b] : [b, a];
  return cmpPath(l, lo) > 0 && cmpPath(l, hi) < 0;
}
function inRow(lines, gx, dir) {
  const n = nearest(lines, dir);
  if (!n) return null;
  const off = l => Math.max(l.left - gx, gx - l.right, 0);
  const cands = lines.filter(l => (samePath(l.path, n.path) && l.li === n.li) || beside(n.path, l.path));
  return cands.reduce((a, b) => { const d = off(a) - off(b); if (d !== 0) return d < 0 ? a : b; return dir < 0 ? (b.top > a.top ? b : a) : (b.top < a.top ? b : a); });
}

/** The whole layout (DocLayout): pages, an index of placed paragraph pieces, and hit testing. */
export class DocLayout {
  constructor(doc, pages) {
    this.doc = doc;
    this.pages = pages;
    this.ms = 0;
    this._index = null;
  }
  /** (story, path) -> [[page, itemIndex]] of each placed piece of body text, in order (DocLayout::index). */
  get index() {
    if (!this._index) {
      const m = new Map();
      this.pages.forEach((p, pi) => p.items.forEach((it, ii) => {
        if (it.kind !== 'lines') return;
        const k = `${storyKey(it.story)}/${pathKey(it.path)}`;
        let v = m.get(k);
        if (!v) { v = []; m.set(k, v); }
        v.push([pi, ii]);
      }));
      this._index = m;
    }
    return this._index;
  }
  /** The placed pieces of paragraph `path` in `story`: [[page, item]]. */
  pieces(story, path, pageHint = 0) {
    if (story === 'body') return (this.index.get(`body/${pathKey(path)}`) ?? []).map(([pi, ii]) => [pi, this.pages[pi].items[ii]]);
    const out = [];
    const on = pi => { const p = this.pages[pi]; const v = []; for (const it of itemsOf(p, story)) if (it.kind === 'lines' && it.story === story && samePath(it.path, path)) v.push([pi, it]); return v; };
    const hint = Math.min(Math.max(pageHint, 0), this.pages.length - 1);
    let found = hint >= 0 ? on(hint) : [];
    if (!found.length) { for (let pi = 0; pi < this.pages.length && !found.length; pi++) found = on(pi); }
    out.push(...found);
    return out;
  }
  /** The page the position's text is on (page_of). */
  pageOf(pos) { const c = this.caret(pos); return c ? c.page : null; }

  /** The position nearest to (x, y) on `page` in `story` (hit). */
  hit(page, x, y, story = 'body') {
    const p = this.pages[page];
    if (!p) return null;
    const lines = pageLines(p, story);
    if (!lines.length) return null;
    let best = lines[0], bs = score(best, x, y);
    for (const l of lines) { const s = score(l, x, y); if (s < bs) { best = l; bs = s; } }
    return {story: best.story, path: best.path.slice(), off: best.para.offAtX(best.li, x - best.x)};
  }
  /** The story whose text is under a point: a text box inside its area, else the body (story_at). */
  storyAt(page, x, y) {
    const p = this.pages[page];
    if (!p) return null;
    for (let i = p.items.length - 1; i >= 0; i--) {
      const it = p.items[i];
      if (it.kind === 'object' && it.textBox !== null && it.wrap !== 'behindText' && within(it.rect, x, y)) return it.textBox;
    }
    for (const it of p.items) {
      if (it.kind !== 'lines' || it.story === DECOR_STORY) continue;
      const first = it.para.lines[it.l0], last = it.para.lines[it.l1 - 1];
      if (!first || !last) continue;
      const bottom = it.y + last.top + last.height - first.top;
      if (y >= it.y - 2 && y <= bottom + 2 && x >= it.x - 40 && x <= it.x + last.right + 40) return it.story;
    }
    return 'body';
  }
  /** The drawing under a point (object_at): the topmost `object` item, within `edge` of its frame. */
  objectAt(page, x, y, edge = 0) {
    const p = this.pages[page];
    if (!p) return null;
    for (let i = p.items.length - 1; i >= 0; i--) {
      const it = p.items[i];
      if (it.kind === 'object' && within(it.rect, x, y, edge)) return it;
    }
    return null;
  }
  /** The header or footer story at height y, and whether it is the footer (header_footer_at). */
  headerFooterAt(page, y) {
    const p = this.pages[page];
    if (!p) return null;
    if (y < p.body.y && p.headerStory !== null) return [p.headerStory, false];
    if (y > p.body.y + p.body.h && p.footerStory !== null) return [p.footerStory, true];
    return null;
  }
  /** The table cell under a point: [story, tablePath, row, cell] (cell_at). */
  cellAt(page, x, y) {
    const p = this.pages[page];
    if (!p) return null;
    let best = null;
    for (const it of p.items) if (it.kind === 'cell' && !it.covered && within(it.rect, x, y) && (!best || it.table.length >= best.table.length)) best = it;
    return best ? [best.story, best.table, best.row, best.cell] : null;
  }

  /** The caret at a position: {page, x, top, height, width} (caret / caret_on). */
  caret(pos, pageHint = 0) {
    for (const [pi, it] of this.pieces(pos.story, pos.path, pageHint)) {
      const para = it.para;
      const li = para.lineOf(pos.off);
      if (li < it.l0 || li >= it.l1) continue;
      const first = para.lines[it.l0], l = para.lines[li];
      let cx = para.xOf(li, pos.off);
      if (cx === null) return null;
      const lim = para.caretLimit(li);
      if (lim !== null) cx = Math.min(cx, lim);
      const top = l.top - first.top;
      const [asc, desc] = para.caretMetrics(li);
      const base = top + (l.baseline - l.top);
      const ctop = Math.max(base - asc, top);
      return {page: pi, x: it.x + cx, top: it.y + ctop, height: Math.max(base + desc - ctop, 4), width: 0};
    }
    return null;
  }
  /** The position a line up (dir < 0) or down from `pos`, keeping goal x (vertical): [pos, goalX]. */
  vertical(pos, goalX, dir, pageHint = 0) {
    const c = this.caret(pos, pageHint);
    if (!c) return null;
    const gx = goalX ?? c.x;
    const page = this.pages[c.page];
    const lines = pageLines(page, pos.story);
    const mid = c.top + c.height / 2;
    const cands = lines.filter(l => { const m = (l.top + l.bottom) / 2; return dir < 0 ? m < mid - 1 && l.bottom <= c.top + c.height * 0.5 : m > mid + 1 && l.top >= c.top + c.height * 0.5; });
    const across = cands.filter(l => gx >= l.left - 2 && gx <= l.right + 2);
    let target;
    const t = nearest(across, dir);
    if (t) {
      const skipped = cands.filter(l => (dir < 0 ? l.top > t.top : l.top < t.top) && between(pos.path, t.path, l.path));
      target = skipped.length ? inRow(skipped, gx, dir) : t;
    } else target = inRow(cands, gx, dir);
    if (target) return [{story: target.story, path: target.path.slice(), off: target.para.offAtX(target.li, gx - target.x)}, gx];
    const np = dir < 0 ? c.page - 1 : c.page + 1;
    const p = this.pages[np];
    if (!p) return null;
    const ls = pageLines(p, pos.story);
    if (!ls.length) return null;
    const l = ls.reduce((a, b) => (dir < 0 ? (b.top > a.top ? b : a) : (b.top < a.top ? b : a)));
    return [{story: l.story, path: l.path.slice(), off: l.para.offAtX(l.li, gx - l.x)}, gx];
  }
  /** The start and end positions of the line holding `pos` (line_bounds: Home/End). */
  lineBounds(pos, pageHint = 0) {
    for (const [, it] of this.pieces(pos.story, pos.path, pageHint)) {
      const para = it.para;
      const li = para.lineOf(pos.off);
      if (li < it.l0 || li >= it.l1) continue;
      const l = para.lines[li];
      let end = l.stop;
      if (isBreakEnd(l.end) && end > l.start) end = para.clusters[l.c1 - 1]?.start ?? end;
      else if (l.end === END.WRAP) end = Math.max(...para.lineOffsets(li), l.start);
      return [{...pos, off: l.start}, {...pos, off: end}];
    }
    return null;
  }
  /** Selection rectangles from `a` to `b`: [[page, rect]] (selection_rects). */
  selectionRects(a, b, pageHint = 0) {
    if (cmpPos(a, b) > 0) [a, b] = [b, a];
    const out = [];
    if (a.story !== b.story) return out;
    const blocks = a.story === 'body' ? this.doc.body : this.doc.part(a.story)?.blocks ?? [];
    for (const path of paraPaths(blocks)) {
      if (cmpPath(path, a.path) < 0 || cmpPath(path, b.path) > 0) continue;
      const isA = samePath(path, a.path), isB = samePath(path, b.path);
      for (const [pi, it] of this.pieces(a.story, path, pageHint)) {
        const para = it.para;
        const first = para.lines[it.l0];
        if (!first) continue;
        const put = r => out.push([pi, {x: it.x + r.x, y: it.y + r.y, w: r.w, h: r.h}]);
        for (let li = it.l0; li < it.l1; li++) {
          const l = para.lines[li];
          const from = isA ? Math.max(a.off, l.start) : l.start;
          const to = isB ? Math.min(b.off, l.stop) : l.stop;
          if ((isA && a.off > l.stop) || (isB && b.off < l.start) || from > to) continue;
          const top = l.top - first.top;
          const lastLine = li + 1 === para.lines.length;
          if (l.vis.length) {
            for (const [x0, x1] of para.xSpans(li, from, to)) put({x: x0, y: top, w: Math.max(x1 - x0, 0), h: l.height});
            if (lastLine && !isB) { const ex = l.endX(); put({x: l.rtl ? ex - PARA_MARK_WIDTH : ex, y: top, w: PARA_MARK_WIDTH, h: l.height}); }
            continue;
          }
          const x0 = para.xOf(li, from) ?? l.left;
          let x1 = para.xOf(li, to) ?? x0;
          if (lastLine && !isB) x1 += PARA_MARK_WIDTH;
          if (isB && to >= l.stop && li + 1 < para.lines.length && b.off > l.stop) x1 = para.xOf(li, l.stop) ?? x1;
          if (x1 <= x0 && !(lastLine && !isB)) continue;
          put({x: x0, y: top, w: Math.max(x1 - x0, 0), h: l.height});
        }
      }
    }
    return out;
  }
  /** hitTest(page, x, y, story): the position nearest a point (alias of hit). */
  hitTest(page, x, y, story = 'body') { return this.hit(page, x, y, story); }
  /** rectsForRange(a, b): selection rectangles [[page, rect]] (alias of selectionRects). */
  rectsForRange(a, b, pageHint = 0) { return this.selectionRects(a, b, pageHint); }
  /** The body paragraph line start at the left margin beside y (selection_bar_at). */
  selectionBarAt(page, x, y) {
    const p = this.pages[page];
    if (!p || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > p.w || y < p.body.y || y > p.body.y + p.body.h) return null;
    const left = x < p.body.x;
    if (!left && x <= p.body.x + p.body.w) return null;
    const lines = pageLines(p, 'body');
    if (!lines.length) return null;
    const dist = l => (y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0);
    const l = lines.reduce((m, q) => (dist(q) < dist(m) ? q : m));
    const line = l.para.lines[l.li];
    const hangs = line.rtl ? l.right > p.body.x + p.body.w + 0.5 : l.left < p.body.x - 0.5;
    if (l.path.length > 1 || line.rtl === left || hangs) return null;
    return {story: 'body', path: l.path.slice(), off: line.start};
  }
}

function within(r, x, y, edge = 0) { return x >= r.x - edge && x <= r.x + r.w + edge && y >= r.y - edge && y <= r.y + r.h + edge; }
