// A page turned into draw items for the renderer (the page view paints them on a canvas, the PDF
// writer and print use them too).
//
// Translated from wordcraft crates/layout/src/display.rs, display/page.rs, display/lines.rs and
// display/glyphs.rs (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c). Text is drawn
// as strings in a font (the shaper's) instead of glyph ids. Draw items:
//
//   {type: 'fill',  rect, color, alpha, textBg}
//   {type: 'line',  x0, y0, x1, y1, width, color, stroke ('solid'|'dash'|'dot'|'double'|'wave'), alpha}
//   {type: 'text',  x, y (baseline), text, font {family, size, bold, italic}, color, alpha, link, xScale, fx? (text effects)}
//   {type: 'image', rect, media, crop, alpha, alt, rot}
//   {type: 'shape', rect, kind, fill, stroke, strokeWidth, alpha, rot}
//   {type: 'chart', rect, prims, family, alpha, alt, rot}  a chart's drawing primitives (core/quill/lib/chart-draw.mjs)
//   {type: 'math',  rect, prims, family, alpha, alt, rot}  an equation's drawing primitives (core/quill/lib/math-layout.mjs)
//   {type: 'mark',  x, baseline, size, ch}            formatting marks (¶ · →), screen only
//
// Tracked changes (U:quill/review, from display/lines.rs `lines` and display/page.rs
// `change_bars`, `revision_color`): with `opts.review` the text of a revision is drawn in its
// author's colour with the Track Changes Options marks (underline, strikethrough, double, bold,
// italic, caret, #, colour only, none, hidden), moved text in the move colours, and a bar beside
// every changed line. Not translated: WordArt (`wordart.rs`), comment highlights, grammar squiggles,
// charts and SmartArt contents. Spelling squiggles are drawn when the caller passes `opts.proof` (U:quill/spelling).
import {CL} from './para/model.mjs';
import {DECOR_STORY} from './notes.mjs';

const BLACK = [0, 0, 0];

/** The colour text formatted `rc` is drawn in (text_color): automatic is black. */
export function textColor(c) {
  if (c && typeof c === 'object' && Array.isArray(c.Rgb)) return c.Rgb;
  if (Array.isArray(c)) return c;
  return BLACK;
}

/** The stroke a border or underline style draws with (stroke_of / border_stroke). */
export function strokeOf(style) {
  switch (style) {
    case 'dotted': case 'dottedHeavy': case 'dot': return 'dot';
    case 'dashed': case 'dash': case 'dashedHeavy': case 'dashLong': case 'dashLongHeavy': case 'dotDash': case 'dotDotDash': case 'dashDotHeavy':
    case 'dashDotDotHeavy': case 'dashSmallGap': case 'dotDashHeavy': return 'dash';
    case 'double': case 'triple': return 'double';
    case 'wave': case 'wavyHeavy': case 'wavyDouble': return 'wave';
    default: return 'solid';
  }
}

/** Colour of moved text (both ends of a tracked move) (MOVE_COLOR). */
export const MOVE_COLOR = Object.freeze([0x1a, 0x7f, 0x37]);
/** The change bar's automatic colour (CHANGE_BAR). */
export const CHANGE_BAR = Object.freeze([0x50, 0x50, 0x50]);
const REVISION_COLORS = [[0xb0, 0x1e, 0x8f], [0x1e, 0x6e, 0xb0], [0x2e, 0x8b, 0x3e], [0xc0, 0x5a, 0x10], [0x70, 0x3c, 0xb0], [0x0e, 0x7c, 0x86]];
/** Colour for revisions by author index (revision_color). */
export const revisionColor = i => REVISION_COLORS[((i % REVISION_COLORS.length) + REVISION_COLORS.length) % REVISION_COLORS.length];

/** Each author's place in order of first appearance among the revisions (author_order). */
export function authorOrder(revisions) {
  const seen = new Map();
  for (const r of revisions ?? []) if (r && !seen.has(r.author ?? '')) seen.set(r.author ?? '', seen.size);
  return seen;
}

