// Quill layout: a document turned into pages (see README.md for the API).
//
// Translated from wordcraft crates/layout/src/lib.rs (`layout`, `LayoutOptions`, `ViewMode`,
// `NumeralMode`, `Page`, `DocLayout`) (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c).
import {LDoc} from './ldoc.mjs';
import {LayoutCache, Totals, MAX_TOTAL_PASSES} from './cache.mjs';
import {layoutPass} from './pass.mjs';
import {footnotePages, MAX_NOTE_PASSES} from './notes.mjs';
import {getDefaultShaper} from './shaper.mjs';
import {DocLayout} from './hit.mjs';
import {CommandError} from '../../kernel/errors.mjs';

export {LayoutCache};
export {DocLayout};
export {createMetricsShaper, setDefaultShaper, getDefaultShaper} from './shaper.mjs';
export {pageDisplay} from './display.mjs';
export {ParaLayout, Line, CL, END, PARA_MARK_WIDTH} from './para/model.mjs';
export {outlineSymbolAt, BODY as OUTLINE_BODY} from './outline.mjs';

/** Views (ViewMode). */
export const VIEWS = Object.freeze(['print', 'web', 'draft', 'read', 'outline']);
/** Numeral modes (NumeralMode). */
export const NUMERALS = Object.freeze(['arabic', 'hindi', 'context', 'system']);

/** Resolve the `system` numeral mode against a locale tag (NumeralMode::resolve). */
export function resolveNumeral(mode, locale) {
  if (mode !== 'system') return mode;
  const lang = String(locale ?? '').split(/[_\-.@]/)[0].toLowerCase();
  return ['ar', 'fa', 'ur', 'ps', 'sd', 'ku', 'ckb'].includes(lang) ? 'hindi' : 'arabic';
}

/**
 * Lay out the whole document (layout). `src`: schema-2 content or a model Document. Options:
 * {view: 'print'|'web'|'draft'|'read'|'outline', webWidth, readHeight, readLineSpacing, outline: {collapsed, showLevel,
 * firstLineOnly, plain} (Outline view), showHidden,
 * hideDeleted, hideMarked: {plain, movedFrom}, deletionsInBalloons, numeral, fieldCodes, filename,
 * filepath, shaper, cache}. Pass the same `cache` (a LayoutCache) to every layout of a document:
 * unchanged paragraphs are not laid out again.
 */
export function layout(src, opts = {}) {
  const t0 = now();
  const doc = src instanceof LDoc ? src : new LDoc(src);
  const cache = opts.cache ?? new LayoutCache();
  const shaper = opts.shaper ?? getDefaultShaper();
  const o = {view: 'print', ...opts, numeral: resolveNumeral(opts.numeral ?? 'arabic', opts.locale)};
  const sections = doc.sections();
  const perPage = o.view === 'print' && sections.some(([, s]) => doc.noteOptions(s, false).numRestart === 'eachPage');
  let notePages = new Map();
  let notePasses = 1;
  let totals = Totals.firstGuess(sections.length);
  let passes = 0;
  for (;;) {
    const r = layoutPass(doc, cache, o, shaper, notePages, totals, passes < MAX_TOTAL_PASSES);
    if (r.again) { totals = r.again; passes++; continue; }
    if (perPage && notePasses < MAX_NOTE_PASSES) {
      const placed = footnotePages(doc, r.done.pages);
      if (!sameMap(placed, notePages)) { notePages = placed; notePasses++; continue; }
    }
    const lay = new DocLayout(doc, r.done.pages);
    lay.ms = now() - t0;
    lay.passes = passes + 1;
    return lay;
  }
}

function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The body range on page `n` (1-based, physical page order): {page, number, section, from, to}
 * positions of the first and last body text on it, or null for a page without body text.
 */
export function pageRange(lay, n) {
  const p = lay.pages[n - 1];
  if (!p) return null;
  let from = null, to = null;
  for (const it of p.items) {
    if (it.kind !== 'lines' || it.story !== 'body') continue;
    const a = {story: 'body', path: it.path.slice(), off: it.para.lines[it.l0].start};
    const b = {story: 'body', path: it.path.slice(), off: it.para.lines[it.l1 - 1].stop};
    if (!from || cmp(a, from) < 0) from = a;
    if (!to || cmp(b, to) > 0) to = b;
  }
  return {page: n - 1, number: p.number, section: p.section, from, to};
}
const cmp = (a, b) => { const n = Math.min(a.path.length, b.path.length); for (let i = 0; i < n; i++) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i]; return a.path.length - b.path.length || a.off - b.off; };

/**
 * Make `/page:<n>` addresses resolve (core/quill/address.mjs `setPageResolver`) through `layoutOf`
 * (content -> DocLayout; by default a layout per content version, kept while that content lives).
 */
export function installPageResolver(setPageResolver, layoutOf = null) {
  const laid = new WeakMap();
  const get = layoutOf ?? (content => { let l = laid.get(content); if (!l) { l = layout(content); laid.set(content, l); } return l; });
  setPageResolver((content, n, address) => {
    const r = pageRange(get(content), n);
    if (!r) {
      throw new CommandError('not_found', `No page ${n}`, {address});
    }
    return {kind: 'page', node: {index: r.page, number: r.number, section: r.section}, story: 'body', path: r.from?.path ?? [], from: r.from?.off ?? 0,
      to: r.to?.off ?? 0, end: r.to, address};
  });
}
