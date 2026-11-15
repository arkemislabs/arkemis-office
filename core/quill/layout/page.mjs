// Pages being filled: columns, the footnote area, vertical alignment, page borders, column rules.
//
// Translated from wordcraft crates/layout/src/page.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c).
import {borderVisible} from '../model/props.mjs';
import {columnBoxes} from '../model/section.mjs';
import {layoutBox} from './boxes.mjs';
import {NOTE_SEP, NOTE_SEP_W, firstPiece, noteCuts, noticeH, sepH, splitNote} from './notes.mjs';
import {rect, translate, vSpan} from './placed.mjs';
import {textWidthOf} from './floats.mjs';

const SINGLE = w => ({style: 'single', width: w, color: null, space: 0});

/** Page border rules, measured from the page edge (page_border_rules). */
export function pageBorderRules(s) {
  const v = [];
  const b = s.pageBorders;
  if (!b) return v;
  const sp = e => e?.space ?? 24;
  const x0 = sp(b.left), x1 = s.pageW - sp(b.right), y0 = sp(b.top), y1 = s.pageH - sp(b.bottom);
  // Each side knows which side it meets at either end, so a double line's two strokes can meet the
  // neighbouring side's strokes in square corners (the outer pair extended, the inner pair shortened).
  const on = e => borderVisible(e);
  for (const [side, e, a, c, ends] of [['top', b.top, [x0, y0], [x1, y0], [b.left, b.right]], ['bottom', b.bottom, [x0, y1], [x1, y1], [b.left, b.right]],
    ['left', b.left, [x0, y0], [x0, y1], [b.top, b.bottom]], ['right', b.right, [x1, y0], [x1, y1], [b.top, b.bottom]]]) {
    if (on(e)) v.push({kind: 'rule', x0: a[0], y0: a[1], x1: c[0], y1: c[1], border: e, side, joins: [on(ends[0]), on(ends[1])]});
  }
  return v;
}

/** A page (Page). */
export function newPage(f) {
  return {w: 0, h: 0, section: 0, number: 0, items: [], header: [], footer: [], body: rect(0, 0, 0, 0), headerStory: null, footerStory: null,
    hfSlot: 'default', firstBlock: 0, markup: 0, floatTables: [], ...f};
}