/**
 * The review drawing options for a document (`opts.review` of pageDisplay): `show` (markup shown),
 * `original` (Display for Review › Original: deletions drawn as plain text), `plainInsert`
 * (Simple Markup: the text reads as final, only the bars show), `marks` (Track Changes Options,
 * review-markup.mjs), `bars` ('outside'|'left'|'right'|'none'), `barColor`, `paraMark(story, path)`
 * ({ins, del, fmt, props}: the paragraph mark's and the paragraph's own changes).
 */
export function reviewLook(content, o = {}) {
  const revs = content?.revisions ?? [];
  const order = authorOrder(revs);
  return {show: o.show ?? true, original: !!o.original, marks: o.marks ?? {}, bars: o.bars ?? o.marks?.changedLines ?? 'outside', barColor: o.barColor ?? null,
    mirror: !!content?.settings?.mirrorMargins, plainInsert: !!o.plainInsert,
    color: r => revisionColor(order.get(revs[r]?.author ?? '') ?? 0),
    moved: r => r !== null && r !== undefined && !!revs[r]?.moveName,
    paraMark: o.paraMark ?? null};
}

const hexRgb = c => (Array.isArray(c) ? c : typeof c === 'string' && /^[0-9a-f]{6}$/i.test(c) ? [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4), 16)] : null);

/** How a run formatted `rc` is drawn under the review options: null to draw it as usual (lines.rs). */
function revisionStyle(rv, rc) {
  if (!rv) return null;
  const hasDel = rc.del !== null && rc.del !== undefined, hasIns = rc.ins !== null && rc.ins !== undefined;
  if (!hasDel && !hasIns) return null;
  const m = rv.marks ?? {};
  const movedFrom = hasDel && rv.moved(rc.del);
  const hidesDel = !(m.insertionsDeletions ?? true) || (movedFrom ? m.moveFromMark : m.deleteMark) === 'hidden';
  // Without markup a deletion is never drawn as ordinary text, nor when its mark is Hidden; the
  // Original view draws it plain (it is the text before the changes).
  if (hasDel && rv.original) return {plain: true};
  if (hasDel && (!rv.show || hidesDel || rv.plainInsert)) return {skip: true};
  const shown = rv.show && (m.insertionsDeletions ?? true) && !rv.plainInsert;
  if (!shown) return {plain: true};
  const del = hasDel ? rc.del : null, ins = !hasDel && hasIns ? rc.ins : null;
  const movedTo = ins !== null && rv.moved(ins);
  const plainMove = (movedFrom && m.moveFromMark === 'none') || (movedTo && m.moveToMark === 'none');
  if (plainMove) return {plain: true};
  const color = movedFrom ? hexRgb(m.moveFromColor) ?? rv.color(del) : movedTo ? hexRgb(m.moveToColor) ?? rv.color(ins)
    : ins !== null ? hexRgb(m.insertColor) ?? rv.color(ins) : hexRgb(m.deleteColor) ?? rv.color(del);
  const insMark = ins !== null ? (movedTo ? m.moveToMark ?? 'doubleUnderline' : m.insertMark ?? 'underline') : null;
  const delMark = del !== null ? (movedFrom ? m.moveFromMark ?? 'doubleStrikethrough' : m.deleteMark ?? 'strikethrough') : null;
  return {color, insMark, delMark};
}

/** Draw items of a page (page_display). `opts`: {marks: bool (formatting marks), hfAlpha (header/footer dimming, default 1), review (reviewLook)}. */
export function pageDisplay(page, opts = {}) {
  const out = [];
  const hfAlpha = opts.hfAlpha ?? 1;
  for (const it of page.header) item(it, opts, hfAlpha, out);
  for (const it of page.footer) item(it, opts, hfAlpha, out);
  for (const it of page.items) item(it, opts, opts.bodyAlpha ?? 1, out);
  if (opts.review && opts.review.bars !== 'none' && (opts.review.show || opts.review.plainInsert)) changeBars(page, opts.review, opts.bodyAlpha ?? 1, out);
  return out;
}

