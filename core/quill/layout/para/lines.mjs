// Line breaking: first-fit lines around floating objects, tabs, alignment and justification,
// line heights, the list label and the drop cap.
//
// Translated from wordcraft crates/layout/src/para/lines.rs and para/grid.rs (`Grid`, `Exclusion`,
// `snap_chars`, `auto_space`) (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c).
// Tight/Through contours (`contour.rs`) are not translated: an exclusion is its wrap rectangle.
import {CL, END, Line, binHas} from './model.mjs';
import {evenRow, reorderLine} from './bidi.mjs';
import {HYPHENATION_ZONE, hyphenGlyph, shrinkLineSpaces, spaceRoom} from './justify.mjs';
import {nextTab, plTextAt, ptabStop, resolveTab} from './tabs.mjs';
import {lineExtent} from './builder.mjs';
import {isEastAsian, autoSpace as autoSpacePair} from './linebreak.mjs';

const MIN_LINE_WIDTH = 1.0;
/** Narrowest span text flows into beside a floating object, points. */
const MIN_SPAN = 20.0;

/** The section's document grid (Grid). */
export const NO_GRID = Object.freeze({line: null, chars: null, fontSize: 0, snapAll: false});
export const gridKey = g => `${g.line ?? 0}|${g.chars ?? 0}|${g.fontSize}|${g.snapAll}`;
export function snapHeight(g, h) {
  if (g.line === null || !Number.isFinite(h)) return h;
  return Math.min(Math.max(1, Math.min(10_000, Math.ceil(h / g.line - 0.001))) * g.line, 1e6);
}
/** Does exclusion `e` reach into the row at `top` (Exclusion::intersects_row)? */
export function intersectsRow(e, top, h, tableH, lo, hi) {
  const reaches = e.table ? e.top <= top + tableH : e.top < top + h;
  return e.bottom > top && reaches && e.right > lo && e.left < hi;
}

/** Text on a character grid keeps to its cells (snap_chars). */
export function snapChars(clusters, styles, text, grid) {
  const pitch = grid.chars;
  if (pitch === null) return;
  const base = Math.max(grid.fontSize, 1);
  for (const c of clusters) {
    if (!(c.kind === CL.TEXT || c.kind === CL.SPACE) || c.adv <= 0) continue;
    const ch = text.codePointAt(c.start);
    const ea = isEastAsianGrid(ch);
    if (!(ea || (grid.snapAll && c.kind === CL.TEXT))) continue;
    const size = styles[c.style]?.size ?? base;
    const cells = Math.max(1, Math.min(64, ea ? Math.round(size / base) : Math.ceil(c.adv / pitch - 0.01)));
    const adv = cells * pitch;
    c.dx += (adv - c.adv) / 2;
    c.adv = adv;
  }
}
const isEastAsianGrid = c => (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0x2fdf) || (c >= 0x2ff0 && c <= 0x303f) || (c >= 0x3040 && c <= 0x30ff)
  || (c >= 0x3100 && c <= 0x312f) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x3190 && c <= 0x31ff) || (c >= 0x3200 && c <= 0x4dbf)
  || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa960 && c <= 0xa97f) || (c >= 0xac00 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xfaff)
  || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff01 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3ffff);

/** Room after a cluster between Asian and Latin text or digits (auto_space): [[clusterIndex, gap]]. */
export function autoSpace(clusters, styles, shown, text, de, dn) {
  const out = [];
  if (!de && !dn) return out;
  const shownAt = new Map(shown.map(([k, t]) => [k, t]));
  let prev = null;
  for (let k = 0; k < clusters.length; k++) {
    const c = clusters[k];
    if (c.kind !== CL.TEXT) { if (!(c.kind === CL.MARKER && c.adv === 0)) prev = null; continue; }
    const s = shownAt.get(k) ?? text.slice(c.start, c.end);
    if (!s) { prev = null; continue; }
    const first = s.codePointAt(0);
    const chars = [...s];
    const last = chars[chars.length - 1].codePointAt(0);
    const size = styles[c.style]?.size ?? 0;
    if (prev) {
      const side = autoSpacePair(prev[1], first, de, dn);
      if (side) {
        const asian = side === 'left' ? prev[2] : size;
        const gap = Number.isFinite(asian) ? Math.max(0, Math.min(400, asian / 4)) : 0;
        clusters[prev[0]].adv += gap;
        out.push([prev[0], gap]);
      }
    }
    prev = [k, last, size];
  }
  return out;
}
export {isEastAsian};

