// The text of one page with line structure: what text selection, double-click word selection,
// search and text markup (QuadPoints per line) work on.
//
// Translated from printcraft crates/render/src/text.rs (PageText: text_of, plain_text, nearest,
// word_at, line_at, line_rects, glyph_rects, merged_rects, glyphs_in, quad_contains, fold_case),
// crates/render/src/text/layout.rs (layout, arrange: fake-bold drop, segments, redrawn runs,
// same-baseline merge, blocks, block order, word gaps), crates/render/src/text/order.rs (Run, Seg,
// fingerprint, redraws, restarts_run, place_glyphs, collide, reverse_rtl),
// crates/render/src/text/search.rs (find) and crates/render/src/text/device.rs (WORD_GAP) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A glyph is `{text, rect:[x0 y0 x1 y1], quad:[[x,y]×4], direction:[dx,dy]}` in page view space
// (points, top-left of the displayed page, y down). `quad[0] → quad[1]` runs in the writing
// direction along the edge towards the next line (the em box's descender edge).
//
// Arkemis addition for addresses (/pg:<id>/chars:<from>-<to>, docs/architecture.md 14.5): the page
// text is `plainText()` (spaces and line breaks reconstructed as upstream does), and every glyph
// has its UTF-16 span in it (`charStart`, `charEnd`).
// No DOM, no Node built-ins.

import {quadContains} from '../lib/geom.mjs';

export const WORD_GAP = 0.15;
const RUN_COLLISION = 0.25, RUN_OVERLAP_SPACE = 0.5, REDRAW_CANDIDATES = 32, COLLIDE_PAIRS_PER_GLYPH = 16;
const REDRAW_POSITION_TOLERANCE = 0.2, REDRAW_PREFIX_GLYPHS = 3;

export const isRtl = ch => { const c = ch.codePointAt(0); return (c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff) || (c >= 0x10800 && c <= 0x10fff) || (c >= 0x1e800 && c <= 0x1efff); };
const isComplex = ch => { const c = ch.codePointAt(0); return (c >= 0x0300 && c <= 0x036f) || (c >= 0x0900 && c <= 0x0dff) || (c >= 0x0e00 && c <= 0x0eff) || (c >= 0x1000 && c <= 0x109f) || (c >= 0x1780 && c <= 0x17ff); };
const isCjk = ch => { const c = ch.codePointAt(0); return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x20000 && c <= 0x3134f) || (c >= 0x1100 && c <= 0x11ff); };
const any = (s, f) => { for (const ch of s) if (f(ch)) return true; return false; };
const every = (s, f) => { for (const ch of s) if (!f(ch)) return false; return true; };
const isAlnum = ch => /[\p{L}\p{N}]/u.test(ch);
const isNumeric = ch => /\p{N}/u.test(ch);
const isAlpha = ch => /\p{L}/u.test(ch);
const isWs = ch => /\s/u.test(ch);

function union(a, b) { a[0] = Math.min(a[0], b[0]); a[1] = Math.min(a[1], b[1]); a[2] = Math.max(a[2], b[2]); a[3] = Math.max(a[3], b[3]); }

/** text.rs `fold_case`: one character for one character; dotted/dotless i and sigma forms fold together. */
export function foldCase(s) {
  let out = '';
  for (const c of s) {
    if (c === 'I' || c === 'i' || c === 'İ' || c === 'ı') out += 'i';
    else if (c === 'Σ' || c === 'σ' || c === 'ς') out += 'σ';
    else out += c.toLowerCase();
  }
  return out;
}

// ── order.rs ────────────────────────────────────────────────────────────────────────────────

/** Whether (scriptBbox, scriptH) is a superscript or subscript on (hostBbox, hostH) (order.rs is_script_on, printcraft 8f16855). */
function isScriptOn(hostBbox, hostH, scriptBbox, scriptH) {
  const hostCy = (hostBbox[1] + hostBbox[3]) / 2;
  const scriptCy = (scriptBbox[1] + scriptBbox[3]) / 2;
  const scriptW = scriptBbox[2] - scriptBbox[0];
  const hostW = hostBbox[2] - hostBbox[0];
  const smaller = scriptH >= hostH * 0.45 && scriptW < hostH * 3 && (scriptH < hostH * 0.9 || (scriptH <= hostH && hostW > scriptW));
  if (!smaller) return false;
  if (scriptCy < hostCy) {
    // Superscript: raised above the host baseline, with its bottom inside the host line.
    return hostCy - scriptCy >= hostH * 0.12 && hostCy - scriptCy < hostH * 0.7 && hostBbox[3] - scriptBbox[3] >= hostH * 0.15 && scriptBbox[3] > hostBbox[1] + hostH * 0.25;
  }
  // Subscript: lowered below the host baseline, with its centre still inside the host line.
  return scriptCy - hostCy >= hostH * 0.12 && scriptCy - hostCy < hostH * 0.5 && scriptBbox[3] > hostBbox[3] && hostBbox[3] > scriptBbox[1] + scriptH * 0.5 && scriptBbox[1] >= hostBbox[1] - scriptH * 0.2;
}

class Seg {
  constructor(first, bbox, h) { this.runs = [first]; this.bbox = bbox.slice(); this.h = h; }
  get first() { return this.runs[0]; }
  cy() { return (this.bbox[1] + this.bbox[3]) / 2; }
  /**
   * Extend the box and height with (bbox, h). A smaller script (superscript or subscript) widens the line horizontally without pulling its
   * vertical baseline band up or down; when a line begins with a script and continues with taller body text, the body text's band becomes
   * the line's (order.rs extend_box, printcraft 8f16855).
   */
  extendBox(bbox, h) {
    if (h > this.h * 1.15 || isScriptOn(bbox, h, this.bbox, this.h)) { this.bbox[1] = bbox[1]; this.bbox[3] = bbox[3]; }
    else if (!(this.h > h * 1.15 || isScriptOn(this.bbox, this.h, bbox, h))) { this.bbox[1] = Math.min(this.bbox[1], bbox[1]); this.bbox[3] = Math.max(this.bbox[3], bbox[3]); }
    this.bbox[0] = Math.min(this.bbox[0], bbox[0]);
    this.bbox[2] = Math.max(this.bbox[2], bbox[2]);
    this.h = Math.max(this.h, h);
  }
  merge(other) { this.extendBox(other.bbox, other.h); this.runs.push(...other.runs); }
}
const runLen = r => r.end - r.start;