/** A bar beside every changed line of the body (change_bars). */
function changeBars(page, rv, alpha, out) {
  const m = rv.marks ?? {};
  const text = (m.insertionsDeletions ?? true), fmt = (m.formatting ?? true);
  if (!text && !fmt) return;
  const right = rv.bars === 'right' || (rv.bars === 'outside' && rv.mirror && page.number % 2 === 1);
  const bx = right ? page.body.x + page.body.w + 9 : page.body.x - 9;
  const color = hexRgb(rv.barColor) ?? hexRgb(m.changedLinesColor) ?? CHANGE_BAR;
  for (const it of page.items) {
    if (it.kind !== 'lines' || it.story === DECOR_STORY) continue;
    const pl = it.para;
    const first = pl.lines[it.l0];
    if (!first) continue;
    const mark = rv.paraMark ? rv.paraMark(it.story, it.path) : null;
    const markRev = !!mark && ((text && (mark.ins || mark.del)) || (fmt && mark.fmt));
    const paraFmt = fmt && !!mark?.props;
    for (let li = it.l0; li < it.l1; li++) {
      const l = pl.lines[li];
      if (!l) continue;
      let changed = paraFmt || (markRev && l.end === 'para');
      for (let k = l.c0; k < l.c1 && !changed; k++) {
        const rc = pl.styles[pl.clusters[k]?.style]?.rc;
        if (rc && ((text && ((rc.ins ?? null) !== null || (rc.del ?? null) !== null)) || (fmt && (rc.fmt ?? null) !== null))) changed = true;
      }
      if (!changed) continue;
      const top = it.y + (l.top - first.top);
      out.push({type: 'line', x0: bx, y0: top, x1: bx, y1: top + l.height, width: 0.75, color, stroke: 'solid', alpha, bar: true});
    }
  }
}

/**
 * One side of a page border drawn double: its outer and inner strokes as two lines, each `w` wide
 * and `w` from the side's centre line (the page view's double stroke), meeting the next side's
 * strokes in square corners as Word draws a double box: where a side joins another, the outer
 * stroke runs on to the outer corner and the inner one stops at the inner corner.
 */
function boxDouble(it, b, alpha, out) {
  const w = Math.max(b.width ?? 0.5, 0.25), off = w;
  const inward = {top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0]}[it.side];
  const horizontal = it.side === 'top' || it.side === 'bottom';
  const [j0, j1] = it.joins ?? [false, false];
  for (const s of [-1, 1]) {
    // s = -1: the outer stroke (away from the page centre), +1: the inner one.
    const ext = s < 0 ? off + w / 2 : -(off - w / 2);
    const e0 = j0 ? ext : 0, e1 = j1 ? ext : 0;
    const dx = inward[0] * off * s, dy = inward[1] * off * s;
    const line = horizontal
      ? {x0: it.x0 - e0, y0: it.y0 + dy, x1: it.x1 + e1, y1: it.y1 + dy}
      : {x0: it.x0 + dx, y0: it.y0 - e0, x1: it.x1 + dx, y1: it.y1 + e1};
    out.push({type: 'line', ...line, width: w, color: b.color ?? BLACK, stroke: 'solid', alpha});
  }
}

function item(it, opts, alpha, out) {
  const n0 = out.length;
  itemOf(it, opts, alpha, out);
  // Text in a turned text box (Shape Format › Text Direction): every item it drew is rotated onto the frame.
  if (it.turn) for (let i = n0; i < out.length; i++) out[i].turn = it.turn;
  // Text of a box with a text warp is bent along the warp when painted.
  if (it.warp) for (let i = n0; i < out.length; i++) if (out[i].type === 'text') out[i].warp = it.warp;
}

