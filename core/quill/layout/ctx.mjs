// The walk state of one layout pass: list counters, field context, the paragraph cache.
//
// Translated from wordcraft crates/layout/src/ctx.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: picture outlines for Tight/Through
// wrap (`contour.rs`), fitted text box heights (`textbox.rs`), STYLEREF (`styleref.rs`).
import {Counters, showsLabel} from '../model/numbering.mjs';
import {layoutPara} from './para/paragraph.mjs';
import {NO_GRID, gridKey} from './para/lines.mjs';
import {fieldCtx, hasPageFields, hasTotalFields, pageKey} from './fields.mjs';
import {identity} from './cache.mjs';

export class Ctx {
  constructor(ldoc, cache, opts, shaper) {
    this.doc = ldoc;
    this.cache = cache;
    this.opts = opts;
    this.shaper = shaper;
    this.counters = new Counters();
    this.fields = fieldCtx();
    this.notesHash = '';
    this.numbers = new Map();
    this.eqCount = 0;
    this.grid = NO_GRID;
    this.hideDeleted = hidesDeleted(opts, 'body');
    this.usesTotals = false;
    this.trackTotals = true;
    this.quietMarks = new Set();
    this.stackedMarks = new Set();
    this.mirror = false;
    this.boxes = 0;
    // Design Mode: each control's end tag repeats the title of its start tag (the control an end marker closes).
    this.endTags = opts.designMode ? controlEndTags(ldoc) : null;
  }

  /** The list numbering of `p`: its own, else its style's; null for none or `num: 0` (has_label/next_label). */
  numberingOf(p) {
    const own = p.props?.numbering;
    if (own) return own.num === 0 ? null : own;
    const n = this.doc.resolvePara(p.props).numbering;
    return n && n.num !== 0 ? n : null;
  }
  hasLabel(p) {
    const n = this.numberingOf(p);
    return !!n && showsLabel(this.doc.numbering, n.num, n.level ?? 0);
  }
  /** Advance the list counter for `p` and return its label: [text, level] or null (next_label). */
  nextLabel(p) {
    const n = this.numberingOf(p);
    return n ? this.counters.nextLabel(this.doc.numbering, n.num, n.level ?? 0) : null;
  }

  /** The cached or new layout of `p` (para_labelled). */
  paraLabelled(p, width, table, exclusions, label) {
    const key = this.paraKey(p, width, table, exclusions, label);
    const hit = this.cache.get(p, key);
    if (hit) return hit;
    const pl = layoutPara(p, this.paraEnv(width, label, table, exclusions));
    this.cache.put(p, key, pl);
    return pl;
  }

  /** Lay out `p` ahead (keep with next) without counting anything (para_ahead). */
  paraAhead(p, width, label) {
    const kept = [this.eqCount, this.usesTotals];
    const key = this.paraKey(p, width, null, [], label);
    [this.eqCount, this.usesTotals] = kept;
    const hit = this.cache.get(p, key);
    if (hit) return hit;
    const pl = layoutPara(p, this.paraEnv(width, label, null, []));
    this.cache.put(p, key, pl);
    return pl;
  }

  /** A line number's paragraph (number_para): 10 pt grey digits. */
  numberPara(n) {
    let pl = this.numbers.get(n);
    if (pl) return pl;
    const p = {kind: 'para', id: 'lineno', text: String(n), runs: [{len: String(n).length, props: {size: 10, color: {Rgb: [0x60, 0x60, 0x60]}}}],
      props: {spaceAfter: 0, spaceBefore: 0}};
    pl = layoutPara(p, {...this.paraEnv(60, null, null, []), showHidden: false, fieldCodes: false, hideDeleted: {plain: false, movedFrom: false}, grid: NO_GRID});
    this.numbers.set(n, pl);
    return pl;
  }

  paraKey(p, width, table, exclusions, label) {
    const page = hasPageFields(p) ? pageKey(this.fields) : '';
    if (this.trackTotals && !this.usesTotals && hasTotalFields(p)) this.usesTotals = true;
    const pageFrom = page && this.fields.pageFrom.length ? JSON.stringify(this.fields.pageFrom) : '';
    const notes = (p.objects ?? []).some(o => o.type === 'noteRef') ? this.notesHash : '';
    const excl = exclusions.length ? JSON.stringify(exclusions) : '';
    const lab = label ? `${label[0]}|${identity(label[1])}` : '';
    return `${width}|${lab}|${page}|${pageFrom}|${table ? identity(table) : ''}|${notes}|${excl}|${gridKey(this.grid)}|${this.hideDeleted.plain}${this.hideDeleted.movedFrom}${!!this.hideDeleted.inserted}|${this.boxes > 0}`;
  }

  paraEnv(width, label, table, exclusions) {
    const o = this.opts;
    return {doc: this.doc, shaper: this.shaper, width, label, fields: this.fields, showHidden: !!o.showHidden, fieldCodes: !!o.fieldCodes, mergeHighlight: !!o.mergeHighlight, designMode: !!o.designMode, endTags: this.endTags,
      hideDeleted: this.hideDeleted, table, exclusions, eqNumber: this.eqCount, numeral: o.numeral ?? 'arabic', grid: this.grid,
      readLineSpacing: o.view === 'read' ? o.readLineSpacing : null, fitObjects: this.boxes > 0, fitted: []};
  }
}

/** Which tracked deletions in `story` take no space (LayoutOptions::hides_deleted). */
export function hidesDeleted(opts, story) {
  const inserted = !!opts.hideInserted;
  if (opts.hideDeleted || (opts.deletionsInBalloons && story === 'body')) return {plain: true, movedFrom: true, inserted};
  return {plain: !!opts.hideMarked?.plain, movedFrom: !!opts.hideMarked?.movedFrom, inserted};
}

/** Floats anchored to the page or its margins in both directions (page_anchored). */
export function pageAnchored(f) {
  const h = ['page', 'margin', 'leftMargin', 'rightMargin', 'insideMargin', 'outsideMargin'];
  const v = ['page', 'margin', 'topMargin', 'bottomMargin', 'insideMargin', 'outsideMargin'];
  return h.includes(f.hRel) && v.includes(f.vRel);
}

/** Which control each end marker closes, by the marker object: a walk of the body's paragraphs (and table cells) with a stack of the open controls. */
function controlEndTags(ldoc) {
  const out = new WeakMap();
  const stack = [];
  const walk = (list, depth) => {
    if (depth > 12) return;
    for (const b of list) {
      if (b?.kind === 'para') {
        for (const o of b.objects ?? []) {
          if (o?.type === 'controlStart') stack.push(o.control);
          else if (o?.type === 'controlEnd') { const c = stack.pop(); if (c) out.set(o, c); }
        }
      } else if (b?.kind === 'table') for (const r of b.rows ?? []) for (const c of r.cells ?? []) walk(c.blocks ?? [], depth + 1);
    }
  };
  try { walk(ldoc.body ?? [], 0); } catch { /* a document that cannot be walked shows plain end tags */ }
  return out;
}