function fingerprint(glyphs, run) {
  let h = 0x811c9dc5;
  for (let i = run.start; i < run.end; i++) {
    const t = glyphs[i].text;
    h = Math.imul(h ^ t.length, 0x01000193);
    for (let k = 0; k < t.length; k++) h = Math.imul(h ^ t.charCodeAt(k), 0x01000193);
  }
  return h >>> 0;
}

function redraws(glyphs, a, b) {
  if (runLen(a) !== runLen(b)) return false;
  for (let k = 0; k < runLen(a); k++) {
    const p = glyphs[a.start + k], g = glyphs[b.start + k];
    const tol = REDRAW_POSITION_TOLERANCE * Math.max(g.rect[3] - g.rect[1], 0.1);
    if (!(p.text === g.text && Math.abs(p.rect[0] - g.rect[0]) < tol && Math.abs(p.rect[1] - g.rect[1]) < tol)) return false;
  }
  return true;
}

function restartsRun(glyphs, start, next, progress) {
  const first = glyphs[start], candidate = glyphs[next];
  if (!first || !candidate) return false;
  const tol = REDRAW_POSITION_TOLERANCE * Math.max(candidate.rect[3] - candidate.rect[1], 0.1);
  if (first.text !== candidate.text || !(Math.abs(first.rect[0] - candidate.rect[0]) < tol) || !(Math.abs(first.rect[1] - candidate.rect[1]) < tol)) return false;
  const h = Math.max(first.rect[3] - first.rect[1], 0.1);
  if (!Number.isFinite(progress) || progress <= h) return false;
  for (let offset = 1; offset < REDRAW_PREFIX_GLYPHS; offset++) {
    const a = glyphs[start + offset], b = glyphs[next + offset];
    if (!a || !b) return false;
    const t = REDRAW_POSITION_TOLERANCE * Math.max(b.rect[3] - b.rect[1], 0.1);
    if (a.text !== b.text || !(Math.abs(a.rect[0] - b.rect[0]) < t) || !(Math.abs(a.rect[1] - b.rect[1]) < t)) return false;
  }
  return true;
}

function unionFind(parent, r) { while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; } return r; }

/** order.rs `place_glyphs`: a segment's glyphs left to right, colliding runs kept whole. */
function placeGlyphs(glyphs, height, seg) {
  const x0 = i => glyphs[i].rect[0];
  const zeroWidth = i => glyphs[i].rect[2] - glyphs[i].rect[0] <= 0.05 * height(i);
  const text = [], marks = [];
  for (const run of seg.runs) {
    let allZero = true;
    for (let i = run.start; i < run.end; i++) if (!zeroWidth(i)) { allZero = false; break; }
    if (allZero) for (let i = run.start; i < run.end; i++) marks.push(i);
    else text.push(run);
  }
  let placed = [], breaks = [];
  if (text.length <= 1) {
    for (const run of text) for (let i = run.start; i < run.end; i++) placed.push(i);
    placed.sort((a, b) => x0(a) - x0(b) || a - b);
  } else ({placed, breaks} = collide(glyphs, height, seg.h, text));
  marks.sort((a, b) => x0(a) - x0(b));
  if (marks.length) {
    const merged = [];
    let next = 0;
    for (const m of marks) {
      while (next < placed.length && x0(placed[next]) <= x0(m)) merged.push(placed[next++]);
      merged.push(m);
    }
    merged.push(...placed.slice(next));
    placed = merged;
  }
  return {placed, breaks};
}

function collide(glyphs, height, h, text) {
  const x0 = i => glyphs[i].rect[0];
  const owner = [];
  text.forEach((run, r) => { for (let i = run.start; i < run.end; i++) owner.push([i, r]); });
  owner.sort((a, b) => x0(a[0]) - x0(b[0]) || a[0] - b[0]);
  const parent = text.map((_, i) => i);
  let budget = COLLIDE_PAIRS_PER_GLYPH * owner.length, collided = false, dense = false;
  sweep: for (let a = 0; a < owner.length; a++) {
    const [i, ri] = owner[a];
    const x1 = glyphs[i].rect[2], hi = height(i);
    for (let b = a + 1; b < owner.length; b++) {
      const [j, rj] = owner[b];
      if (x0(j) >= x1) break;
      if (budget === 0) { dense = true; break sweep; }
      budget--;
      const ra = unionFind(parent, ri), rb = unionFind(parent, rj);
      const hj = height(j);
      const script = isScriptOn(glyphs[i].rect, hi, glyphs[j].rect, hj) || isScriptOn(glyphs[j].rect, hj, glyphs[i].rect, hi);
      const overlap = Math.min(x1, glyphs[j].rect[2]) - x0(j);
      if (ra !== rb && !script && overlap > RUN_COLLISION * Math.min(hi, hj)) { parent[ra] = rb; collided = true; }
    }
  }
  if (dense) { parent.fill(0); collided = true; }
  if (!collided) return {placed: owner.map(o => o[0]), breaks: []};
  const groups = new Map();
  text.forEach((_, r) => { const root = unionFind(parent, r); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(r); });
  const units = [], breaks = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      const run = text[members[0]];
      for (let i = run.start; i < run.end; i++) units.push({left: x0(i), first: i, glyphs: [i]});
      continue;
    }
    const rows = members.slice().reverse().map(m => {
      const run = text[m];
      const g = [];
      for (let i = run.start; i < run.end; i++) g.push(i);
      g.sort((a, b) => x0(a) - x0(b) || a - b);
      return {left: Math.min(...g.map(x0)), right: Math.max(...g.map(i => glyphs[i].rect[2])), first: run.start, lead: g[0], glyphs: g};
    });
    rows.sort((a, b) => a.left - b.left || a.first - b.first);
    const flat = [];
    let reach = -Infinity;
    for (const row of rows) {
      if (row.left < reach - h * RUN_OVERLAP_SPACE) breaks.push(row.lead);
      reach = Math.max(reach, row.right);
      flat.push(...row.glyphs);
    }
    units.push({left: Math.min(...rows.map(r => r.left)), first: Math.min(...rows.map(r => r.first)), glyphs: flat});
  }
  units.sort((a, b) => a.left - b.left || a.first - b.first);
  return {placed: units.flatMap(u => u.glyphs), breaks: breaks.sort((a, b) => a - b)};
}