function itemOf(it, opts, alpha, out) {
  switch (it.kind) {
    case 'fill': out.push({type: 'fill', rect: it.rect, color: it.color, alpha, textBg: false}); break;
    case 'rule': {
      const b = it.border;
      if (it.side && strokeOf(b.style) === 'double') { boxDouble(it, b, alpha, out); break; }
      out.push({type: 'line', x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1, width: b.width, color: b.color ?? BLACK, stroke: strokeOf(b.style), alpha});
      break;
    }
    case 'image': out.push({type: 'image', rect: it.rect, media: it.media, crop: it.crop, alpha, alt: it.alt ?? '', rot: it.rot ?? 0, ...(it.pad ? {pad: it.pad} : {}), ...(it.flipH ? {flipH: true} : {}), ...(it.flipV ? {flipV: true} : {}), ...(it.effects ? {effects: it.effects} : {})}); break;
    case 'math': out.push({type: 'math', rect: it.rect, prims: it.prims, family: it.family, alpha, alt: it.alt ?? '', rot: 0}); break;
    case 'chart': out.push({type: 'chart', rect: it.rect, prims: it.prims, family: it.family, alpha, alt: it.alt ?? '', rot: it.rot ?? 0}); break;
    case 'shape': out.push({type: 'shape', rect: it.rect, kind: it.shape, fill: it.fill, stroke: it.stroke, strokeWidth: it.strokeWidth, alpha, rot: it.rot ?? 0,
      ...(it.fillFx ? {fillFx: it.fillFx} : {}), ...(it.effects ? {effects: it.effects} : {}),
      ...(it.freeform ? {freeform: it.freeform} : {}), ...(it.flipH ? {flipH: true} : {}), ...(it.flipV ? {flipV: true} : {}),
      ...(it.arrowStart ? {arrowStart: true} : {}), ...(it.arrowEnd ? {arrowEnd: true} : {})}); break;
    case 'lines': lines(it, opts, alpha, out); break;
    // View Gridlines (Table Layout): the cells' outlines, dashed and light, on screen only (`opts.tableGridlines`, never in print or export).
    case 'cell':
      if (opts.tableGridlines && !it.covered && it.rect) {
        const {x, y, w, h} = it.rect, c = [168, 168, 176];
        for (const [x0, y0, x1, y1] of [[x, y, x + w, y], [x, y + h, x + w, y + h], [x, y, x, y + h], [x + w, y, x + w, y + h]]) out.push({type: 'line', x0, y0, x1, y1, width: 0.5, color: c, stroke: 'dash', alpha, grid: true});
      }
      break;
    default: break;
  }
}