/** Whether anything but markers is among clusters c0..j (has_content). */
function hasContent(pl, c0, j) {
  for (let k = c0; k < j; k++) if (pl.clusters[k] && pl.clusters[k].kind !== CL.MARKER) return true;
  return false;
}
/** A line's first item stays on it even when it doesn't fit (takes_room). */
const takesRoom = c => c.kind !== CL.MARKER && !(c.kind === CL.OBJECT && c.adv === 0 && c.objH === 0);

function widthToDecimal(pl, tj, j) {
  let w = 0;
  for (let k = tj + 1; k <= j; k++) {
    const cc = pl.clusters[k];
    if (!cc) return null;
    if (plTextAt(cc)) return w;
    w += cc.adv;
  }
  return null;
}

function mirroredExclusions(ex, width) {
  return ex.map(e => ({...e, left: width - e.right, right: width - e.left, side: e.side === 'left' ? 'right' : e.side === 'right' ? 'left' : e.side}));
}

/** The width of the word starting at each cluster (word_widths). */
export function wordWidths(clusters, hyphAfter) {
  const n = clusters.length;
  const width = new Float64Array(n + 1);
  for (let k = n - 1; k >= 0; k--) {
    const c = clusters[k];
    const adv = c.kind === CL.SPACE ? 0 : c.adv;
    width[k] = c.breakAfter && !binHas(hyphAfter, k) ? adv : adv + width[k + 1];
  }
  return width;
}

/** How far below a line's top its baseline sits (baseline_offset). */
function baselineOffset(spacing, asc, height, desc) {
  return spacing.rule === 'multiple' ? asc * Math.min(spacing.value, 1) : height - desc;
}

/** The spans of a row text can use around the exclusions (row_spans): {spans} or {below}. */
function rowSpans(exclusions, top, h, tableH, lo, hi) {
  const here = exclusions.filter(e => intersectsRow(e, top, h, tableH, lo, hi));
  let below = null;
  for (const e of here) if (e.topBottom) below = below === null ? e.bottom : Math.max(below, e.bottom);
  if (below !== null) return {below};
  let taken = [];
  for (const e of here) {
    let left = e.left, right = e.right;
    if (e.side === 'bothSides' || !e.side) { taken.push([left, right, e.bottom]); continue; }
    const textLeft = e.side === 'left' ? true : e.side === 'right' ? false : left - lo >= hi - right;
    taken.push(textLeft ? [left, Math.max(hi, right), e.bottom] : [Math.min(lo, left), right, e.bottom]);
  }
  taken = taken.filter(([l, r]) => r > lo && l < hi);
  if (!taken.length) return {spans: [[lo, hi]]};
  let spans = [[lo, hi]];
  for (const [left, right] of taken) {
    spans = spans.flatMap(([a, b]) => (right <= a || left >= b ? [[a, b]] : [[a, Math.min(left, b)], [Math.max(right, a), b]]));
  }
  spans = spans.filter(([a, b]) => b - a >= MIN_SPAN);
  if (!spans.length) return {below: taken.reduce((m, t) => Math.min(m, t[2]), Infinity) === Infinity ? top : taken.reduce((m, t) => Math.min(m, t[2]), Infinity)};
  return {spans};
}

/**
 * Break a paragraph into lines, measure each line, apply the alignment and place the label
 * (break_lines). Fills `pl.lines`, `pl.height` and the label's position.
 */
export function breakLines(pl, env, markStyle, level) {
  const width = Math.max(env.width, MIN_LINE_WIDTH);
  const exclusions = pl.rp.bidi ? mirroredExclusions(env.exclusions, width) : env.exclusions;
  const bk = new Breaker(pl, env, exclusions, markStyle, level);
  for (;;) {
    const sc = bk.beginLine(pl);
    sc.scan(bk, pl);
    if (sc.skip) { bk.skipRow(sc); continue; }
    const end = bk.closeLine(pl, sc);
    if (bk.nextLine(pl, end)) break;
  }
  bk.finish(pl);
}