const bidiClass = t => (any(t, c => isRtl(c) && !isNumeric(c)) ? 'R' : any(t, isNumeric) ? 'Num' : any(t, isAlpha) ? 'L' : 'N');

/** order.rs `reverse_rtl`: visual → logical order of a line with right-to-left runs. */
function reverseRtl(glyphs, idx, spaces) {
  const items = [];
  idx.forEach((i, w) => {
    if (w > 0 && spaces[w]) items.push([null, 'N']);
    items.push([i, bidiClass(glyphs[i].text)]);
  });
  const text = k => (items[k]?.[0] == null ? '' : glyphs[items[k][0]].text);
  const count = b => items.filter(it => it[1] === b).length;
  const para = count('R') > count('L') ? 'R' : 'L';
  const n = items.length;
  for (let k = 1; k < n - 1; k++) {
    if (['.', ',', ':', '/', '+', '-', '٫', '٬'].includes(text(k)) && items[k - 1][1] === 'Num' && items[k + 1][1] === 'Num') items[k][1] = 'Num';
  }
  const term = s => !!s && every(s, c => /[%‰#$¢-¥°٪₠-⃏]/.test(c));
  for (let k = 1; k < n; k++) if (items[k][1] === 'N' && items[k - 1][1] === 'Num' && term(text(k))) items[k][1] = 'Num';
  for (let k = n - 2; k >= 0; k--) if (items[k][1] === 'N' && items[k + 1][1] === 'Num' && term(text(k))) items[k][1] = 'Num';
  let strong = para;
  for (const it of items) { if (it[1] === 'L' || it[1] === 'R') strong = it[1]; else if (it[1] === 'Num' && strong === 'L') it[1] = 'L'; }
  const dir = b => (b === 'L' ? 'L' : 'R');
  for (let k = 0; k < n;) {
    if (items[k][1] !== 'N') { k++; continue; }
    let e = k;
    while (e < n && items[e][1] === 'N') e++;
    const before = k === 0 ? para : dir(items[k - 1][1]), after = e === n ? para : dir(items[e][1]);
    const resolved = before === after ? before : para;
    for (let j = k; j < e; j++) items[j][1] = resolved;
    k = e;
  }
  const rtlPara = para === 'R';
  const levels = items.map(it => (it[1] === 'R' ? 1 : it[1] === 'Num' ? 2 : rtlPara ? 2 : 0));
  const order = items.map((_, i) => i);
  for (let level = Math.max(0, ...levels); level >= 1; level--) {
    for (let k = 0; k < n;) {
      if (levels[order[k]] < level) { k++; continue; }
      let e = k;
      while (e < n && levels[order[e]] >= level) e++;
      const part = order.slice(k, e).reverse();
      for (let j = k; j < e; j++) order[j] = part[j - k];
      k = e;
    }
  }
  let j = 0, gap = false;
  for (const o of order) {
    if (items[o][0] === null) gap = true;
    else { idx[j] = items[o][0]; spaces[j] = gap && j > 0; gap = false; j++; }
  }
}

// ── layout.rs ───────────────────────────────────────────────────────────────────────────────

/** layout.rs `arrange`: reading order of indices into `all`, with each one's line and word gap. */
export function arrange(all) {
  const keep = all.map(() => true);
  for (let i = 1; i < all.length; i++) {
    const g = all[i];
    const h = Math.max(g.rect[3] - g.rect[1], 0.1), w = g.rect[2] - g.rect[0];
    const dx = w > 0 ? Math.min(h * 0.2, w * 0.5) : h * 0.2;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const p = all[j];
      if (keep[j] && p.text === g.text && Math.abs(p.rect[0] - g.rect[0]) < dx && Math.abs(p.rect[1] - g.rect[1]) < h * 0.2) { keep[i] = false; break; }
    }
  }
  const kept = [];
  for (let i = 0; i < all.length; i++) if (keep[i]) kept.push(i);
  const glyphs = kept.map(i => all[i]);
  const n = glyphs.length;
  if (!n) return {order: [], lineOf: [], spaceBefore: []};
  const height = i => Math.max(glyphs[i].rect[3] - glyphs[i].rect[1], 0.1);
  const cy = i => (glyphs[i].rect[1] + glyphs[i].rect[3]) / 2;

  // 1. Segments in content order.
  let segs = [];
  let runStartX = 0, furthest = 0;
  for (let i = 0; i < n; i++) {
    const g = glyphs[i].rect;
    const last = segs[segs.length - 1];
    let cont = false;
    if (last) {
      const p = last.first.end - 1;
      if (p >= 0) {
        const hi = height(i);
        const ph = Math.min(height(p), hi);
        const sh = Math.min(last.h, hi);
        const gap = g[0] - glyphs[p].rect[2];
        const centreLimit = Math.abs(gap) < ph ? Math.max(height(p), hi) * 0.5 : ph * 0.5;
        // A script sits on the line it belongs to (printcraft 8f16855): beside the segment as a whole, or on it.
        const sameLine = (Math.abs(cy(i) - cy(p)) < centreLimit && gap < ph * 3) || (Math.abs(cy(i) - last.cy()) < sh * 0.3 && Math.abs(last.h / hi - 1) < 0.35 && gap < sh * 3);
        const onSeg = gap < last.h * 1.2 && (isScriptOn(last.bbox, last.h, g, hi) || isScriptOn(g, hi, last.bbox, last.h));
        cont = (sameLine || onSeg) && g[0] > glyphs[p].rect[0] - sh * 2;
      }
    }
    const reset = cont && restartsRun(glyphs, last.first.start, i, furthest);
    if (cont && !reset) {
      last.first.end = i + 1;
      last.extendBox(g, height(i));
      furthest = Math.max(furthest, Math.abs(g[0] - runStartX), Math.abs(g[2] - runStartX));
    } else {
      segs.push(new Seg({start: i, end: i + 1}, g, height(i)));
      runStartX = g[0];
      furthest = 0;
    }
  }
  // Runs that redraw an earlier run at the same place are dropped.
  {
    const latest = new Map(), older = new Array(segs.length).fill(-1);
    let keptRuns = 0;
    for (let i = 0; i < segs.length; i++) {
      const run = segs[i].first;
      if (runLen(run) >= 2) {
        const tol = 0.2 * segs[i].h;
        const cx = Math.floor(glyphs[run.start].rect[0] / tol), cyy = Math.floor(glyphs[run.start].rect[1] / tol);
        const fp = fingerprint(glyphs, run);
        let checks = REDRAW_CANDIDATES, twin = false;
        outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          let link = latest.get(`${fp}:${cx + dx}:${cyy + dy}`);
          while (link !== undefined && link >= 0) {
            const prev = segs[link];
            if (!prev) break;
            if (checks === 0) break outer;
            checks--;
            if (redraws(glyphs, prev.first, run)) { twin = true; break outer; }
            link = older[link];
          }
        }
        if (twin) continue;
        const key = `${fp}:${cx}:${cyy}`;
        older[keptRuns] = latest.has(key) ? latest.get(key) : -1;
        latest.set(key, keptRuns);
      }
      [segs[keptRuns], segs[i]] = [segs[i], segs[keptRuns]];
      keptRuns++;
    }
    segs = segs.slice(0, keptRuns);
  }
  // Merge same-baseline segments that nearly touch, then attach any remaining superscript or subscript segments to the closest host line
  // segment they sit on.
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < segs.length; a++) for (let b = 0; b < segs.length; b++) {
      if (a === b) continue;
      const sa = segs[a], sb = segs[b];
      const h = Math.min(sa.h, sb.h);
      const gap = Math.max(sb.bbox[0] - sa.bbox[2], sa.bbox[0] - sb.bbox[2]);
      if (Math.abs(sa.cy() - sb.cy()) < h * 0.3 && Math.abs(sa.h / sb.h - 1) < 0.35 && gap < h * 1.2) {
        const [removed] = segs.splice(b, 1);
        segs[b < a ? a - 1 : a].merge(removed);
        merged = true;
        break outer;
      }
    }
    if (!merged) {
      let b = 0;
      while (b < segs.length) {
        const sb = segs[b];
        let best = -1;
        for (let a = 0; a < segs.length; a++) {
          if (a === b) continue;
          const sa = segs[a];
          const gap = Math.max(sb.bbox[0] - sa.bbox[2], sa.bbox[0] - sb.bbox[2]);
          if (sa.bbox[2] - sa.bbox[0] > sb.bbox[2] - sb.bbox[0] && gap < sa.h * 1.2 && isScriptOn(sa.bbox, sa.h, sb.bbox, sb.h)
            && (best < 0 || Math.abs(sa.cy() - sb.cy()) < Math.abs(segs[best].cy() - sb.cy()))) best = a;
        }
        if (best >= 0) {
          const [removed] = segs.splice(b, 1);
          segs[b < best ? best - 1 : best].merge(removed);
          merged = true;
        } else b++;
      }
    }
  }

  // 2. Blocks.
  const byTop = segs.map((_, i) => i).sort((a, b) => segs[a].bbox[1] - segs[b].bbox[1]);
  const blocks = [];
  for (const si of byTop) {
    const s = segs[si];
    const target = blocks.findIndex(([members, bb]) => {
      const last = segs[members[members.length - 1]];
      const vgap = s.bbox[1] - last.bbox[3];
      const overlap = Math.min(s.bbox[2], bb[2]) - Math.max(s.bbox[0], bb[0]);
      const minw = Math.max(Math.min(s.bbox[2] - s.bbox[0], bb[2] - bb[0]), 1);
      return vgap > -last.h * 0.5 && vgap < Math.max(last.h, s.h) * 1.1 && overlap > minw * 0.3 && Math.abs(last.h / s.h - 1) < 0.6;
    });
    if (target >= 0) { blocks[target][0].push(si); union(blocks[target][1], s.bbox); }
    else blocks.push([[si], s.bbox.slice()]);
  }

  // 3. Block order.
  let remaining = blocks.map((_, i) => i);
  const blockOrder = [];
  const besideLeft = (cb, lb) => { const v = Math.min(lb[3], cb[3]) - Math.max(lb[1], cb[1]); return lb[2] <= cb[0] + 1 && v > 0.5 * Math.min(lb[3] - lb[1], cb[3] - cb[1]); };
  const firstLine = b => segs[blocks[b][0][0]]?.bbox ?? blocks[b][1];
  const minBy = (list, f) => list.reduce((best, x) => (best === undefined || f(x) < f(best) ? x : best), undefined);
  while (remaining.length) {
    const top = minBy(remaining, b => blocks[b][1][1]);
    let nextInColumn;
    const prev = blockOrder[blockOrder.length - 1];
    if (prev !== undefined) {
      const pb = blocks[prev][1];
      const lastSeg = segs[blocks[prev][0][blocks[prev][0].length - 1]];
      const pl = lastSeg ? lastSeg.bbox : pb;
      const tol = Math.max(pl[3] - pl[1], 0.1) * 0.5;
      const c = minBy(remaining.filter(cand => {
        const cb = blocks[cand][1];
        const overlap = Math.min(cb[2], pb[2]) - Math.max(cb[0], pb[0]);
        const minw = Math.max(Math.min(cb[2] - cb[0], pb[2] - pb[0]), 1);
        return cb[1] >= pb[3] - tol && overlap > minw * 0.3;
      }), b => blocks[b][1][1]);
      if (c !== undefined) {
        const cb = blocks[c][1];
        if (cb[1] - pb[3] < tol * 5) {
          const cl = firstLine(c);
          const blocked = remaining.some(r => {
            if (r === c) return false;
            const rb = blocks[r][1], rl = firstLine(r);
            const shared = Math.min(rl[3], cl[3]) - Math.max(rl[1], cl[1]);
            const row = shared > 0.3 * Math.max(rl[3] - rl[1], cl[3] - cl[1]);
            return (rb[1] < cb[1] && Math.min(rb[2], cb[2]) > Math.max(rb[0], cb[0])) || besideLeft(cb, rb) || row;
          });
          if (!blocked) nextInColumn = c;
        }
      }
    }
    let pick = nextInColumn;
    if (pick === undefined) {
      const tb = blocks[top][1];
      pick = minBy(remaining.filter(c => besideLeft(tb, blocks[c][1])), b => blocks[b][1][0]) ?? top;
    }
    remaining = remaining.filter(r => r !== pick);
    blockOrder.push(pick);
  }

  // 4. Emit each segment in block order, with word gaps relative to the line's letter gaps.
  const order = [], lineOf = [], spaceBefore = [];
  let line = 0;
  for (const b of blockOrder) {
    for (const si of blocks[b][0]) {
      const {placed, breaks} = placeGlyphs(glyphs, height, segs[si]);
      const h = segs[si].h;
      const gaps = [];
      for (let w = 0; w + 1 < placed.length; w++) {
        const p = glyphs[placed[w]], c = glyphs[placed[w + 1]];
        if (p.text === c.text && every(p.text, ch => !isAlnum(ch) && !isWs(ch))) {
          const same = i => glyphs[i]?.text === p.text;
          let before = 0; for (let k = w - 1; k >= 0 && before < 3 && same(placed[k]); k--) before++;
          let after = 0; for (let k = w + 2; k < placed.length && after < 3 && same(placed[k]); k++) after++;
          if (before + after >= 3) continue;
        }
        gaps.push(c.rect[0] - p.rect[2]);
      }
      gaps.sort((a, c) => a - c);
      const typical = Math.max(gaps[Math.floor(gaps.length / 3)] ?? 0, 0);
      const threshold = Math.max(typical + h * WORD_GAP, h * WORD_GAP);
      const spaces = new Array(placed.length).fill(false);
      for (let w = 0; w + 1 < placed.length; w++) {
        const p = placed[w], c = placed[w + 1];
        const gap = glyphs[c].rect[0] - glyphs[p].rect[2];
        const pt = glyphs[p].text, ct = glyphs[c].text;
        const cjk = any(pt, isCjk) && any(ct, isCjk) && gap < h * 0.5;
        const tight = (any(pt, isComplex) || any(ct, isComplex)) && gap < h * 0.6;
        const runStart = breaks.includes(c);
        spaces[w + 1] = (gap > threshold || runStart) && !cjk && !tight && !!pt.trim() && !!ct.trim();
      }
      let idx = placed;
      if (placed.some(i => any(glyphs[i].text, isRtl))) { idx = placed.slice(); reverseRtl(glyphs, idx, spaces); }
      for (let k = 0; k < idx.length; k++) { order.push(idx[k]); lineOf.push(line); spaceBefore.push(k === 0 ? false : !!spaces[k]); }
      line++;
    }
  }
  return {order: order.map(i => kept[i]), lineOf, spaceBefore};
}

