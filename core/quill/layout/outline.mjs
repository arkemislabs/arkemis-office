// Outline view (View › Outline): the body as an outline of its headings. No pages: the text runs
// on one long sheet like Draft. Each paragraph is indented by its outline level and has a symbol
// in front of it: a circled plus for a heading with something under it, a circled minus for a
// heading with nothing under it, a small dot for body text. Collapsed headings hide what is under
// them and are marked with a wavy line; Show Level hides everything deeper than a level; Show
// First Line Only shows body paragraphs' first lines; without text formatting every paragraph is
// drawn in the Normal style. Paragraph indents and alignment aren't shown.
//
// Translated from wordcraft crates/layout/src/outline.rs and crates/layout/src/flow.rs
// (`OutlinePass`, `place_outline_para`) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What's collapsed is view state (never saved in the document): the caller passes it as
// `opts.outline` = {collapsed: [body block indices], showLevel, firstLineOnly, plain}.
import {pushPara, ownEdges} from './boxes.mjs';
import {placeObjects} from './floats.mjs';

/** The outline level of body text (headings are 1–9). */
export const BODY = 10;
/** How far each outline level is indented, points. */
export const LEVEL_INDENT = 21.6;
/** The gutter in front of each paragraph that holds its symbol, points. */
export const SYMBOL_W = 16;
const SYMBOL_GREY = [0x6E, 0x6E, 0x6E];

/** The deepest level shown (OutlineView::deepest): body text is BODY. */
export const deepest = view => (Number.isInteger(view?.showLevel) && view.showLevel >= 1 && view.showLevel <= 9 ? view.showLevel : BODY);

/** The outline level of a paragraph (para_level): 1–9 for headings, BODY for body text. `resolve(props)` gives the resolved paragraph. */
export function paraLevel(resolve, p) {
  const l = resolve(p?.props ?? {})?.outlineLevel;
  return Number.isInteger(l) && l >= 0 && l < 9 ? l + 1 : BODY;
}

/** The outline level of every body block (levels): tables are body text. */
export function levels(body, resolve) {
  return body.map(b => (b?.kind === 'para' ? paraLevel(resolve, b) : BODY));
}

/** The end (exclusive) of what is under block `i` (subtree_end). Body text has nothing under it. */
export function subtreeEnd(lv, i) {
  const l = lv[i];
  if (l === undefined) return i;
  if (l >= BODY) return i + 1;
  for (let j = i + 1; j < lv.length; j++) if (lv[j] <= l) return j;
  return lv.length;
}

/** Whether heading `i` has anything under it (has_children). */
export const hasChildren = (lv, i) => subtreeEnd(lv, i) > i + 1;

/** Which blocks the outline hides (hidden): deeper than Show Level, or under a collapsed heading. */
export function hidden(lv, view = {}) {
  const deep = deepest(view);
  const collapsed = view.collapsed instanceof Set ? view.collapsed : new Set(view.collapsed ?? []);
  let under = null;
  return lv.map((l, i) => {
    if (under !== null) {
      if (l > under) return true;
      under = null;
    }
    if (l > deep) return true;
    if (l < BODY && collapsed.has(i)) under = l;
    return false;
  });
}

/** How far block `i` is indented (indent): a heading by its level, body text one level deeper than the heading it follows. */
export function indent(lv, i) {
  const l = lv[i];
  if (l === undefined) return 0;
  let depth;
  if (l < BODY) depth = Math.max(l - 1, 0);
  else { depth = 0; for (let j = i - 1; j >= 0; j--) if (lv[j] < BODY) { depth = lv[j]; break; } }
  return depth * LEVEL_INDENT;
}

/** Character formatting kept without text formatting (plain_chars): what the text is, not how it looks. */
function plainChars(c) {
  const out = {};
  if (!c) return out;
  for (const k of ['hidden', 'lang', 'noProof', 'rtl', 'cs', 'langBidi', 'langEa', 'link', 'ins', 'del']) if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
  return out;
}

