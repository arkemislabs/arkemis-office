// Body paragraphs in the page flow: spacing between paragraphs, keep together / keep with next,
// widow and orphan control, page and column breaks, footnotes on the page that references them,
// floating objects anchored in the paragraph, line numbers.
//
// Translated from wordcraft crates/layout/src/flow.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: Outline view (`outline.rs`), the
// rest of a paragraph broken again for the wrap areas of the next column (`relay_wrap`, #1374).
import {joined, ownEdges, pushPara} from './boxes.mjs';
import {floatRect, floating, leftOutObjects, placeObjects, relExclusions, wrapAreas} from './floats.mjs';
import {DECOR_STORY, layNote, paraNotes, sepH, firstPiece, noticeH} from './notes.mjs';
import {itemBottom} from './placed.mjs';
import {END} from './para/model.mjs';
import {hasPageNumberFields} from './fields.mjs';

const MAX_PAGE_RELAYS = 64;
const PAGE_BREAK = '\u000C', COLUMN_BREAK = '\u000E';

/** Run `f` with the equation count it started from (again). */
function again(ctx, eqStart, f) {
  const now = ctx.eqCount;
  ctx.eqCount = eqStart;
  const out = f();
  ctx.eqCount = now;
  return out;
}

/** Place a body paragraph (place_para): quiet and stacked section marks first. */
export function placePara(ctx, pb, p, block, bodyTop) {
  if (!pb.web && ctx.quietMarks.has(block)) {
    const prevB = block > 0 ? ctx.doc.body[block - 1] : null;
    const followsSection = prevB?.kind === 'para' && !!prevB.section;
    const ownPage = pb.page()?.section === pb.sectIdx;
    if (p.section && !p.objects?.length && (ctx.opts.showHidden || !ctx.doc.resolveChar(p.props?.style ?? null, p.mark ?? {}).hidden) && !ctx.hasLabel(p)
      && (block === 0 || followsSection) && pb.atTop() && ownPage) { placeInFlow(ctx, pb, p, block, bodyTop); return; }
    const saved = [pb.y, pb.prev, pb.bottom, pb.contentBottom, pb.pages.length, pb.col];
    const drawn = pb.page()?.items.length ?? 0;
    pb.bottom = 1e30;
    placeInFlow(ctx, pb, p, block, bodyTop);
    pb.bottom = saved[2];
    if (pb.pages.length === saved[4] && pb.col === saved[5]) {
      [pb.y, pb.prev, pb.contentBottom] = [saved[0], saved[1], saved[3]];
      stripMark(pb.page(), drawn, true);
    }
    return;
  }
  if (!pb.web && ctx.stackedMarks.has(block)) {
    const saved = [pb.y, pb.prev, pb.bottom, pb.contentBottom, pb.pages.length, pb.col];
    const drawn = pb.page()?.items.length ?? 0;
    pb.bottom = 1e30;
    placeInFlow(ctx, pb, p, block, bodyTop);
    if (pb.pages.length === saved[4]) pb.bottom = saved[2];
    if (pb.pages.length === saved[4] && pb.col === saved[5] && pb.y > saved[2] + 0.01) {
      [pb.y, pb.prev, pb.contentBottom] = [Math.max(saved[2], saved[0]), saved[1], saved[3]];
      if (!p.objects?.length) stripMark(pb.page(), drawn, false);
    }
    return;
  }
  placeInFlow(ctx, pb, p, block, bodyTop);
}

/** Remove the list label from a mark's lines; optionally keep its other items (strip_mark). */
function stripMark(page, drawn, keepOthers) {
  if (!page) return;
  const tail = page.items.splice(Math.min(drawn, page.items.length));
  for (const it of tail) {
    if (it.kind === 'lines') {
      if (it.para.label) { const bare = Object.assign(Object.create(Object.getPrototypeOf(it.para)), it.para, {label: null}); page.items.push({...it, para: bare}); } else if (it.story === DECOR_STORY && !keepOthers) continue;
      else page.items.push(it);
    } else if (keepOthers) page.items.push(it);
  }
}