/** layout.rs `layout`: glyphs in content order → PageText in reading order. */
export function layout(glyphs) {
  const {order, lineOf, spaceBefore} = arrange(glyphs);
  return new PageText(order.map(i => glyphs[i]), lineOf, spaceBefore);
}

// ── layout.rs flows and device.rs page assembly (turned, vertical and curved text) ─────────────

/** device.rs `DIRECTION_TOLERANCE`: largest sine between a glyph's direction and a flow's. */
export const DIRECTION_TOLERANCE = WORD_GAP;

/** device.rs `draw_glyph`: the writing direction to the nearest quarter turn (0 right, 1 down, 2 left, 3 up; view space, y down). */
export function quarterOf([dx, dy]) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2;
  return dy > 0 ? 1 : 3;
}

/** layout.rs `to_upright`: view-space box → the frame where text running `quarter` × 90° clockwise reads left to right. */
export function toUpright(r, quarter, w, h) {
  const [x0, y0, x1, y1] = r;
  switch (quarter) {
    case 1: return [y0, w - x1, y1, w - x0];
    case 2: return [w - x1, h - y1, w - x0, h - y0];
    case 3: return [h - y1, x0, h - y0, x1];
    default: return r.slice();
  }
}

/** layout.rs `from_upright`: the inverse of `toUpright`. */
export function fromUpright(r, quarter, w, h) {
  const [u0, v0, u1, v1] = r;
  switch (quarter) {
    case 1: return [w - v1, u0, w - v0, u1];
    case 2: return [w - u1, h - v1, w - u0, h - v0];
    case 3: return [v0, h - u1, v1, h - u0];
    default: return r.slice();
  }
}