class Breaker {
  constructor(pl, env, exclusions, markStyle, level) {
    const rp = pl.rp;
    const width = Math.max(env.width, MIN_LINE_WIDTH);
    const s = env.doc.settings;
    const ms = pl.styles[markStyle];
    const est = ms ? (ms.ascent + ms.descent) * (rp.lineSpacing.rule === 'multiple' ? rp.lineSpacing.value : 1) : 14;
    this.level = level;
    this.markStyle = markStyle;
    this.exclusions = exclusions;
    this.n = pl.clusters.length;
    this.width = width;
    this.baseRight = Math.max(width - rp.indentRight, 1);
    this.firstLeft = rp.indentLeft + rp.indentFirst;
    this.defaultTab = s.defaultTab ?? 36;
    this.hangingAt = rp.indentFirst < 0 ? rp.indentLeft : null;
    this.shrinkSpaces = rp.align === 'justify' && (s.compatMode ?? 15) >= 15;
    this.expandBreak = !s.doNotExpandShiftReturn;
    const z = s.hyphenationZone;
    this.zone = Math.min(Number.isFinite(z) && z >= 0 ? z : HYPHENATION_ZONE, 1584);
    this.hyphLimit = s.consecutiveHyphenLimit ?? 0;
    this.widths = wordWidths(pl.clusters, pl.hyphAfter);
    this.rtlPara = !!rp.bidi;
    this.grid = env.grid && env.grid.line !== null && rp.snapToGrid ? env.grid : null;
    this.bidi = rp.bidi || pl.bidiLevels.length > 0;
    this.estH = Math.max(est, 1);
    this.tableH = rp.lineSpacing.rule === 'exactly' ? rp.lineSpacing.value : this.estH;
    this.rp = rp;
    this.shaper = env.shaper;
    this.firstX0 = null;
    this.hcache = [];
    this.lines = [];
    this.labelShifts = [0, 0];
    this.i = 0;
    this.top = 0;
    this.first = true;
    this.rowRest = [];
    this.rowFirst = 0;
    this.skipped = 0;
    this.wrappedTab = null;
  }

  rowLeft(pl) {
    const lo = this.first ? this.firstLeft : this.rp.indentLeft;
    const dc = pl.dropCap;
    if (dc && dc.indent > 0 && this.lines.length < dc.lines) return Math.max(this.firstLeft, this.rp.indentLeft) + dc.indent;
    return lo;
  }

  nextSpan(pl) {
    const narrowed = this.rowRest.length > 0;
    if (narrowed) { const [l, r] = this.rowRest.shift(); return [l, r, true]; }
    for (let guard = 0; ; guard++) {
      const lo = this.rowLeft(pl);
      const rs = rowSpans(this.exclusions, this.top, this.estH, this.tableH, lo, this.baseRight);
      if (rs.spans) {
        const [a, b] = rs.spans.shift();
        const nar = rs.spans.length > 0 || a > lo || b < this.baseRight;
        this.rowRest = rs.spans;
        this.rowFirst = this.lines.length;
        return [a, Math.max(b, a + MIN_LINE_WIDTH), nar];
      }
      if (rs.below > this.top && guard < 50) { this.top = rs.below; continue; }
      this.rowFirst = this.lines.length;
      return [lo, Math.max(this.baseRight, lo + MIN_LINE_WIDTH), narrowed];
    }
  }

  beginLine(pl) {
    const beside = this.rowRest.length > 0 && this.lines.length > this.rowFirst;
    const rowLo = this.first ? this.firstLeft : this.rp.indentLeft;
    const [left, rightEdge, narrowed] = this.nextSpan(pl);
    const x = this.first ? this.placeLabel(pl, left) : left;
    let hyphRun = 0;
    for (let q = this.lines.length - 1; q >= 0 && this.lines[q].hyphen; q--) hyphRun++;
    return new Scan({left, rightEdge, rowLo, narrowed, beside, c0: this.i, lineStartX: x, x, wordFrom: left,
      hyphOk: this.hyphLimit === 0 || hyphRun < this.hyphLimit, j: this.i});
  }

  placeLabel(pl, left) {
    const lab = pl.label;
    if (!lab) return left;
    const align = this.level?.align;
    lab.x = align === 'center' ? left - lab.width / 2 : align === 'right' ? left - lab.width : left;
    const end = lab.x + lab.width;
    const suffix = this.level?.suffix ?? 'tab';
    if (suffix === 'tab') {
      const t = nextTab(end, this.rp.tabs, this.defaultTab, this.hangingAt).pos;
      const own = this.level?.tab;
      return Number.isFinite(own) && own > end + 0.01 && own < t ? own : t;
    }
    if (suffix === 'space') return end + (pl.styles[lab.style]?.size ?? 12) * 0.25;
    return end;
  }

