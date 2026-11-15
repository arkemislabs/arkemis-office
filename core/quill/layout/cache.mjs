// The incremental layout cache: paragraph layouts memoised per block, and page totals.
//
// Translated from wordcraft crates/layout/src/cache.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Upstream keys a paragraph by its revision number;
// the JS model shares unchanged blocks between versions (structural sharing), so the paragraph
// object itself is the revision: a WeakMap from paragraph to its layouts (by width, label, page
// context, table formatting, wrap areas, ...). An edit to one paragraph makes a new object for it
// alone; every other paragraph's layout is found again, and unreachable ones are collected.

/** How many layouts one paragraph keeps (widths, page contexts) before the oldest is dropped. */
const PER_PARA = 24;

export class LayoutCache {
  constructor() {
    this.paras = new WeakMap();
    this.measures = new WeakMap();
    this.env = null;
    this.hits = 0;
    this.misses = 0;
  }
  clear() { this.paras = new WeakMap(); this.measures = new WeakMap(); }
  /** The cached layout of paragraph `p` under `key`, or null. */
  get(p, key) {
    const m = this.paras.get(p);
    const pl = m ? m.get(key) : undefined;
    if (pl) { this.hits++; return pl; }
    return null;
  }
  put(p, key, pl) {
    this.misses++;
    let m = this.paras.get(p);
    if (!m) { m = new Map(); this.paras.set(p, m); }
    if (m.size >= PER_PARA) m.delete(m.keys().next().value);
    m.set(key, pl);
  }
}

/** What every cached layout depends on beyond its paragraph (env_hash). */
export function envKey(ldoc, opts, shaper) {
  const s = ldoc.settings;
  return [identity(ldoc.styles), identity(ldoc.numbering), s.defaultTab, s.footnoteFormat, s.endnoteFormat, s.compatMode, s.doNotExpandShiftReturn,
    s.hyphenationZone, s.consecutiveHyphenLimit, s.autoHyphenation, s.hyphenateCaps, JSON.stringify(ldoc.content.revisions?.map(r => r?.moveName ?? null) ?? []),
    opts.showHidden, JSON.stringify(opts.hideDeleted ?? null), JSON.stringify(opts.hideMarked ?? null), !!opts.hideInserted, opts.deletionsInBalloons, opts.numeral,
    opts.fieldCodes, opts.mergeHighlight ? 1 : 0, opts.designMode ? 1 : 0, opts.view, opts.filename ?? '', opts.filepath ?? '', shaper.key ?? identity(shaper), opts.readLineSpacing ?? '', opts.view === 'outline' ? !!opts.outline?.plain : ''].join('\u0001');
}

const ids = new WeakMap();
let nextId = 1;
/** A stable id for an object (its identity), for keys. */
export function identity(o) {
  if (o === null || o === undefined || (typeof o !== 'object' && typeof o !== 'function')) return String(o);
  let id = ids.get(o);
  if (!id) { id = `#${nextId++}`; ids.set(o, id); }
  return id;
}

/** Page totals of the document and of each section (Totals). */
export class Totals {
  constructor(pages, sections) { this.pages = pages; this.sections = sections; }
  static firstGuess(n) { return new Totals(1, new Array(n).fill(1)); }
  /** Count each section on every page holding its body (Totals::of). */
  static of(pages, sections) {
    const per = new Array(sections.length).fill(0);
    const ends = sections.map(s => s[0]);
    for (const page of pages) {
      const present = new Set([page.section]);
      for (const it of page.items) {
        if (it.story !== 'body') continue;
        const path = it.kind === 'cell' ? it.table : it.path;
        if (!path || !path.length) continue;
        const block = path[0];
        let lo = 0, hi = ends.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (ends[m] < block) lo = m + 1; else hi = m; }
        present.add(lo);
      }
      for (const s of present) if (s < per.length) per[s]++;
    }
    return new Totals(Math.max(1, pages.length), per.map(n => Math.max(1, n)));
  }
  section(si) { return this.sections[si] ?? 1; }
  equals(o) { return o && o.pages === this.pages && o.sections.length === this.sections.length && o.sections.every((v, i) => v === this.sections[i]); }
}

/** The most extra layout passes for page totals in the body (MAX_TOTAL_PASSES). */
export const MAX_TOTAL_PASSES = 3;