/** The draw items of lines l0..l1 of a paragraph (display/lines.rs `lines`). */
function lines(it, opts, alpha, out) {
  const pl = it.para;
  const first = pl.lines[it.l0];
  if (!first) return;
  const marks = !!opts.marks && it.story !== DECOR_STORY;
  const misspelt = opts.proof && it.story !== DECOR_STORY ? opts.proof(it.story, it.path) : null;
  for (let li = it.l0; li < it.l1; li++) {
    const l = pl.lines[li];
    const base = it.y + (l.baseline - first.top);
    const top = it.y + (l.top - first.top);
    // Character backgrounds (highlight, shading) first.
    for (let k = l.c0; k < l.c1; k++) {
      const c = pl.clusters[k];
      const st = pl.styles[c.style];
      if (!st || c.kind === CL.MARKER) continue;
      const bg = st.rc.highlight ?? shadingRgb(st.rc.shading);
      if (!bg) continue;
      const x0 = it.x + (l.clLeft(k) ?? 0), x1 = it.x + (l.clRight(k) ?? 0);
      out.push({type: 'fill', rect: {x: x0, y: base - l.textAsc, w: Math.max(x1 - x0, 0), h: l.textAsc + l.textDesc}, color: bg, alpha, textBg: true});
    }
    // Text runs: clusters of one style drawn together while they sit side by side.
    const rvs = new Map();
    const look = si => { if (!rvs.has(si)) rvs.set(si, revisionStyle(opts.review, pl.styles[si]?.rc ?? {})); return rvs.get(si); };
    let run = null;
    const flush = () => { if (run && run.text) { delete run.style; delete run.end; out.push(run); } run = null; };
    for (let k = l.c0; k < l.c1; k++) {
      const c = pl.clusters[k];
      if ((c.kind !== CL.TEXT && c.kind !== CL.SPACE) || !c.shown) { flush(); continue; }
      const cx = it.x + (l.clLeft(k) ?? 0) + c.dx;
      const pieces = c.pieces ?? [{style: c.style, shown: c.shown, adv: c.adv}];
      let px = cx;
      for (const pc of pieces) {
        const st = pl.styles[pc.style];
        if (!st) continue;
        const rv = look(pc.style);
        if (rv?.skip || rv?.delMark === 'caret') { flush(); px += pc.adv; continue; }
        const y = base - st.shift + c.dy;
        // A link takes its look from its style (Hyperlink); without one it is drawn in the text colour, as
        // Word draws a table of contents' entries (display/lines.rs `ink`, glyphs.rs `text_color`).
        const color = rv?.color ?? textColor(st.rc.color);
        const xs = st.rc.scale / 100;
        const shown = rv?.delMark === 'hash' ? '#'.repeat([...pc.shown].length) : pc.shown;
        if (run && run.style === pc.style && Math.abs(run.end - px) < 0.01 && run.y === y) { run.text += shown; run.end = px + pc.adv; } else {
          flush();
          const bold = rv?.insMark === 'bold' || rv?.delMark === 'bold', italic = rv?.insMark === 'italic' || rv?.delMark === 'italic';
          const font = bold || italic ? {...st.font, bold: st.font.bold || bold, italic: st.font.italic || italic} : st.font;
          run = {type: 'text', x: px, y, text: shown, font, color, alpha, link: st.rc.link ?? null, xScale: xs, style: pc.style, end: px + pc.adv,
            // WordArt (Shape Format › WordArt Styles): the run's fill, outline, shadow, glow and reflection.
            ...(st.rc.textEffects && !rv ? {fx: st.rc.textEffects} : {})};
        }
        px += pc.adv;
      }
    }
    flush();
    decorations(it, pl, l, base, alpha, out, look);
    if (misspelt?.length) proofMarks(it, pl, l, base, alpha, out, misspelt);
    // Tab leaders.
    for (const [k, leader] of l.leaders) {
      const c = pl.clusters[k];
      const st = pl.styles[c?.style];
      if (!c || !st) continue;
      const ch = leader === 'dot' ? '.' : leader === 'hyphen' ? '-' : leader === 'middleDot' ? '·' : null;
      const x0 = it.x + (l.clLeft(k) ?? 0), x1 = it.x + (l.clRight(k) ?? 0);
      if (leader === 'underscore' || leader === 'heavy') {
        out.push({type: 'line', x0, y0: base + st.size * 0.1, x1, y1: base + st.size * 0.1, width: leader === 'heavy' ? st.size * 0.1 : st.size * 0.05, color: textColor(st.rc.color), stroke: 'solid', alpha});
      } else if (ch) {
        const step = st.size * 0.3;
        let text = '';
        for (let x = Math.ceil((x0 + step / 2) / step) * step; x + step <= x1; x += step) text += ch;
        if (text) out.push({type: 'text', x: x1 - text.length * step, y: base, text, font: st.font, color: textColor(st.rc.color), alpha, link: null, xScale: 1, spacing: step});
      }
    }
    // The list label and the hyphen of a hyphenated line.
    if (li === pl.labelLine() && pl.label) {
      for (const r of pl.label.runs) {
        const st = pl.styles[r.style];
        if (!st) continue;
        out.push({type: 'text', x: it.x + pl.label.x + r.x, y: base - st.shift, text: r.shown, font: st.font, color: textColor(st.rc.color), alpha, link: null, xScale: st.rc.scale / 100});
      }
    }
    if (l.hyphen) {
      const st = pl.styles[l.hyphen.style];
      if (st) out.push({type: 'text', x: it.x + l.hyphenX(l.hyphen.adv), y: base - st.shift, text: '-', font: st.font, color: textColor(st.rc.color), alpha, link: null, xScale: 1});
    }
    for (const r of pl.rubies) {
      if (r.cluster < l.c0 || r.cluster >= l.c1) continue;
      const st = pl.styles[r.style];
      const c = pl.clusters[r.cluster];
      const x0 = it.x + (l.clLeft(r.cluster) ?? 0);
      out.push({type: 'text', x: x0 + Math.max((c.adv - r.width) / 2, 0), y: base - r.raise, text: r.text, font: st.font, color: textColor(st.rc.color), alpha, link: null, xScale: 1});
    }
    if (marks) formattingMarks(it, pl, l, li, base, out);
    void top;
  }
}