class Flow {
  constructor(ctx, pb, p, block, bodyTop) {
    this.p = p;
    this.block = block;
    this.bodyTop = bodyTop;
    this.width = pb.colW();
    const spaceBefore = ctx.doc.resolvePara(p.props).spaceBefore;
    this.exclMark = pb.excl.length;
    this.guess = pb.y + spaceBefore;
    this.label = ctx.nextLabel(p);
    this.eqStart = ctx.eqCount;
    this.pageMap = [];
    this.pageRelays = 0;
    this.l0 = 0;
    this.anchor(ctx, pb, this.guess, spaceBefore, true);
    this.anchorY = pb.y;
  }
  n() { return this.pl.lines.length; }
  /** Place the paragraph's floats and lay it out around the page's wrap areas (anchor_floats). */
  anchor(ctx, pb, y0, before, place) {
    ctx.fields.page = pb.number;
    const colX = pb.colX(), width = pb.colW();
    const rects = new Map();
    if (!pb.web && place && this.p.objects?.length) {
      pb.excl.length = Math.min(pb.excl.length, this.exclMark);
      const frame = {sect: pb.sect, origin: [0, 0], number: pb.number, mirror: ctx.mirror};
      const out = leftOutObjects(ctx.doc, this.p, null, !!ctx.opts.showHidden, ctx.hideDeleted);
      this.p.objects.forEach((o, oi) => {
        const fl = floating(o);
        if (!fl || out(oi)) return;
        const r = floatRect(frame, [colX, width], y0 - before, fl[0], fl[1], fl[2]);
        rects.set(oi, r);
        pb.excl.push(...wrapAreas(r, fl[2], o));
      });
    }
    const rel = relExclusions(pb.excl, colX, y0);
    this.floatRects = rects;
    this.rel = rel;
    this.pl = ctx.paraLabelled(this.p, width, null, rel, this.label);
    this.laidPage = pb.number;
    this.laidWidth = width;
  }
  reanchor(ctx, pb, y0, before) {
    again(ctx, this.eqStart, () => this.anchor(ctx, pb, y0, before, true));
  }
  relay(ctx) {
    ctx.fields.pageFrom = this.pageMap;
    const pl = again(ctx, this.eqStart, () => ctx.paraLabelled(this.p, this.laidWidth, null, this.rel, this.label));
    ctx.fields.pageFrom = [];
    return pl;
  }
  /** The space before the paragraph after merging with the one above (gap_before). */
  gapBefore(ctx, pb, brokeBefore) {
    let before = this.pl.rp.spaceBefore;
    const prev = pb.prev;
    const afterBreakMark = pb.afterBreakMark;
    pb.afterBreakMark = false;
    const s = ctx.doc.settings;
    if (pb.atTop() && (afterBreakMark || (brokeBefore && (s.compatMode ?? 15) >= 15))) before = 0;
    else if (pb.atTop() && !s.sumParagraphSpacing && prev) before = Math.max(before - Math.max(prev[2], 0), 0);
    if (pb.prev && !pb.atTop()) { const pr = pb.prev; pb.prev = null; before = this.mergeGap(ctx, pb, before, pr); } else pb.prev = null;
    if (this.pl.rp.beforeAuto && this.block === 0) before = 0;
    return before;
  }
  mergeGap(ctx, pb, before, [style, ctxl, after0, afterAuto, listed]) {
    let after = after0;
    const rp = this.pl.rp;
    if (style === rp.style) {
      if (ctxl) { pb.y -= after; before = Math.max(before - after, 0); after = 0; }
      if (rp.contextualSpacing) before = 0;
    }
    if (listed && this.label) {
      if (afterAuto) { pb.y -= after; after = 0; }
      if (rp.beforeAuto) before = 0;
    }
    if (before > 0 && after > 0 && !ctx.doc.settings.sumParagraphSpacing) before = Math.max(before - after, 0);
    return before;
  }
  /** Keep lines together / keep with next (keep_together); returns the space before applied. */
  keepTogether(ctx, pb, rooms, before) {
    const rp = this.pl.rp;
    const height = this.pl.height + rooms.top + rooms.bottom;
    if (!(rp.keepLines || (rp.keepNext && pb.y + height <= pb.bottom + 0.01))) return before;
    const need = height + (rp.keepNext ? nextFirstLine(ctx, this.block, this.width, 0, cloneCounters(ctx.counters)) : 0);
    if (pb.y + need > pb.bottom + 0.01 && !pb.fresh() && need <= pb.nextRoom(this.bodyTop)) {
      pb.advance(this.block, this.bodyTop);
      pb.y += Math.min(rp.spaceBefore, 0);
      return Math.min(rp.spaceBefore, 0);
    }
    return before;
  }
  /** Page fields on a new page show its number: lay the rest out again (relay_pages, #1352). */
  relayPages(ctx, pb) {
    if (this.l0 === 0 || !this.pl.hasPageFields || pb.web || this.pageRelays >= MAX_PAGE_RELAYS) return;
    const resume = this.pl.lines[this.l0]?.start;
    if (resume === undefined) return;
    const lastPage = this.pageMap.length ? this.pageMap[this.pageMap.length - 1][1] : this.laidPage;
    if (lastPage === pb.number || !hasPageNumberFields(this.p)) return;
    this.pageRelays++;
    this.pageMap.push([resume, pb.number]);
    ctx.fields.page = this.laidPage;
    const relaid = this.relay(ctx);
    const k = relaid.lines.findIndex(l => l.start === resume);
    if (k >= 0) { this.pl = relaid; this.l0 = k; } else this.pageMap.pop();
  }
  /** The lines from l0 that go on this page, with their footnotes (fit_lines). */
  fitLines(ctx, pb, notes, lead) {
    const pl = this.pl, n = this.n(), l0 = this.l0;
    const firstTop = pl.lines[l0]?.top ?? 0;
    const fit = {l1: l0, forced: null, markWithBreak: false, notes: []};
    let afterOnPage = null;
    while (fit.l1 < n) {
      const l = pl.lines[fit.l1];
      const lineNotes = notesOnLine(ctx, pb, l, notes, fit.notes);
      const limit = notesLimit(pb, fit.notes, lineNotes);
      const free = !pb.notes.length && !fit.notes.length && !lineNotes.length;
      const bottom = pb.y + lead + (l.top + fitHeight(pb, l, pl.rp, free) - firstTop);
      let tail = 0;
      if (!free && fit.l1 + 1 === n) tail = afterOnPage ??= spaceAfterKept(ctx, this.block, pl.rp, !!this.label);
      const over = bottom + tail > limit + 0.01;
      const split = bottom > limit + 0.01 && notesSplit(pb, fit.notes, lineNotes, bottom);
      if (over && fit.l1 > l0 && !split) break;
      if (over && fit.l1 === l0 && !pb.fresh() && !split && !this.staysAtBottom(pb, l)) break;
      fit.notes.push(...lineNotes);
      fit.l1++;
      if (this.endsPage(pb, l, fit) || split) break;
    }
    return fit;
  }
  staysAtBottom(pb, l) {
    const t = this.p.text.slice(l.start, l.stop);
    const onlyBreak = (l.end === END.PAGE_BREAK || l.end === END.COLUMN_BREAK) && [...t].every(c => c === PAGE_BREAK || c === COLUMN_BREAK);
    return onlyBreak || (pb.nextStartsPage && !!this.p.section && this.p.text.length === 0);
  }
  endsPage(pb, l, fit) {
    if (!(l.end === END.PAGE_BREAK || l.end === END.COLUMN_BREAK) || pb.web) return false;
    fit.forced = l.end;
    const m = this.pl.lines[fit.l1];
    const markFollows = !!m && onlyMarkers(this.p, m.start, m.stop);
    if (l.end === END.PAGE_BREAK && fit.l1 + 1 === this.n() && markFollows) { fit.l1++; fit.markWithBreak = true; }
    return true;
  }
  /** Widow/orphan control and rows beside floats (settled_end). */
  settledEnd(pb, fit) {
    const n = this.n(), l0 = this.l0;
    let l1 = fit.l1;
    if (fit.forced === null && l1 < n && this.pl.rp.widowControl && n >= 2) {
      if (l1 - l0 === 1 && l0 === 0 && !pb.fresh()) l1 = l0;
      else if (n - l1 === 1 && (l1 - l0 >= 3 || (l0 > 0 && l1 - l0 >= 2))) l1--;
      else if (n - l1 === 1 && l0 === 0 && l1 - l0 === 2 && !pb.fresh()) l1 = l0;
    }
    while (l1 > l0 && l1 < n && this.pl.lines[l1]?.beside) l1--;
    return l1;
  }
  moveOn(ctx, pb) {
    pb.advance(this.block, this.bodyTop);
    if (this.l0 === 0) { const y0 = pb.y; this.reanchor(ctx, pb, y0, 0); this.anchorY = y0; }
  }
  emit(ctx, pb, rooms, lead, fit, notes) {
    const l0 = this.l0, l1 = fit.l1, n = this.n();
    addNotes(pb, fit.notes, notes, this.pl.lines[l1 - 1]?.c1 ?? 0);
    const x = pb.colX() + mirrorShift(this.pl.rp, pb.number, pb.web);
    const y = pb.y + lead;
    if (pb.notes.length && !pb.web) {
      const pbm = itemBottom(y, this.pl, l0, l1);
      if (pbm !== null && pbm > pb.bottom + 0.01) pb.bottom = Math.min(Math.max(pb.bodyFloor(), pbm), pb.origBottom);
    }
    const items = [];
    const edges = {top: l0 === 0 ? rooms.top : 0, bottom: l1 >= n ? rooms.bottom : 0, up: 0};
    if (l0 === 0 && rooms.above && pb.paraEnd && pb.paraEnd[0] === pb.pages.length && pb.paraEnd[1] === pb.col) edges.up = Math.max(y - pb.paraEnd[2], 0);
    const end = pushPara(items, 'body', [this.block], this.pl, l0, l1, x, y, this.width, edges);
    pb.paraEnd = [pb.pages.length, pb.col, end];
    const [behind, front] = placeObjects(ctx, {story: 'body', path: [this.block], p: this.p, pl: this.pl, lines: [l0, l1], origin: [x, y], floats: this.floatRects});
    items.push(...front);
    items.push(...lineNumbers(ctx, pb, this.pl, l0, l1, y));
    addItems(pb, behind, items);
    const f = this.pl.lines[l0], l = this.pl.lines[l1 - 1];
    if (f && l) { pb.y = y + (l.top + l.height - f.top); pb.contentBottom = Math.max(pb.contentBottom, pb.y); }
    this.l0 = l1;
  }
  afterLines(ctx, pb, forced, markWithBreak) {
    const {block, bodyTop} = this;
    const fl = this.pl.lines[0];
    const startsWithBreak = this.l0 === 1 && fl && (() => { const t = this.p.text.slice(fl.start, fl.stop); return t.length > 0 && [...t].every(c => c === PAGE_BREAK); })();
    if (forced === END.PAGE_BREAK && markWithBreak) { pb.newPage(block, bodyTop); pb.afterBreakMark = true; } else if (forced === END.PAGE_BREAK && startsWithBreak && !pb.web) { pb.newPage(block, bodyTop); pb.y += Math.max(this.pl.rp.spaceBefore, 0); } else if (forced === END.PAGE_BREAK) pb.newPage(block, bodyTop);
    else if (forced === END.COLUMN_BREAK) {
      pb.colBreakPage = pb.pages.length - 1;
      pb.advance(block, bodyTop);
      this.rewidthAfterColumnBreak(ctx, pb);
    } else if (this.l0 < this.n()) pb.advance(block, bodyTop);
  }
  /** Unequal columns: text after a column break takes its column's width (rewidth_after_column_break). */
  rewidthAfterColumnBreak(ctx, pb) {
    if (Math.abs(pb.colW() - this.width) <= 0.5) return;
    const resume = this.pl.lines[this.l0]?.start;
    if (resume === undefined) return;
    const saved = [this.floatRects, this.pl, this.rel, this.laidPage, this.laidWidth];
    ctx.fields.pageFrom = this.pageMap;
    again(ctx, this.eqStart, () => this.anchor(ctx, pb, pb.y, 0, false));
    ctx.fields.pageFrom = [];
    const k = this.pl.lines.findIndex(l => l.start === resume);
    if (k >= 0) { this.anchorY = pb.y; this.l0 = k; this.width = pb.colW(); } else [this.floatRects, this.pl, this.rel, this.laidPage, this.laidWidth] = saved;
  }
  finish(pb, rooms) {
    const rp = this.pl.rp;
    const [bottomRoom, spaceAfter] = pb.afterBreakMark ? [0, 0] : [rooms.bottom, rp.spaceAfter];
    pb.y += bottomRoom + spaceAfter;
    pb.prev = [rp.style, rp.contextualSpacing, spaceAfter, rp.afterAuto, !!this.label];
  }
}