/** layout.rs `compatible`: two writing directions close enough to share a frame. */
export const compatible = (a, b) => a[0] * b[0] + a[1] * b[1] > 0 && Math.abs(a[0] * b[1] - a[1] * b[0]) <= DIRECTION_TOLERANCE;

/**
 * layout.rs `along_baseline`: a view-space quad → its box in the frame where `u` runs left to
 * right and `u` turned a quarter clockwise runs downwards.
 */
export function alongBaseline(quad, u) {
  const p = quad.map(([x, y]) => [x * u[0] + y * u[1], y * u[0] - x * u[1]]);
  const a0 = (p[0][0] + p[3][0]) / 2, a1 = (p[1][0] + p[2][0]) / 2;
  let c0 = Infinity, c1 = -Infinity;
  for (const q of p) { c0 = Math.min(c0, q[1]); c1 = Math.max(c1, q[1]); }
  return [Math.min(a0, a1), c0, Math.max(a0, a1), c1];
}

/** layout.rs `continues`: whether drawn glyph `g` continues the line of `p` (content order), in `p`'s frame. */
export function continues(p, g) {
  const pu = p.u, gu = g.u;
  if (Math.abs(pu[0] * gu[1] - pu[1] * gu[0]) >= pu[0] * gu[0] + pu[1] * gu[1]) return false;
  const pb = alongBaseline(p.glyph.quad, pu), gb = alongBaseline(g.glyph.quad, pu), own = alongBaseline(g.glyph.quad, gu);
  const h = Math.max(Math.min(pb[3] - pb[1], own[3] - own[1]), 0.1);
  const cy = b => (b[1] + b[3]) / 2;
  return Math.abs(cy(gb) - cy(pb)) < h * 0.5 && gb[0] - pb[2] < h * 3 && gb[0] > pb[0] - h * 2;
}