  skipRow(sc) {
    this.skipped++;
    if (this.rowRest.length) return;
    if (this.lines.length > this.rowFirst) this.top += evenRow(this.lines.slice(this.rowFirst));
    else {
      let m = null;
      for (const e of this.exclusions) if (intersectsRow(e, this.top, this.estH, this.tableH, sc.rowLo, this.baseRight)) m = m === null ? e.bottom : Math.min(m, e.bottom);
      this.top = m ?? this.top + this.estH;
    }
  }

  closeLine(pl, sc) {
    if (sc.end === END.PARA || sc.end === END.WRAP) sc.x += resolveTab(pl, sc.pending, sc.xs, sc.c0, sc.x);
    if (sc.j >= this.n && sc.end !== END.WRAP && sc.end !== END.LINE_BREAK && sc.end !== END.PAGE_BREAK && sc.end !== END.COLUMN_BREAK) sc.end = END.PARA;
    const [c1, j, hyphen] = this.settleClusters(pl, sc);
    const v = this.measure(pl, sc.c0, c1);
    this.align(pl, sc, c1);
    const start = pl.clusters[sc.c0]?.start ?? pl.textLen;
    const stop = c1 > sc.c0 ? pl.clusters[c1 - 1]?.end ?? pl.textLen : start;
    if (this.firstX0 === null) this.firstX0 = sc.xs[0] ?? null;
    const line = new Line({top: this.top, height: v.height, baseline: v.baseline, textAsc: v.textAsc, textDesc: v.textDesc, c0: sc.c0, c1,
      xs: sc.xs, leaders: sc.leaders, end: sc.end, start, stop, left: sc.left, right: sc.rightEdge, hyphen, beside: sc.beside, vis: [], rtl: this.rtlPara});
    if (this.bidi) reorderLine(pl, line, this.width);
    this.lines.push(line);
    this.first = false;
    this.skipped = 0;
    this.i = j;
    return sc.end;
  }

  settleClusters(pl, sc) {
    const c0 = sc.c0, n = this.n;
    let c1 = Math.max(sc.j, c0), j = sc.j;
    if (c1 === c0 && c0 < n) { c1 = c0 + 1; j = c0 + 1; }
    while (sc.xs.length < c1 - c0) {
      const last = sc.xs.length ? sc.xs[sc.xs.length - 1] : sc.lineStartX;
      const adv = pl.clusters[c0 + Math.max(sc.xs.length - 1, 0)]?.adv ?? 0;
      sc.xs.push(sc.xs.length ? last + adv : sc.lineStartX);
    }
    sc.xs.length = c1 - c0;
    let hyphen = null;
    if (sc.end === END.WRAP && c1 > c0 && binHas(pl.hyphAfter, c1 - 1)) {
      const c = pl.clusters[c1 - 1];
      if (c) hyphen = hyphenGlyph(pl, c.style, this.hcache, this.shaper);
    }
    const lc = c1 > 0 ? pl.clusters[c1 - 1] : null;
    const endX = sc.xs.length && lc ? sc.xs[sc.xs.length - 1] + lc.adv + (hyphen ? hyphen.adv : 0) : sc.lineStartX;
    sc.xs.push(endX);
    return [c1, j, hyphen];
  }

  extents(pl, c0, c1) {
    const rp = this.rp;
    let asc = 0, desc = 0, objAsc = 0, any = false;
    const dropped = pl.dropCap ? pl.dropCap.clusters : 0;
    for (let k = c0; k < c1; k++) {
      const c = pl.clusters[k];
      const anchor = c.kind === CL.OBJECT && c.adv === 0 && c.objH === 0;
      if (c.kind === CL.MARKER || c.kind === CL.SPACE || c.kind === CL.TAB || anchor || k < dropped) continue;
      const st = pl.styles[c.style];
      if (!st) continue;
      let a, d;
      if (c.kind === CL.OBJECT && c.objH > 0) {
        if (pl.maths.some(([oi]) => oi === c.obj)) {
          [a, d] = rp.lineSpacing.rule === 'exactly' ? [st.ascent, st.descent] : [c.objH, c.objD];
        } else {
          objAsc = Math.max(objAsc, c.objH);
          [a, d] = [st.ascent, st.descent];
        }
      } else {
        const [la, ld] = lineExtent(st);
        a = Math.max(la, c.objH + st.shift);
        d = ld;
      }
      asc = Math.max(asc, a);
      desc = Math.max(desc, d);
      any = true;
    }
    if (!any || (asc === 0 && desc === 0)) {
      const st = pl.styles[this.markStyle];
      if (st) { asc = st.ascent; desc = st.descent; }
    }
    return {asc, desc, objAsc};
  }