function shadingRgb(s) {
  if (!s) return null;
  if (Array.isArray(s)) return s;
  if (Array.isArray(s.fill)) return s.fill;
  return null;
}

/** The spelling squiggle's colour (Word's red). */
export const PROOF_COLOR = Object.freeze([0xe0, 0x20, 0x20]);

/**
 * Red wavy underlines under the misspelt words of a line (`ranges`: what opts.proof(story, path) answered for the paragraph, [{start, end}] offsets; U:quill/spelling).
 * Drawn on screen only: print, PDF and export never pass `proof`. The wave sits just under the text, the width of the word.
 */
function proofMarks(it, pl, l, base, alpha, out, ranges) {
  const lo = pl.clusters[l.c0]?.start ?? 0, hi = pl.clusters[l.c1 - 1]?.end ?? lo;
  for (const r of ranges) {
    if (r.end <= lo || r.start >= hi) continue;
    let k0 = -1, k1 = -1;
    for (let k = l.c0; k < l.c1; k++) {
      const c = pl.clusters[k];
      if (c.kind !== CL.TEXT || c.end <= r.start || c.start >= r.end) continue;
      if (k0 < 0) k0 = k;
      k1 = k + 1;
    }
    if (k0 < 0) continue;
    const st = pl.styles[pl.clusters[k0].style];
    const y = base - (st?.shift ?? 0) + (st?.size ?? 11) * 0.14 + 0.6;
    for (const [xa, xb] of l.spans(k0, k1)) out.push({type: 'line', x0: it.x + xa, y0: y, x1: it.x + xb, y1: y, width: 0.8, color: PROOF_COLOR, stroke: 'wave', alpha, proof: true});
  }
}