/** layout.rs `unrolled`: boxes for glyphs set along a curve, the path straightened out. */
export function unrolled(run) {
  let pen = [0, 0];
  let previous = null;
  return run.map(d => {
    const b = alongBaseline(d.glyph.quad, d.u);
    if (previous) {
      const at = alongBaseline(d.glyph.quad, previous.u);
      pen = [pen[0] + at[0] - previous.b[0], pen[1] + (at[1] + at[3] - previous.b[1] - previous.b[3]) / 2];
    }
    previous = {u: d.u, b};
    const half = (b[3] - b[1]) / 2;
    return [pen[0], pen[1] - half, pen[0] + b[2] - b[0], pen[1] + half];
  });
}

/** layout.rs `arrange_flow`: lay out the page's glyphs `ids`, giving each the box at the same position in `rects`. */
export function arrangeFlow(drawn, ids, rects, quarter) {
  let top = Infinity;
  for (const i of ids) if (drawn[i]) top = Math.min(top, drawn[i].glyph.rect[1]);
  const framed = ids.map((i, k) => ({...drawn[i].glyph, rect: rects[k]}));
  const {order, lineOf, spaceBefore} = arrange(framed);
  return {top, quarter, ids: order.map(k => ids[k]), lineOf, spaceBefore};
}

/**
 * device.rs `extract_page_filtered` (after the interpreter): glyphs in content order, each
 * `{quarter, u, glyph}`, on a `w` × `h` view → the page text. Each writing direction is laid out in
 * its own frame (a horizontal heading must not force a vertical body into horizontal lines),
 * text on a curve is one line, and turned text keeps its place in the reading order.
 */
export function layoutPage(drawn, w, h) {
  const turned = u => Math.min(Math.abs(u[0]), Math.abs(u[1])) > DIRECTION_TOLERANCE;
  const inCurve = new Array(drawn.length).fill(false);
  const curves = [], straight = [];
  let start = 0;
  for (let end = 1; end <= drawn.length; end++) {
    if (end < drawn.length && continues(drawn[end - 1], drawn[end])) continue;
    const run = drawn.slice(start, end);
    if (run.some(d => turned(d.u)) && run.some(d => !compatible(run[0].u, d.u))) {
      for (let i = start; i < end; i++) inCurve[i] = true;
      const ids = [];
      for (let i = start; i < end; i++) ids.push(i);
      curves.push(ids);
    }
    start = end;
  }
  const quarters = [[], [], [], []];
  drawn.forEach((d, i) => {
    if (inCurve[i]) return;
    if (!turned(d.u)) { quarters[d.quarter]?.push(i); return; }
    const flow = straight.find(s => compatible(s.u, d.u));
    if (flow) flow.ids.push(i); else straight.push({u: d.u, ids: [i]});
  });
  const upright = qs => qs.map((ids, quarter) => [quarter, ids]).filter(([, ids]) => ids.length)
    .map(([quarter, ids]) => arrangeFlow(drawn, ids, ids.map(i => toUpright(drawn[i].glyph.rect, quarter, w, h)), quarter))
    .sort((a, b) => a.top - b.top);
  const flows = upright(quarters);
  const extra = [...curves.map(ids => [null, ids]), ...straight.map(s => [s.u, s.ids])].map(([u, ids]) => {
    const rects = u ? ids.map(i => alongBaseline(drawn[i].glyph.quad, u)) : unrolled(ids.map(i => drawn[i]));
    return arrangeFlow(drawn, ids, rects, null);
  });
  let rank = [];
  if (extra.length) {
    rank = new Array(drawn.length).fill(Infinity);
    const nearest = [[], [], [], []];
    drawn.forEach((d, i) => nearest[d.quarter]?.push(i));
    let r = 0;
    for (const f of upright(nearest)) for (const i of f.ids) rank[i] = r++;
  }
  const first = ids => { let m = Infinity; for (const i of ids) if (rank[i] !== undefined && rank[i] < m) m = rank[i]; return m; };
  extra.sort((a, b) => first(a.ids) - first(b.ids));
  const slots = drawn.map(d => d.glyph);
  const glyphs = [], lineOf = [], spaceBefore = [];
  const emit = (ids, lines, spaces) => {
    const offset = lineOf.length ? lineOf[lineOf.length - 1] + 1 : 0;
    ids.forEach((i, k) => {
      const g = slots[i];
      if (!g) return;
      slots[i] = null;
      glyphs.push(g);
      lineOf.push(lines[k] + offset);
      spaceBefore.push(spaces[k]);
    });
  };
  let e = 0;
  for (const flow of flows) {
    let k = 0;
    while (k < flow.ids.length) {
      const line = flow.lineOf[k];
      let end = k;
      while (end < flow.ids.length && flow.lineOf[end] === line) end++;
      const before = first(flow.ids.slice(k, end));
      while (e < extra.length && first(extra[e].ids) < before) { const f = extra[e++]; emit(f.ids, f.lineOf, f.spaceBefore); }
      emit(flow.ids.slice(k, end), new Array(end - k).fill(0), flow.spaceBefore.slice(k, end));
      k = end;
    }
  }
  for (; e < extra.length; e++) emit(extra[e].ids, extra[e].lineOf, extra[e].spaceBefore);
  return new PageText(glyphs, lineOf, spaceBefore);
}