const shown = new WeakMap();
/**
 * The paragraph as the outline draws it (outline_para): no indents, start-aligned, and in the
 * Normal style without text formatting (`plain`). Kept per paragraph, so the layout cache hits.
 */
export function outlinePara(resolve, p, plain) {
  let m = shown.get(p);
  if (!m) { m = {}; shown.set(p, m); }
  const k = plain ? 'plain' : 'fmt';
  if (m[k]) return m[k];
  const props = {...(p.props ?? {}), indentLeft: 0, indentRight: 0, indentFirst: 0, align: 'left', pageBreakBefore: false};
  delete props.dropCap;
  delete props.indentLeftChars; delete props.indentRightChars; delete props.indentFirstChars;
  const q = {...p, props};
  if (plain) {
    const rp = resolve(p.props ?? {});
    delete props.style;
    const numbering = p.props?.numbering ?? rp?.numbering ?? null;
    if (numbering) props.numbering = numbering; else delete props.numbering;
    delete props.outlineLevel; delete props.shading; delete props.borders;
    q.runs = (p.runs ?? []).map(r => ({...r, props: plainChars(r.props)}));
    q.mark = plainChars(p.mark);
  }
  m[k] = q;
  return q;
}

/**
 * The symbol in front of a paragraph whose first line starts at (x, y) (symbol_items): a circled
 * plus or minus for a heading, a dot for body text; a wavy line under a collapsed heading's first line.
 */
export function symbolItems(pl, x, y, level, children, collapsed) {
  const first = pl.lines[0];
  if (!first) return [];
  const asc = Math.max(first.baseline - first.top, 4);
  const cy = y + asc * 0.62;
  const cx = x - SYMBOL_W + 6;
  const disc = r => ({kind: 'shape', rect: {x: cx - r, y: cy - r, w: r * 2, h: r * 2}, shape: 'ellipse', fill: SYMBOL_GREY, stroke: null, strokeWidth: 0, outlineSymbol: true});
  const white = {style: 'single', width: 1.1, color: [0xFF, 0xFF, 0xFF], space: 0};
  if (level >= BODY) return [disc(2)];
  const out = [disc(4.6), {kind: 'rule', x0: cx - 2.6, y0: cy, x1: cx + 2.6, y1: cy, border: white}];
  if (children) out.push({kind: 'rule', x0: cx, y0: cy - 2.6, x1: cx, y1: cy + 2.6, border: white});
  if (collapsed) {
    const w = Math.max(first.xs?.length ? first.xs[first.xs.length - 1] : 0, 12);
    const by = y + (first.baseline - first.top) + 3;
    out.push({kind: 'rule', x0: x, y0: by, x1: x + w, y1: by, border: {style: 'wave', width: 0.75, color: SYMBOL_GREY, space: 0}});
  }
  return out;
}