  measure(pl, c0, c1) {
    const rp = this.rp;
    let {asc, desc, objAsc} = this.extents(pl, c0, c1);
    const textNatural = asc + desc;
    const textAsc = Math.max(asc, objAsc), textDesc = desc;
    const textPictures = objAsc > asc ? objAsc + desc : 0;
    let labelExtra = 0;
    if (this.first && pl.label) {
      const lab = pl.label;
      if (rp.lineSpacing.rule !== 'exactly') {
        labelExtra = Math.max(lab.ascent - asc, 0);
        asc = Math.max(asc, lab.ascent);
      } else {
        for (const r of lab.runs) { const st = pl.styles[r.style]; if (st) { asc = Math.max(asc, st.ascent); desc = Math.max(desc, st.descent); } }
      }
    }
    const natural = asc + desc;
    const pictures = objAsc > asc ? objAsc + desc : 0;
    const g = this.grid;
    const ls = rp.lineSpacing;
    let height, centred = false;
    if (ls.rule === 'multiple' && g) { height = Math.max(snapHeight(g, natural) * ls.value, snapHeight(g, pictures)); centred = true; } else if (ls.rule === 'atLeast' && g) { height = Math.max(snapHeight(g, Math.max(natural, pictures)), ls.value); centred = true; } else if (ls.rule === 'multiple') height = Math.max(textNatural * ls.value + labelExtra, textPictures);
    else if (ls.rule === 'atLeast') height = Math.max(natural, textPictures, ls.value);
    else height = ls.value;
    let baseline;
    if (centred) {
      const up = Math.max(asc, objAsc);
      baseline = this.top + Math.max((height - up - desc) / 2, 0) + up;
    } else baseline = this.top + Math.max(baselineOffset(ls, asc, height, desc), Math.min(objAsc, height - desc));
    return {height, baseline, textAsc, textDesc};
  }

  align(pl, sc, c1) {
    const rp = this.rp;
    const c0 = sc.c0;
    const ce = contentEnd(pl, sc, c1);
    const slack = sc.rightEdge - ce;
    let lastTab = null;
    for (let k = c1 - 1; k >= c0; k--) if (pl.clusters[k]?.kind === CL.TAB) { lastTab = k; break; }
    const alignFrom = lastTab !== null ? lastTab + 1 : c0;
    const disp = pl.displays.find(([ci]) => ci >= c0 && ci < c1);
    const display = disp ? disp[1] : null;
    let shift = 0;
    if (display !== null) shift = display === 'left' ? 0 : display === 'right' ? slack : slack / 2;
    else if (rp.align === 'center') shift = slack / 2;
    else if (rp.align === 'right') shift = slack;
    if (shift > 0 && slack > 0) {
      for (let i = alignFrom - c0; i < sc.xs.length; i++) sc.xs[i] += shift;
      if (lastTab === null && this.lines.length < 2) this.labelShifts[this.lines.length] = shift;
    }
    const stretchEnd = sc.end === END.WRAP || (sc.end === END.LINE_BREAK && this.expandBreak);
    const justify = display === null && ((rp.align === 'justify' && stretchEnd) || rp.align === 'distribute');
    const shrink = display === null && this.shrinkSpaces && slack < 0 && lastTab === null;
    if (shrink) shrinkLineSpaces(pl, sc.xs, c0, c1, ce, slack);
    else if (justify && slack > 0) justifyLine(pl, sc.xs, c0, c1, alignFrom, ce, slack, rp.align === 'distribute');
  }