function cloneCounters(c) {
  const o = Object.assign(Object.create(Object.getPrototypeOf(c)), c);
  o.state = new Map([...c.state].map(([k, v]) => [k, v.slice()]));
  o.seen = new Set(c.seen);
  o.flags = new Map([...c.flags].map(([k, v]) => [k, v.map(x => ({...x}))]));
  return o;
}
export {cloneCounters};

/** The footnotes referenced on a line not on the page yet, laid out (notes_on_line). */
function notesOnLine(ctx, pb, l, notes, newNotes) {
  const out = [];
  if (pb.web) return out;
  for (const [ci, id] of notes) {
    if (ci >= l.c0 && ci < l.c1 && !pb.notes.some(x => x.id === id) && !newNotes.some(x => x.id === id) && !out.some(x => x.id === id)
      && ctx.doc.part(id)?.kind === 'footnote') out.push(layNote(ctx, id, pb.textWidth()));
  }
  return out;
}
function notesLimit(pb, newNotes, lineNotes) {
  const h = ns => ns.reduce((s, n) => s + n.h, 0);
  const extra = h(lineNotes) + (!pb.notes.length && !newNotes.length && lineNotes.length ? sepH(pb.seps, false) : 0);
  return pb.bottom - h(newNotes) - (!pb.notes.length && newNotes.length ? sepH(pb.seps, false) : 0) - extra;
}
/** How much of the line must fit (fit_height): a multiple-spaced line's extra leading may run into the bottom margin. */
function fitHeight(pb, l, rp, free) {
  const atMargin = pb.bottom >= pb.sect.pageH - pb.sect.marginBottom - 0.01;
  if (rp.lineSpacing.rule === 'multiple' && rp.lineSpacing.value > 1 && atMargin && free) return Math.max(0, Math.min(l.baseline - l.top + l.textDesc, l.height));
  return l.height;
}
function notesSplit(pb, newNotes, lineNotes, bottom) {
  if (!lineNotes.length) return false;
  const last = lineNotes[lineNotes.length - 1];
  const others = lineNotes.slice(0, -1);
  const before = pb.notes.concat(newNotes, others).reduce((s, n) => s + n.h, 0);
  const sep = sepH(pb.seps, pb.notes[0]?.cont ?? false);
  return Math.max(pb.bodyFloor(), bottom) + sep + before + firstPiece(last) + noticeH(pb.seps) <= pb.origBottom + 0.01;
}
function addNotes(pb, newNotes, notes, placedEnd) {
  const keep = newNotes.filter(n => notes.some(([ci, id]) => id === n.id && ci < placedEnd));
  const before = pb.notesH();
  pb.notes.push(...keep);
  if (pb.balance) pb.capColumns(); else pb.bottom -= pb.notesH() - before;
}
/** Line numbers in the left margin (line_numbers). */
function lineNumbers(ctx, pb, pl, l0, l1, y) {
  const items = [];
  const ln = pb.sect.lineNumbers;
  if (!ln || pb.web || pl.rp.style === 'Header' || pl.rp.suppressLineNumbers) return items;
  const first = pl.lines[l0];
  if (!first) return items;
  for (let li = l0; li < l1; li++) {
    const line = pl.lines[li];
    if (!line || line.beside) continue;
    pb.lineNo++;
    const n = pb.lineNo + Math.max((ln.start ?? 1) - 1, 0);
    if ((ln.countBy ?? 1) > 1 && n % ln.countBy !== 0) continue;
    const num = ctx.numberPara(n);
    const nl = num.lines[0];
    const w = nl ? nl.xs[nl.xs.length - 1] : 10;
    const dist = ln.distance > 0 ? ln.distance : 18;
    const ly = y + (line.top - first.top) + (line.baseline - line.top) - (nl ? nl.baseline : 10);
    items.push({kind: 'lines', story: DECOR_STORY, path: [], para: num, l0: 0, l1: 1, x: pb.sect.marginLeft + pb.sect.gutter - dist - w, y: ly});
  }
  return items;
}
function addItems(pb, behind, items) {
  const pg = pb.page();
  if (pg) {
    behind.forEach((it, i) => pg.items.splice(Math.min(i, pg.items.length), 0, it));
    pg.items.push(...items);
  }
  if (pb.behind.length) pb.behind[pb.behind.length - 1] += behind.length;
}
function mirrorShift(rp, number, web) {
  if (!rp.mirrorIndents || web || number % 2 !== 0) return 0;
  const [left, right] = rp.bidi ? [rp.indentRight, rp.indentLeft] : [rp.indentLeft, rp.indentRight];
  return right - left;
}
function spaceAfterKept(ctx, block, rp, listed) {
  const after = Math.max(rp.spaceAfter, 0);
  if (after <= 0) return 0;
  const next = ctx.doc.body[block + 1];
  if (next?.kind === 'para') {
    const nrp = ctx.doc.resolvePara(next.props);
    if (nrp.style === rp.style && rp.contextualSpacing) return 0;
    if (listed && rp.afterAuto && ctx.hasLabel(next)) return 0;
  }
  return after;
}
/** Whether p.text[a..b] holds nothing but zero-width markers (only_markers). */
function onlyMarkers(p, a, b) {
  const MARK = new Set(['bookmarkStart', 'bookmarkEnd', 'commentStart', 'commentEnd', 'permStart', 'permEnd', 'fieldStart', 'fieldEnd', 'controlStart', 'controlEnd']);
  let k = 0;
  for (let i = 0; i < a; i++) if (p.text[i] === '￼') k++;
  for (let i = a; i < b; i++) {
    if (p.text[i] !== '￼') return false;
    if (!MARK.has(p.objects?.[k]?.type)) return false;
    k++;
  }
  return true;
}