/** A short hash of a paragraph's text (text_hash): collapsed headings are found again by it. */
export function textHashOf(text) {
  let h = 0x811c9dc5;
  const t = String(text ?? '');
  for (let k = 0; k < t.length; k++) { h ^= t.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/**
 * Collapsed headings found again after edits (remap_collapsed_headings): each [block, hash] pair
 * goes to the nearest free heading with the same text (the earlier one on a tie), else stays when
 * its block is still a heading. `texts[j]` is block j's text (null for a table). Returns sorted pairs.
 */
export function remapPairs(lv, texts, pairs) {
  const hashes = texts.map(t => (t === null || t === undefined ? null : textHashOf(t)));
  const byHash = new Map();
  hashes.forEach((h, j) => { if (h !== null && lv[j] < BODY) { if (!byHash.has(h)) byHash.set(h, new Set()); byHash.get(h).add(j); } });
  const used = new Set();
  const out = [];
  for (const pair of pairs ?? []) {
    const [i, h] = Array.isArray(pair) ? pair : [pair, hashes[pair]];
    const free = j => lv[j] !== undefined && lv[j] < BODY && !used.has(j);
    let found = null;
    if (free(i) && hashes[i] === h) found = i;
    else {
      const set = byHash.get(h);
      if (set?.size) {
        let below = null, above = null;
        for (const j of set) { if (j <= i && (below === null || j > below)) below = j; if (j >= i && (above === null || j < above)) above = j; }
        found = below !== null && above !== null ? (Math.abs(above - i) < Math.abs(below - i) ? above : below) : below ?? above;
      }
      if (found === null && free(i)) found = i;
    }
    if (found !== null) {
      used.add(found);
      byHash.get(hashes[found])?.delete(found);
      out.push([found, hashes[found] ?? h]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** The outline state of an Outline view pass (OutlinePass::new); collapsed headings given as [block, hash] are found again first. */
export function outlinePass(doc, view = {}) {
  const resolve = props => doc.resolvePara(props);
  const lv = levels(doc.body, resolve);
  const pairs = view.collapsed ?? [];
  const collapsed = pairs.some(Array.isArray) ? remapPairs(lv, doc.body.map(b => (b?.kind === 'para' ? b.text : null)), pairs).map(([i]) => i) : pairs;
  const v = {...view, collapsed};
  return {view: {...v, collapsed: new Set(collapsed)}, levels: lv, hidden: hidden(lv, v), resolve};
}

/**
 * A body paragraph in Outline view (place_outline_para): one long sheet, no page or column breaks,
 * no floats wrapping; indented by its level behind its symbol; hidden when collapsed or deeper than
 * Show Level; body text cut to its first line with Show First Line Only.
 */
export function placeOutlinePara(ctx, pb, p, block, o) {
  // List numbers count the hidden paragraphs too.
  const label = ctx.nextLabel(p);
  if (o.hidden[block]) return;
  const level = o.levels[block] ?? BODY;
  const ind = indent(o.levels, block);
  const x = pb.colX() + ind + SYMBOL_W;
  const width = Math.max(pb.colW() - ind - SYMBOL_W, 72);
  const q = outlinePara(o.resolve, p, !!o.view.plain);
  ctx.fields.page = pb.number;
  const pl = ctx.paraLabelled(q, width, null, [], label);
  pb.y += Math.max(pl.rp.spaceBefore, 0);
  const n = pl.lines.length;
  const l1 = o.view.firstLineOnly && level >= BODY ? Math.min(n, 1) : n;
  const edges = ownEdges(pl, 0, l1);
  const y = pb.y + (pl.lines[0] ? Math.max(pl.lines[0].top, 0) : 0) + edges.top;
  const items = [];
  pushPara(items, 'body', [block], pl, 0, l1, x, y, width, edges);
  const [behind, front] = placeObjects(ctx, {story: 'body', path: [block], p: q, pl, lines: [0, l1], origin: [x, y], floats: new Map()});
  items.push(...front);
  const children = level < BODY && hasChildren(o.levels, block);
  // Collapsed, or with something under it hidden by Show Level: the wavy line says so.
  const collapsed = children && !!o.hidden[block + 1];
  items.push(...symbolItems(pl, x, y, level, children, collapsed));
  const pg = pb.page();
  if (pg) {
    behind.forEach((it, i) => pg.items.splice(Math.min(i, pg.items.length), 0, it));
    pg.items.push(...items);
  }
  const f = pl.lines[0], l = l1 > 0 ? pl.lines[l1 - 1] : null;
  if (f && l) pb.y = y + (l.top + l.height - f.top);
  pb.y += edges.bottom + Math.max(pl.rp.spaceAfter, 0);
}

/**
 * The outline symbol at page point (x, y), as the body block it belongs to (outline_symbol_at):
 * clicking a symbol selects the heading and what is under it.
 */
export function outlineSymbolAt(lay, page, x, y) {
  const pg = lay?.pages?.[page];
  if (!pg) return null;
  for (const it of pg.items) {
    if (it.kind !== 'lines' || it.story !== 'body' || it.l0 !== 0 || it.path?.length !== 1) continue;
    const first = it.para.lines[0];
    if (!first) continue;
    const r = {x: it.x - SYMBOL_W, y: it.y, w: SYMBOL_W, h: Math.max(first.height, 8)};
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return it.path[0];
  }
  return null;
}