export class PageBuilder {
  constructor(sect, web) {
    Object.assign(this, {pages: [], sect, sectIdx: 0, col: 0, cols: [], y: 0, top: 0, pageTop: 0, bottom: 0, number: 0, web, notes: [], carry: [],
      origBottom: 0, prev: null, afterBreakMark: false, nextStartsPage: false, restartAt: null, excl: [], floatTables: [], lineNo: 0,
      pageItemsStart: 0, blockMarks: [], pageValign: 'top', seps: {sep: null, cont: null, notice: null}, paraEnd: null, behind: [], maxY: 0,
      contentBottom: 0, balance: null, colBreakPage: null, sectBeneath: false, beneath: false, footTop: Infinity});
  }
  /** A copy for column balancing (without the pages, which stay shared). */
  clone() {
    const c = Object.assign(Object.create(PageBuilder.prototype), this);
    c.notes = this.notes.slice(); c.carry = this.carry.slice(); c.excl = this.excl.slice(); c.floatTables = this.floatTables.slice();
    c.blockMarks = this.blockMarks.slice(); c.cols = this.cols.slice(); c.prev = this.prev ? this.prev.slice() : null;
    return c;
  }
  textWidth() { return textWidthOf(this.sect); }
  notesH() { return this.stackH(this.notes); }
  stackH(notes) { return notes.length ? sepH(this.seps, notes[0].cont) + notes.reduce((s, n) => s + n.h, 0) : 0; }
  /** The lowest bottom of the body text and tables on the current page (body_floor). */
  bodyFloor() {
    const pg = this.pages[this.pages.length - 1];
    if (!pg) return this.top;
    let m = this.top;
    for (let i = this.pageItemsStart; i < pg.items.length; i++) {
      const it = pg.items[i];
      if ((it.kind === 'lines' || it.kind === 'cell') && it.story === 'body') m = Math.max(m, vSpan(it)[1]);
    }
    return m;
  }
  /** Place the collected footnotes at the bottom of the page, splitting the one that doesn't fit (flush_notes). */
  flushNotes() {
    if (!this.notes.length) return;
    const total = this.notesH();
    const x = this.sect.marginLeft + this.sect.gutter;
    const area = Math.max(this.bottom, this.bodyFloor());
    const fits = total <= this.origBottom - area + 0.01;
    const top = !fits ? area : this.beneath ? Math.min(this.bodyFloor(), this.origBottom - total) : this.origBottom - total;
    const notes = this.notes;
    this.notes = [];
    const cont = notes[0]?.cont ?? false;
    let y = top + sepH(this.seps, cont);
    const placed = [];
    let noticeY = null;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const room = this.origBottom - y;
      if (fits || n.h <= room + 0.01) { placed.push([n, y]); y += n.h; continue; }
      const first = placed.length === 0;
      const cuts = noteCuts(n);
      const r = room - noticeH(this.seps);
      let c = null;
      for (let k = cuts.length - 1; k >= 0; k--) if (cuts[k] <= r + 0.01) { c = cuts[k]; break; }
      if (c === null && first && cuts.length) c = cuts[0];
      if (c !== null) {
        const [head, tail] = splitNote(n, c);
        noticeY = y + head.h;
        placed.push([head, y]);
        this.carry.push(tail);
      } else if (first) placed.push([n, y]);
      else this.carry.push(n);
      this.carry.push(...notes.slice(i + 1));
      break;
    }
    const pg = this.pages[this.pages.length - 1];
    if (!pg) return;
    const sep = cont ? this.seps.cont : this.seps.sep;
    if (sep) for (const it of sep[0]) pg.items.push(translate({...it}, x, top));
    else {
      const len = cont ? this.textWidth() : NOTE_SEP_W;
      const sy = top + NOTE_SEP / 2;
      pg.items.push({kind: 'rule', x0: x, y0: sy, x1: x + len, y1: sy, border: SINGLE(0.5)});
    }
    for (const [n, ny] of placed) for (const it of n.items) pg.items.push(translate({...it}, x, ny));
    if (noticeY !== null && this.seps.notice) for (const it of this.seps.notice[0]) pg.items.push(translate({...it}, x, noticeY));
  }
  /** A top-level block starts here (mark_block). */
  markBlock() {
    const pg = this.pages[this.pages.length - 1];
    if (pg) this.blockMarks.push(pg.items.length - (this.behind[this.behind.length - 1] ?? 0));
  }
  /** Justified vertical alignment: spread the page's blocks (justify_page). */
  justifyPage() {
    if (this.web || this.cols.length > 1) return;
    const behind = this.behind[this.behind.length - 1] ?? 0;
    const first = this.pageItemsStart;
    const space = Math.max(this.origBottom - this.notesH() - this.y, 0);
    const pg = this.pages[this.pages.length - 1];
    if (!pg) return;
    const front = pg.items.length - behind;
    const cuts = [...new Set(this.blockMarks.filter(m => m > first && m < front))].sort((a, b) => a - b);
    if (!cuts.length || space <= 0) return;
    const gap = space / cuts.length;
    for (let i = behind + first; i < pg.items.length; i++) {
      let k = 0;
      while (k < cuts.length && cuts[k] <= i - behind) k++;
      if (k > 0) translate(pg.items[i], 0, gap * k);
    }
  }
  /** Section vertical alignment (apply_valign). */
  applyValign() {
    const v = this.pageValign;
    if (v === 'top' || !v) return;
    if (v === 'justify') { this.justifyPage(); return; }
    if (this.web) return;
    const k = v === 'center' ? 0.5 : 1;
    const space = Math.max(this.origBottom - this.notesH() - this.y, 0) * k;
    const pg = this.pages[this.pages.length - 1];
    if (pg) for (let i = this.pageItemsStart; i < pg.items.length; i++) translate(pg.items[i], 0, space);
  }
  /** Take back an empty page a page break just started (take_back_break_page). */
  takeBackBreakPage() {
    const pg = this.pages[this.pages.length - 1];
    const empty = this.afterBreakMark && this.atTop() && !this.notes.length && this.pages.length > 1 && pg && pg.items.length === this.pageItemsStart;
    if (!empty) return false;
    this.pages.pop();
    this.behind.pop();
    this.number = Math.max(this.number - 1, 0);
    this.afterBreakMark = false;
    this.pageItemsStart = this.pages[this.pages.length - 1]?.items.length ?? 0;
    return true;
  }
  newPage(firstBlock, bodyTop) {
    this.applyValign();
    this.flushNotes();
    this.beneath = this.sectBeneath;
    this.excl = [];
    this.floatTables = [];
    if (this.sect.lineNumbers?.restart === 'page') this.lineNo = 0;
    const s = this.sect;
    if (this.restartAt !== null) { this.number = this.restartAt; this.restartAt = null; } else this.number = Math.min(this.number + 1, 0xffffffff);
    const [w, h] = this.web ? [s.pageW, 1e30] : [s.pageW, s.pageH];
    const bottom = this.bodyBottom(bodyTop);
    const body = rect(s.marginLeft + s.gutter, bodyTop, textWidthOf(s), Math.max(bottom - bodyTop, 36));
    let decor = [];
    if (!this.web) {
      decor = pageBorderRules(s);
      if (s.columns?.separator && (s.columns.count ?? 1) > 1) {
        const cols = columnBoxes(s);
        for (let i = 0; i + 1 < cols.length; i++) {
          const [ax, aw] = cols[i], [bx, bw] = cols[i + 1];
          const mid = bx >= ax ? (ax + aw + bx) / 2 : (bx + bw + ax) / 2;
          const x = s.marginLeft + s.gutter + mid;
          decor.push({kind: 'rule', x0: x, y0: bodyTop, x1: x, y1: bottom, border: SINGLE(0.5)});
        }
      }
    }
    this.pageItemsStart = decor.length;
    this.blockMarks = [];
    this.pageValign = s.valign ?? 'top';
    this.pages.push(newPage({w, h, section: this.sectIdx, number: this.number, body, firstBlock, items: decor}));
    this.behind.push(0);
    this.col = 0;
    this.cols = columnBoxes(s);
    this.top = bodyTop;
    this.pageTop = bodyTop;
    this.bottom = this.web ? 1e29 : bottom;
    this.origBottom = this.bottom;
    this.y = this.top;
    if (this.carry.length && !this.web) { this.notes = this.carry; this.carry = []; }
    this.maxY = this.top;
    this.contentBottom = this.top;
    this.capColumns();
  }
  capColumns() {
    this.bottom = this.uncappedBottom();
    if (this.balance && this.balance[0] + 1 === this.pages.length) this.bottom = Math.min(this.bottom, this.top + this.balance[1]);
  }
  bodyBottom(bodyTop) { return Math.min(this.sect.pageH - this.sect.marginBottom, Math.max(this.footTop, bodyTop + 36)); }
  nextRoom(bodyTop) {
    if (this.col + 1 < this.cols.length) return this.uncappedBottom() - this.top;
    if (this.web) return 1e29 - bodyTop;
    return this.bodyBottom(bodyTop) - this.stackH(this.carry) - bodyTop;
  }
  uncappedBottom() { return this.origBottom - this.notesH(); }
  textBottom() { return Math.max(this.maxY, this.y); }
  colX() { return this.sect.marginLeft + this.sect.gutter + (this.cols[this.col]?.[0] ?? 0); }
  colW() { return this.cols[this.col]?.[1] ?? this.textWidth(); }
  atTop() { return this.y <= this.top + 0.01; }
  fresh() { return this.atTop() && this.top <= this.pageTop + 0.01; }
  advance(block, bodyTop) {
    if (this.col + 1 < this.cols.length) { this.maxY = Math.max(this.maxY, this.y); this.col++; this.y = this.top; } else this.newPage(block, bodyTop);
  }
  page() { return this.pages[this.pages.length - 1]; }
}