// ── text.rs ─────────────────────────────────────────────────────────────────────────────────

export class PageText {
  constructor(glyphs = [], lineOf = [], spaceBefore = []) {
    this.glyphs = glyphs;
    this.lineOf = lineOf;
    this.spaceBefore = spaceBefore;
    this._plain = null;
  }
  static fromJSON(o) { return new PageText(o?.glyphs ?? [], o?.lineOf ?? [], o?.spaceBefore ?? []); }
  toJSON() { return {glyphs: this.glyphs, lineOf: this.lineOf, spaceBefore: this.spaceBefore}; }
  isEmpty() { return !this.glyphs.length; }

  /** Glyphs `[start, end)` with spaces and line breaks reconstructed. */
  textOf(start, end) {
    let s = '', prev = null;
    for (let i = start; i < end && i < this.glyphs.length; i++) {
      if (i !== start) {
        if (prev !== this.lineOf[i]) s += '\n';
        else if (this.spaceBefore[i]) s += ' ';
      }
      s += this.glyphs[i].text;
      prev = this.lineOf[i];
    }
    return s;
  }

  /** The page text and each glyph's UTF-16 span in it (the chars: address space). */
  plain() {
    if (this._plain) return this._plain;
    let s = '';
    const charStart = new Array(this.glyphs.length), charEnd = new Array(this.glyphs.length);
    for (let i = 0; i < this.glyphs.length; i++) {
      if (i > 0) {
        if (this.lineOf[i - 1] !== this.lineOf[i]) s += '\n';
        else if (this.spaceBefore[i]) s += ' ';
      }
      charStart[i] = s.length;
      s += this.glyphs[i].text;
      charEnd[i] = s.length;
    }
    this._plain = {text: s, charStart, charEnd};
    return this._plain;
  }
  plainText() { return this.plain().text; }

  /** Glyph range [first, last] (inclusive) covering the UTF-16 range [from, to) of plainText(); null if none. */
  glyphRange(from, to) {
    const {charStart, charEnd} = this.plain();
    let first = -1, last = -1;
    for (let i = 0; i < this.glyphs.length; i++) {
      if (charEnd[i] > from && charStart[i] < to) { if (first < 0) first = i; last = i; }
    }
    return first < 0 ? null : [first, last];
  }
  /** UTF-16 range [from, to) of glyphs first..last (inclusive). */
  charRange(first, last) {
    const {charStart, charEnd} = this.plain();
    const a = Math.min(first, last), b = Math.max(first, last);
    return [charStart[a] ?? 0, charEnd[b] ?? 0];
  }

  /** Index of the glyph nearest to a view-space point. */
  nearest(x, y) {
    const centreDistance = g => { const cx = g.quad.reduce((s, q) => s + q[0], 0) / 4, c2 = g.quad.reduce((s, q) => s + q[1], 0) / 4; return (cx - x) ** 2 + (c2 - y) ** 2; };
    let inside = null, best = Infinity;
    this.glyphs.forEach((g, i) => { if (quadContains(g.quad, x, y)) { const d = centreDistance(g); if (d < best) { best = d; inside = i; } } });
    if (inside !== null) return inside;
    let pick = null, bd = Infinity, bc = Infinity;
    this.glyphs.forEach((g, i) => {
      const dx = x < g.rect[0] ? g.rect[0] - x : x > g.rect[2] ? x - g.rect[2] : 0;
      const dy = y < g.rect[1] ? g.rect[1] - y : y > g.rect[3] ? y - g.rect[3] : 0;
      const d = dx + dy * 3, c = centreDistance(g);
      if (d < bd || (d === bd && c < bc)) { bd = d; bc = c; pick = i; }
    });
    return pick;
  }

  /** The word around glyph `i` (double-click): stops at word gaps, blank glyphs and line ends. */
  wordAt(i) {
    if (!this.glyphs[i]) return null;
    const blank = k => !this.glyphs[k] || !this.glyphs[k].text.trim();
    const joined = k => !(this.spaceBefore[k] ?? true) && this.lineOf[k - 1] === this.lineOf[k] && k < this.glyphs.length;
    let first = i, last = i;
    while (first > 0 && joined(first) && !blank(first - 1)) first--;
    while (joined(last + 1) && !blank(last + 1)) last++;
    return [first, last];
  }

  /** The line around glyph `i` (triple-click). */
  lineAt(i) {
    if (!this.glyphs[i]) return null;
    const line = this.lineOf[i];
    let first = i, last = i;
    while (first > 0 && this.lineOf[first - 1] === line) first--;
    while (last + 1 < this.glyphs.length && this.lineOf[last + 1] === line) last++;
    return [first, last];
  }

  /** One rectangle per line for glyphs [start, end) (highlighting, markup quads). */
  lineRects(start, end) { const ids = []; for (let i = start; i < end; i++) ids.push(i); return this.mergedRects(ids); }
  glyphRects(ids) { return this.mergedRects(ids); }
  mergedRects(ids) {
    const out = [];
    for (const i of ids) {
      const g = this.glyphs[i], line = this.lineOf[i];
      if (!g || line === undefined) break;
      const last = out[out.length - 1];
      if (last && last.line === line && last.last + 1 === i) { last.last = i; union(last.rect, g.rect); }
      else out.push({line, last: i, rect: g.rect.slice()});
    }
    return out.map(o => o.rect);
  }