  nextLine(pl, end) {
    if (end !== END.WRAP || this.i >= this.n) this.rowRest = [];
    if (!this.rowRest.length) this.top += evenRow(this.lines.slice(this.rowFirst));
    if (this.i >= this.n) {
      if (end === END.LINE_BREAK || end === END.PAGE_BREAK || end === END.COLUMN_BREAK) this.emptyLastLine(pl);
      return true;
    }
    return this.lines.length > 200_000;
  }

  emptyLastLine(pl) {
    const rp = this.rp, g = this.grid;
    const st = pl.styles[this.markStyle];
    const [asc, desc] = st ? [st.ascent, st.descent] : [10, 3];
    const natural = asc + desc, ls = rp.lineSpacing;
    let h;
    if (ls.rule === 'multiple' && g) h = snapHeight(g, natural) * ls.value;
    else if (ls.rule === 'atLeast' && g) h = Math.max(snapHeight(g, natural), ls.value);
    else if (ls.rule === 'multiple') h = natural * ls.value;
    else if (ls.rule === 'atLeast') h = Math.max(natural, ls.value);
    else h = ls.value;
    const width = this.width;
    let x0 = rp.indentLeft, left = x0, right = this.baseRight;
    if (this.rtlPara) { left = width - this.baseRight; right = width - x0; x0 = width - x0; }
    this.lines.push(new Line({top: this.top, height: h, baseline: this.top + (g ? h - desc : baselineOffset(ls, asc, h, desc)), textAsc: asc,
      textDesc: desc, c0: this.n, c1: this.n, xs: [x0], leaders: [], end: END.PARA, start: pl.textLen, stop: pl.textLen, left, right,
      hyphen: null, beside: false, vis: [], rtl: this.rtlPara}));
    this.top += h;
  }

  hangDropCap(pl) {
    const rp = this.rp, lines = this.lines;
    const dc = pl.dropCap;
    if (!dc) return;
    const l0 = lines[0], ln = lines[Math.max(Math.min(dc.lines, lines.length) - 1, 0)];
    if (!l0 || !ln) return;
    const short = lines.length < dc.lines;
    const dy = short ? (dc.lines - 1) * l0.height : ln.baseline - l0.baseline;
    const lead = (this.firstX0 ?? 0) - Math.max(this.firstLeft, rp.indentLeft);
    let dx = rp.dropCapMargin ? Math.max(lead, 0) + pl.dropCapW + rp.dropCapDistance : Math.min(dc.indent, lead);
    if (this.rtlPara) dx = pl.dropCapW - dx;
    if (short) this.top = Math.max(this.top, l0.top + l0.height * dc.lines);
    for (let k = 0; k < dc.clusters; k++) { const c = pl.clusters[k]; c.dy -= dy; c.dx -= dx; }
  }

  finish(pl) {
    this.hangDropCap(pl);
    pl.height = this.top;
    pl.lines = this.lines;
    const shift = this.labelShifts[pl.labelLine()] ?? 0;
    if (pl.label) {
      pl.label.x += shift;
      if (this.rtlPara) pl.label.x = this.width - pl.label.x - pl.label.width;
    }
  }
}

/** Where the line's content ends: trailing spaces and markers hang (content_end). */
function contentEnd(pl, sc, c1) {
  let ce = sc.xs.length ? sc.xs[sc.xs.length - 1] : sc.lineStartX;
  for (let k = c1 - 1; k >= sc.c0; k--) {
    const kind = pl.clusters[k]?.kind;
    if (kind === CL.SPACE || kind === CL.MARKER || kind === CL.LINE_BREAK || kind === CL.PAGE_BREAK || kind === CL.COLUMN_BREAK) ce = sc.xs[k - sc.c0] ?? ce;
    else { ce -= pl.autoSpaceAfter(k); break; }
  }
  return ce;
}

/** Stretch the line to its right edge (justify_line). */
function justifyLine(pl, xs, c0, c1, alignFrom, ce, slack, distribute) {
  const spaces = [];
  for (let k = alignFrom; k < c1; k++) if (pl.clusters[k]?.kind === CL.SPACE && (xs[k - c0] ?? Infinity) < ce - 0.01) spaces.push(k);
  if (distribute || !spaces.length) {
    const cnt = Math.max(Math.max(c1 - alignFrom - 1, 0), 1);
    if (distribute) {
      const per = slack / cnt;
      for (let q = alignFrom - c0; q < xs.length; q++) xs[q] += per * Math.min(q + c0 - alignFrom, cnt);
    }
    return;
  }
  const per = slack / spaces.length;
  let add = 0, si = 0;
  for (let k = alignFrom; k < c1; k++) {
    if (k - c0 < xs.length) xs[k - c0] += add;
    if (spaces[si] === k) { add += per; si++; }
  }
  xs[xs.length - 1] += add;
}