/** Where body text starts: the top margin, or below a taller header (body_top_for). */
export function bodyTopFor(ctx, sect, header) {
  if (header === null || header === undefined) return sect.marginTop;
  const part = ctx.doc.part(header);
  if (!part) return sect.marginTop;
  const track = ctx.trackTotals;
  ctx.trackTotals = false;
  const frame = {sect, origin: [sect.marginLeft + sect.gutter, sect.header], number: 1, mirror: ctx.mirror};
  const h = layoutBox(ctx, {story: header, blocks: part.blocks ?? [], prefix: [], width: textWidthOf(sect), cell: undefined, depth: 0, frame}).height;
  ctx.trackTotals = track;
  return Math.max(sect.marginTop, sect.header + h);
}

/** Where the footer starts, Infinity without one (foot_top_for). */
export function footTopFor(ctx, sect, footer) {
  if (footer === null || footer === undefined) return Infinity;
  const part = ctx.doc.part(footer);
  if (!part) return Infinity;
  const track = ctx.trackTotals;
  ctx.trackTotals = false;
  const laid = layoutBox(ctx, {story: footer, blocks: part.blocks ?? [], prefix: [], width: textWidthOf(sect), cell: undefined, depth: 0, frame: null});
  ctx.trackTotals = track;
  let top = sect.pageH - sect.footer - laid.height;
  return top;
}
export {firstPiece};