  /** Glyphs whose centre lies inside a view rectangle (column select). */
  glyphsIn(r) {
    const x0 = Math.min(r[0], r[2]), x1 = Math.max(r[0], r[2]), y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
    const out = [];
    this.glyphs.forEach((g, i) => { const cx = (g.rect[0] + g.rect[2]) / 2, cy = (g.rect[1] + g.rect[3]) / 2; if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) out.push(i); });
    return out;
  }

  /**
   * text.rs `column_text`: the text of a column selection as it looks on the page, one row per
   * visual line; pieces side by side are separated by a tab; vertical or turned text comes out one
   * line per row in reading order.
   */
  columnText(ids) {
    const lines = [], lineIds = [];
    for (const i of ids) {
      const g = this.glyphs[i], line = this.lineOf[i];
      if (!g || line === undefined) continue;
      if (lines.length && lineIds[lineIds.length - 1] === line) { const l = lines[lines.length - 1]; l[0].push(i); union(l[1], g.rect); }
      else { lines.push([[i], g.rect.slice()]); lineIds.push(line); }
    }
    const vertical = ids.some(i => this.glyphs[i] && Math.abs(this.glyphs[i].direction?.[1] ?? 0) > WORD_GAP);
    const piece = members => {
      let s = '', prev = null;
      for (const i of members) {
        const g = this.glyphs[i];
        if (!g) continue;
        const gap = !!this.spaceBefore[i] || (prev !== null && prev + 1 !== i);
        if (prev !== null && gap) s += ' ';
        s += g.text;
        prev = i;
      }
      return s;
    };
    if (vertical) return lines.map(([m]) => piece(m)).join('\n');
    const order = lines.map((_, k) => k).sort((a, b) => (lines[a][1][1] + lines[a][1][3]) / 2 - (lines[b][1][1] + lines[b][1][3]) / 2);
    const rows = [];
    for (const k of order) {
      const bb = lines[k][1], cy = (bb[1] + bb[3]) / 2;
      const last = rows[rows.length - 1];
      if (last && cy >= last[0] && cy <= last[1]) last[2].push(k);
      else rows.push([bb[1], bb[3], [k]]);
    }
    const rtl = members => members.some(i => any(this.glyphs[i]?.text ?? '', isRtl));
    return rows.map(([, , members]) => {
      const rightToLeft = members.every(k => rtl(lines[k][0]));
      members.sort((a, b) => (rightToLeft ? lines[b][1][0] - lines[a][1][0] : lines[a][1][0] - lines[b][1][0]));
      return members.map(k => piece(lines[k][0])).join('\t');
    }).join('\n');
  }

  /**
   * search.rs `find_with`: glyph ranges [start, end) of every match of `matcher(chars)`, which gets the page text as an
   * array of characters (a space for each word gap and line break, case kept) and returns character ranges [a, b).
   */
  findWith(matcher) {
    const chars = [];
    const owner = [];
    this.glyphs.forEach((glyph, i) => {
      const lineBreak = i > 0 && this.lineOf[i - 1] !== this.lineOf[i];
      const gap = this.spaceBefore[i] || lineBreak;
      if (i > 0 && gap && chars.length && chars[chars.length - 1] !== ' ') { chars.push(' '); owner.push(i); }
      for (let c of glyph.text) {
        if (isWs(c)) c = ' ';
        if (c !== ' ' || !chars.length || chars[chars.length - 1] !== ' ') { chars.push(c); owner.push(i); }
      }
    });
    return matcher(chars).filter(([x, y]) => y > x).map(([x, y]) => [owner[x], owner[y - 1] + 1]);
  }

  /** search.rs `find`: glyph ranges [start, end) of every match. */
  find(query, {caseSensitive = false, wholeWords = false, limit = Infinity} = {}) {
    if (limit === 0) return [];
    const fold = s => (caseSensitive ? s : foldCase(s));
    const needle = [...fold(query).split(/\s+/).filter(Boolean).join(' ')];
    if (!needle.length) return [];
    const chars = [];
    this.glyphs.forEach((glyph, i) => {
      const lineBreak = i > 0 && this.lineOf[i - 1] !== this.lineOf[i];
      const gap = this.spaceBefore[i] || lineBreak;
      if (i > 0 && gap && chars.length && chars[chars.length - 1][0] !== ' ') chars.push([' ', i]);
      for (let c of fold(glyph.text)) {
        if (isWs(c)) c = ' ';
        if (c !== ' ' || !chars.length || chars[chars.length - 1][0] !== ' ') chars.push([c, i]);
      }
    });
    if (needle.length > chars.length) return [];
    const prefix = new Array(needle.length).fill(0);
    const advance = (m, c) => { while (m > 0 && needle[m] !== c) m = prefix[m - 1]; return needle[m] === c ? m + 1 : 0; };
    let matched = 0;
    for (let i = 1; i < needle.length; i++) { matched = advance(matched, needle[i]); prefix[i] = matched; }
    matched = 0;
    const word = k => k !== undefined && k >= 0 && chars[k] && isAlnum(chars[k][0]);
    const hits = [];
    for (let i = 0; i < chars.length; i++) {
      matched = advance(matched, chars[i][0]);
      if (matched !== needle.length) continue;
      const end = i + 1, start = end - needle.length;
      const bounded = !wholeWords || (!word(start - 1) && !word(end));
      if (bounded) {
        hits.push([chars[start][1], chars[i][1] + 1]);
        if (hits.length === limit) break;
        matched = 0;
      } else matched = prefix[prefix.length - 1] ?? 0;
    }
    return hits;
  }
}