class Scan {
  constructor(f) {
    Object.assign(this, {xs: [], leaders: [], lastBreak: null, lastPlain: null, end: END.PARA, pending: {tab: null}, spaceW: 0, hasTab: false,
      skip: false}, f);
  }
  scan(bk, pl) { while (this.j < bk.n && !this.step(bk, pl)) { /* next */ } }
  step(bk, pl) {
    const c = pl.clusters[this.j];
    if (!c) return true;
    if (c.kind === CL.LINE_BREAK || c.kind === CL.PAGE_BREAK || c.kind === CL.COLUMN_BREAK) {
      this.x += resolveTab(pl, this.pending, this.xs, this.c0, this.x);
      this.xs.push(this.x);
      this.end = c.kind === CL.LINE_BREAK ? END.LINE_BREAK : c.kind === CL.PAGE_BREAK ? END.PAGE_BREAK : END.COLUMN_BREAK;
      this.j++;
      return true;
    }
    if (c.kind === CL.TAB) return this.tab(bk, pl);
    return this.cluster(bk, pl, c);
  }
  tab(bk, pl) {
    const j = this.j;
    this.hasTab = true;
    this.x += resolveTab(pl, this.pending, this.xs, this.c0, this.x);
    const rp = bk.rp;
    const pt = pl.ptabs.find(t => t[0] === j);
    const ptab = pt ? ptabStop(pt[1], pt[2], pt[3], bk.width, [rp.indentLeft, rp.indentRight]) : null;
    const st = ptab ?? nextTab(this.x, rp.tabs, bk.defaultTab, bk.hangingAt);
    if (ptab && st.pos < this.x - 0.01 && hasContent(pl, this.c0, j)) { this.end = END.WRAP; return true; }
    this.xs.push(this.x);
    if (!ptab && st.pos > this.rightEdge + 0.01 && st.align === 'left') {
      if (hasContent(pl, this.c0, j)) {
        this.xs.pop();
        this.end = END.WRAP;
        bk.wrappedTab = j;
        return true;
      }
      if (bk.wrappedTab === j) {
        pl.clusters[j].adv = 0;
        this.lastBreak = j;
        this.j++;
        return false;
      }
    }
    this.placeTab(pl, st);
    this.lastBreak = j;
    this.j++;
    return false;
  }
  placeTab(pl, st) {
    const j = this.j;
    if (st.align === 'left' || st.align === 'bar' || st.align === 'clear' || st.align === 'start' || st.align === 'num') {
      const w = Math.max(st.pos - this.x, 0);
      pl.clusters[j].adv = w;
      this.x += w;
    } else this.pending.tab = [j, st, this.x];
    if (st.leader && st.leader !== 'none') this.leaders.push([j, st.leader]);
  }
  absorbs(pl, advance) {
    const p = this.pending.tab;
    if (!p) return false;
    const [tj, st] = p;
    const room = pl.clusters[tj]?.adv ?? 0;
    if (st.align === 'right' || st.align === 'end' || st.align === 'decimal') return room >= advance;
    if (st.align === 'center') return room >= advance / 2 && this.x + advance / 2 <= this.rightEdge + 0.01;
    return false;
  }
  cluster(bk, pl, c) {
    const j = this.j, c0 = this.c0;
    const isDisplay = pl.displays.some(([ci]) => ci === j);
    if (isDisplay && hasContent(pl, c0, j)) { this.end = END.WRAP; return true; }
    const advance = pl.atomicAdvance(j);
    const absorbs = this.absorbs(pl, advance);
    const shrink = bk.shrinkSpaces && !this.hasTab ? spaceRoom(this.spaceW, this.x + advance - pl.autoSpaceAfter(j) - this.wordFrom) : 0;
    const fits = absorbs || this.x + advance - pl.autoSpaceAfter(j) <= this.rightEdge + shrink + 0.01 || c.kind === CL.SPACE || c.kind === CL.MARKER;
    if (!fits && pl.isEditBoundary(c.start)) {
      let roomy = false;
      for (let k = c0; k < j; k++) if (takesRoom(pl.clusters[k])) { roomy = true; break; }
      if (roomy) { this.wrap(bk, pl); return true; }
    }
    this.xs.push(this.x);
    this.x += c.adv;
    if (c.kind === CL.SPACE) this.spaceW += c.adv;
    this.shiftPendingTab(pl);
    if (isDisplay) { this.endDisplay(pl, bk.n); return true; }
    if (c.breakAfter) this.noteBreak(bk, pl, c, shrink);
    this.j++;
    return false;
  }
  shiftPendingTab(pl) {
    const p = this.pending.tab;
    if (!p) return;
    const [tj, st, tx] = p;
    const segW = this.x - tx;
    let shift;
    if (st.align === 'right' || st.align === 'end') shift = st.pos - tx - segW;
    else if (st.align === 'center') shift = st.pos - tx - segW / 2;
    else if (st.align === 'decimal') shift = st.pos - tx - (widthToDecimal(pl, tj, this.j) ?? segW);
    else shift = 0;
    shift = Math.max(shift, 0);
    const old = pl.clusters[tj]?.adv ?? 0;
    if (Math.abs(shift - old) > 0.001) {
      const delta = shift - old;
      pl.clusters[tj].adv = shift;
      for (let i = tj + 1 - this.c0; i < this.xs.length; i++) if (i >= 0) this.xs[i] += delta;
      this.x += delta;
    }
  }
  endDisplay(pl, n) {
    this.j++;
    while (this.j < n && pl.clusters[this.j]?.kind === CL.MARKER) { this.xs.push(this.x); this.j++; }
    this.end = this.j >= n ? END.PARA : END.WRAP;
  }
  noteBreak(bk, pl, c, shrink) {
    const j = this.j;
    if (!binHas(pl.hyphAfter, j)) {
      this.lastBreak = j;
      this.lastPlain = [j, this.x];
      this.wordFrom = c.kind === CL.SPACE ? this.x - c.adv : this.x;
    } else if (this.hyphOk) {
      const nx = pl.clusters[j + 1];
      const glyphless = nx && nx.kind === CL.TEXT && !nx.shown;
      if (!glyphless && this.x + hyphenGlyph(pl, c.style, bk.hcache, bk.shaper).adv <= this.rightEdge + shrink + 0.01) this.lastBreak = j;
    }
  }
  wrap(bk, pl) {
    const c0 = this.c0;
    this.end = END.WRAP;
    if (this.lastBreak !== null && this.lastPlain) {
      const [pj, px] = this.lastPlain;
      if (pj >= c0 && pj < this.lastBreak && binHas(pl.hyphAfter, this.lastBreak) && this.rightEdge - px <= bk.zone) this.lastBreak = pj;
    }
    this.tabWithItsText(pl);
    const b = this.lastBreak;
    if (b !== null && b >= c0) {
      this.xs.length = b + 1 - c0;
      this.j = b + 1;
      this.x = (this.xs.length ? this.xs[this.xs.length - 1] : this.lineStartX) + (pl.clusters[b]?.adv ?? 0);
    } else this.breakLongWord(bk, pl);
  }
  tabWithItsText(pl) {
    const p = this.pending.tab;
    if (p && this.lastBreak === p[0] && hasContent(pl, this.c0, p[0])) {
      const tj = p[0];
      this.lastBreak = tj - 1;
      this.pending.tab = null;
      this.leaders = this.leaders.filter(([k]) => k < tj);
    }
  }
  breakLongWord(bk, pl) {
    const c0 = this.c0, j = this.j;
    const full = bk.baseRight - this.rowLo;
    this.skip = this.narrowed && bk.skipped < 50 && bk.widths[c0] <= full + 0.01;
    const glyphless = k => { const c = pl.clusters[k]; return !!c && c.kind === CL.TEXT && !c.shown; };
    const inside = k => { const c = pl.clusters[k]; return !!c && !pl.isEditBoundary(c.start); };
    let b = j;
    while (b > c0 + 1 && (glyphless(b) || inside(b))) b--;
    while (b > c0 && inside(b)) b--;
    if (b < j && b > c0 && !this.skip && this.xs[b - c0] !== undefined) {
      const bx = this.xs[b - c0];
      this.xs.length = b - c0;
      this.x = bx;
      this.j = b;
    }
  }
}