/** The room the paragraphs after `block` need for keep with next (next_first_line, #966). */
export function nextFirstLine(ctx, block, width, depth, counters) {
  const b = ctx.doc.body[block + 1];
  if (!b) return 0;
  if (b.kind === 'table') return 24;
  const n = ctx.numberingOf(b);
  const label = n ? counters.nextLabel(ctx.doc.numbering, n.num, n.level ?? 0) : null;
  const pl = ctx.paraAhead(b, width, label);
  const own = ownEdges(pl, 0, pl.lines.length);
  const top = joined(ctx, ctx.doc.body, block + 1, block) ? 0 : own.top;
  if (pl.rp.keepNext && depth < 8) {
    const bottom = joined(ctx, ctx.doc.body, block + 1, block + 2) ? 0 : own.bottom;
    return pl.rp.spaceBefore + top + pl.height + bottom + pl.rp.spaceAfter + nextFirstLine(ctx, block + 1, width, depth + 1, counters);
  }
  const to = k => { const f = pl.lines[0], l = pl.lines[k]; return f && l ? l.top + l.height - f.top : 0; };
  return pl.rp.spaceBefore + top + (pl.rp.keepLines ? pl.height : pl.rp.widowControl && pl.lines.length >= 2 ? to(1) : to(0));
}