/** Underline and strikethrough across runs of one format (display/lines.rs `draw_glyph_runs` decorations). */
function decorations(it, pl, l, base, alpha, out, look = () => null) {
  let end = l.c1;
  while (end > l.c0 && [CL.SPACE, CL.MARKER, CL.LINE_BREAK, CL.PAGE_BREAK, CL.COLUMN_BREAK].includes(pl.clusters[end - 1]?.kind)) end--;
  let k = l.c0;
  while (k < end) {
    const c = pl.clusters[k];
    const st = pl.styles[c.style];
    if (!st || c.kind === CL.MARKER) { k++; continue; }
    const rc = st.rc;
    const rv = look(c.style);
    if (rv?.skip) { k++; continue; }
    let ul, strike, double = !!rc.doubleStrike;
    if (rv && !rv.plain && rv.color) {
      // Track Changes Options marks (lines.rs): Underline / Double underline from either mark,
      // Strikethrough / Double strikethrough, else the run's own decorations.
      ul = rv.insMark === 'underline' || rv.delMark === 'underline' ? 'single' : rv.insMark === 'doubleUnderline' || rv.delMark === 'doubleUnderline' ? 'double'
        : rc.underline && rc.underline !== 'none' ? rc.underline : null;
      double = double || rv.delMark === 'doubleStrikethrough';
      strike = rc.strike || double || rv.insMark === 'strikethrough' || rv.delMark === 'strikethrough';
    } else if (rv) {
      ul = rc.underline && rc.underline !== 'none' ? rc.underline : null;
      strike = rc.strike || rc.doubleStrike;
    } else {
      ul = rc.underline && rc.underline !== 'none' ? rc.underline : rc.ins !== null && rc.ins !== undefined ? 'single' : null;
      strike = rc.strike || rc.doubleStrike || (rc.del !== null && rc.del !== undefined);
    }
    let j = k + 1;
    while (j < end && pl.clusters[j].style === c.style) j++;
    const x0 = it.x + (l.clLeft(k) ?? 0), x1 = it.x + (l.clRight(j - 1) ?? 0);
    const color = rv?.color ?? textColor(rc.color);
    const y = base - st.shift;
    const size = st.size;
    if (rv?.delMark === 'caret') {
      // A caret where the text was, instead of the text.
      const h = size * 0.3, w = Math.max(size / 18, 0.6);
      out.push({type: 'line', x0: x0 - h * 0.6, y0: base + 1, x1: x0, y1: base + 1 - h, width: w, color, stroke: 'solid', alpha});
      out.push({type: 'line', x0, y0: base + 1 - h, x1: x0 + h * 0.6, y1: base + 1, width: w, color, stroke: 'solid', alpha});
      k = j;
      continue;
    }
    if (!ul && !strike) { k = j; continue; }
    if (ul && !(ul === 'words' && c.kind === CL.SPACE)) {
      const w = Math.max(size * (ul === 'thick' || ul.endsWith('Heavy') ? 0.1 : 0.05), 0.5);
      const uc = rc.underlineColor ? textColor(rc.underlineColor) : color;
      out.push({type: 'line', x0, y0: y + size * 0.12, x1, y1: y + size * 0.12, width: w, color: uc, stroke: strokeOf(ul), alpha});
      if (ul === 'double') out.push({type: 'line', x0, y0: y + size * 0.2, x1, y1: y + size * 0.2, width: w, color: uc, stroke: 'solid', alpha});
    }
    if (strike) {
      const w = Math.max(size * 0.05, 0.5);
      if (double) {
        out.push({type: 'line', x0, y0: y - size * 0.22, x1, y1: y - size * 0.22, width: w, color, stroke: 'solid', alpha});
        out.push({type: 'line', x0, y0: y - size * 0.34, x1, y1: y - size * 0.34, width: w, color, stroke: 'solid', alpha});
      } else out.push({type: 'line', x0, y0: y - size * 0.28, x1, y1: y - size * 0.28, width: w, color, stroke: 'solid', alpha});
    }
    k = j;
  }
}

/** Formatting marks: ¶ at a paragraph's end, ↵ at a line break, · for spaces, → for tabs (formatting_marks). */
function formattingMarks(it, pl, l, li, base, out) {
  const mark = pl.styles[pl.clusters[l.c0]?.style ?? 0] ?? pl.styles[0];
  const size = mark ? mark.size : 10;
  for (let k = l.c0; k < l.c1; k++) {
    const c = pl.clusters[k];
    const x0 = it.x + (l.clLeft(k) ?? 0), x1 = it.x + (l.clRight(k) ?? 0);
    if (c.kind === CL.SPACE) out.push({type: 'mark', x: (x0 + x1) / 2, baseline: base, size, ch: '·'});
    else if (c.kind === CL.TAB) out.push({type: 'mark', x: x0, baseline: base, size, ch: '→'});
  }
  const [mx] = l.markBox();
  if (l.end === 'para' && li + 1 === pl.lines.length) out.push({type: 'mark', x: it.x + mx, baseline: base, size, ch: '¶'});
  else if (l.end === 'lineBreak') out.push({type: 'mark', x: it.x + mx, baseline: base, size, ch: '↵'});
}