function placeInFlow(ctx, pb, p, block, bodyTop) {
  const f = new Flow(ctx, pb, p, block, bodyTop);
  const spot = () => [pb.pages.length, pb.col];
  const placedAt = spot();
  const brokeBefore = f.pl.rp.pageBreakBefore && !pb.atTop() && !pb.web;
  if (brokeBefore) pb.newPage(block, bodyTop);
  const before = f.gapBefore(ctx, pb, brokeBefore);
  pb.y += before;
  const above = joined(ctx, ctx.doc.body, block, block - 1), below = joined(ctx, ctx.doc.body, block, block + 1);
  const own = ownEdges(f.pl, 0, f.pl.lines.length);
  const rooms = {above, top: above ? 0 : own.top, bottom: below ? 0 : own.bottom};
  const applied = f.keepTogether(ctx, pb, rooms, before);
  const now = spot();
  if (now[0] !== placedAt[0] || now[1] !== placedAt[1] || (Math.abs(pb.y - f.guess) > 0.01 && pb.excl.length)) {
    const y0 = pb.y;
    f.reanchor(ctx, pb, y0, applied);
    f.anchorY = y0 - applied;
  }
  let guard = 0;
  while (f.l0 < f.n() && guard++ < 1_000_000) {
    f.relayPages(ctx, pb);
    ctx.fields.page = pb.number;
    const first = f.pl.lines[f.l0];
    if (!first) break;
    const lead = f.l0 === 0 ? Math.max(first.top, 0) + rooms.top : 0;
    const notes = paraNotes(ctx.doc, p, f.pl);
    const fit = f.fitLines(ctx, pb, notes, lead);
    fit.l1 = f.settledEnd(pb, fit);
    if (fit.l1 === f.l0) {
      if (!pb.fresh()) { f.moveOn(ctx, pb); continue; }
      fit.l1 = f.l0 + 1;
    }
    const {forced, markWithBreak} = fit;
    f.emit(ctx, pb, rooms, lead, fit, notes);
    f.afterLines(ctx, pb, forced, markWithBreak);
  }
  f.finish(pb, rooms);
}
