// Word's SmartArt: the graphic a page draws and the SmartArt Design tab edits (U:quill/smartart).
//
// The model is core/quill/model/smart-art.mjs's graphic.smartArt `{layout, items: [{text, level}], colors}` plus the PowerPoint
// engine's `style` and `rtl`. The layouts, the outline operations (add, promote, demote, remove) and the shapes each layout
// generates are PowerPoint's (core/prism/lib/smartart.mjs, translated from deckcraft crates/engine/src/cmd/smartart*) and are
// imported as they are, so Word's 45 layouts, 17 colour schemes and 9 styles are the same as Prism's. Word draws what the engine
// generates by flattening each shape into chart primitives (the page view paints those: src/shell/charts/prims.ts), the way the
// chart is drawn. Not translated: the 3-D scene of the Brick Scene style and the bevels (shown flat, with the shadow), pictures
// in the picture layouts (a frame is drawn). No DOM, no Node built-ins.

import {
  LAYOUT_IDS, LAYOUTS, STYLE_IDS, STYLES, COLORS, MAX_NODES, MAX_LEVEL, build, layoutName, normalize, nodesFromLines,
} from '../../prism/lib/smartart.mjs';
import {shapeGeometry} from '../../prism/model/render.mjs';
import {resolveColor, colorAlpha} from '../../prism/model/style.mjs';
import {xfrmAffine} from '../../prism/model/geom/index.mjs';
import {apply, flatten} from '../../prism/model/geom/kurbo.mjs';
import {sampleSmartArt, smartArtLayoutFromId} from '../model/smart-art.mjs';

export {LAYOUT_IDS, LAYOUTS, STYLE_IDS, STYLES, COLORS, MAX_NODES, MAX_LEVEL, layoutName};
export const COLOR_IDS = Object.freeze(COLORS.map(c => c[0]));

/** The id of the PowerPoint layout a Word layout names (Word's first model called the block list `basicList`). */
export function engineLayout(id) {
  if (id === 'basicList') return 'blockList';
  return LAYOUT_IDS.includes(id) ? id : 'blockList';
}
/** The layout an id, a label or a legacy Word id names (case, spaces and hyphens ignored), or null. */
export function layoutFromId(id) {
  if (LAYOUT_IDS.includes(id)) return id;
  const n = String(id ?? '').replace(/[\s_-]/g, '').toLowerCase();
  const hit = LAYOUTS.find(([k, label]) => k.toLowerCase() === n || label.replace(/[\s_-]/g, '').toLowerCase() === n);
  if (hit) return hit[0];
  const legacy = smartArtLayoutFromId(id);
  return legacy ? engineLayout(legacy) : null;
}
export const colorsFromId = id => {
  if (COLOR_IDS.includes(id)) return id;
  const n = String(id ?? '').replace(/[\s_-]/g, '').toLowerCase();
  return COLORS.find(([k, label]) => k.toLowerCase() === n || label.replace(/[\s_-]/g, '').toLowerCase() === n)?.[0] ?? null;
};
export const styleFromId = id => {
  if (STYLE_IDS.includes(id)) return id;
  const n = String(id ?? '').replace(/[\s_-]/g, '').toLowerCase();
  return STYLES.find(([k, label]) => k.toLowerCase() === n || label.replace(/[\s_-]/g, '').toLowerCase() === n)?.[0] ?? null;
};

const MAX_TEXT = 255;
const clean = s => [...String(s ?? '').replace(/^[\s\p{Cc}]+/u, '')].slice(0, MAX_TEXT).map(c => (/\p{Cc}/u.test(c) ? ' ' : c)).join('').trimEnd();

/** A safe SmartArt model: a known layout, colours and style, at most MAX_NODES items with levels that follow on. */
export function cleanSpec(s0) {
  const layout = layoutFromId(s0?.layout) ?? 'blockList';
  const colors = colorsFromId(s0?.colors) ?? 'accent1';
  const style = styleFromId(s0?.style) ?? 'flat';
  const items = normalize((s0?.items ?? []).slice(0, MAX_NODES).map(it => ({
    text: clean(it?.text), level: Math.max(0, Math.min(MAX_LEVEL, Math.trunc(Number(it?.level) || 0))),
    ...(it?.assistant ? {assistant: true} : {}), ...(typeof it?.title === 'string' && it.title ? {title: clean(it.title)} : {}),
  })));
  return {layout, items: items.length ? items : [{text: '', level: 0}], colors, style, ...(s0?.rtl ? {rtl: true} : {}), ...(s0?.imported ? {imported: s0.imported} : {})};
}

/** A new graphic of `layout`: Word's sample items for its first eight layouts, "Text" boxes in the outline's shape for the rest. */
export function newSpec(layout = 'blockList', over = {}) {
  const id = layoutFromId(layout) ?? 'blockList';
  const legacy = {blockList: 'basicList'}[id] ?? id;
  let items;
  try { items = sampleSmartArt(legacy).items.map(it => ({text: it.text, level: it.level})); } catch { items = null; }
  if (!items || !['blockList', 'process', 'cycle', 'hierarchy', 'pyramid', 'radial', 'matrix', 'venn'].includes(id)) {
    const levels = {Hierarchy: [0, 1, 2, 2, 1], Matrix: [0, 0, 0, 0], List: [0, 1, 0, 1, 0, 1]}[LAYOUTS.find(l => l[0] === id)?.[2]] ?? [0, 0, 0, 0];
    items = levels.map(level => ({text: 'Text', level}));
  }
  return cleanSpec({layout: id, items, colors: 'accent1', style: 'flat', ...over});
}

/** The lines of an outline: a tab for each level. */
export const outlineLines = spec => spec.items.map(it => `${'\t'.repeat(it.level)}${it.text}`);
export {nodesFromLines};

// ---- the outline operations (the item at `index`) ----------------------------------------------------------------------------

const subtreeEnd = (items, i) => { let j = i + 1; while (j < items.length && items[j].level > items[i].level) j += 1; return j; };

/** Move item `i` with its sub-points above (-1) or below (1) the sibling on its level; null at the end of its level. */
export function moveItem(items, i, dir) {
  if (i < 0 || i >= items.length) return null;
  const list = items.map(n => ({...n}));
  const level = list[i].level;
  const end = subtreeEnd(list, i);
  if (dir < 0) {
    let at = i - 1;
    while (at >= 0 && list[at].level > level) at -= 1;
    if (at < 0 || list[at].level < level) return null;
    list.splice(at, 0, ...list.splice(i, end - i));
    return {items: list, index: at};
  }
  if (end >= list.length || list[end].level !== level) return null;
  const next = subtreeEnd(list, end);
  const block = list.splice(i, end - i);
  list.splice(next - (end - i), 0, ...block);
  return {items: list, index: next - (end - i)};
}

// ---- drawing ---------------------------------------------------------------------------------------------------------------

const rgba = (c, a = 1) => [c.r, c.g, c.b, Math.round(Math.max(0, Math.min(1, a)) * 255)];
const mix = (a, b) => ({r: (a.r + b.r) >> 1, g: (a.g + b.g) >> 1, b: (a.b + b.b) >> 1});
const shade = (c, k) => ({r: Math.round(c.r * k), g: Math.round(c.g * k), b: Math.round(c.b * k)});
const lighten = (c, k) => ({r: Math.round(c.r + (255 - c.r) * k), g: Math.round(c.g + (255 - c.g) * k), b: Math.round(c.b + (255 - c.b) * k)});

/** The theme as the engine's colour scheme (`colors`: twelve rgba) from a Quill document's [r, g, b] theme colours. */
export function schemeOf(themeColors) {
  const t = Array.isArray(themeColors) && themeColors.length >= 12 ? themeColors : null;
  const d = [[0, 0, 0], [255, 255, 255], [0x0e, 0x28, 0x41], [0xe8, 0xe8, 0xe8], [0x15, 0x60, 0x82], [0xe9, 0x71, 0x32], [0x19, 0x6b, 0x24], [0x0f, 0x9e, 0xd5],
    [0xa0, 0x2b, 0x93], [0x4e, 0xa7, 0x2e], [0x46, 0x78, 0x86], [0x96, 0x60, 0x7d]];
  return {colors: (t ?? d).map(([r, g, b]) => ({r, g, b, a: 255}))};
}

const approx = {textWidth: (text, size, bold) => [...String(text)].length * 0.5 * size * (bold ? 1.08 : 1)};

/** The paint of a fill: [r, g, b, a] or null. */
function fillOf(f, scheme) {
  if (!f || f.kind === 'none') return null;
  if (f.kind === 'solid') return rgba(resolveColor(f.color, scheme), colorAlpha(f.color));
  if (f.kind === 'gradient' && f.stops?.length) {
    const cs = f.stops.map(s => resolveColor(s.color, scheme));
    return rgba(cs.reduce(mix));
  }
  if (f.kind === 'picture') return [226, 226, 230, 255];
  return null;
}

/** A shape's text as primitives: wrapped to the shape's text rectangle and shrunk to fit it (the engine's autofit is `shrink`). */
function textPrims(sh, geo, M, scheme, measure) {
  const body = sh.text?.body ?? {};
  const tr = geo.textRect ?? {x0: 0, y0: 0, x1: sh.xfrm.w, y1: sh.xfrm.h};
  const x0 = tr.x0 + (body.insetL ?? 7.2), x1 = tr.x1 - (body.insetR ?? 7.2), y0 = tr.y0 + (body.insetT ?? 3.6), y1 = tr.y1 - (body.insetB ?? 3.6);
  const width = Math.max(1, x1 - x0), room = Math.max(1, y1 - y0);
  const paras = (sh.text?.paragraphs ?? []).map(p => {
    const text = (p.runs ?? []).map(r => r.text ?? '').join('');
    const size = p.runs?.[0]?.props?.size ?? 14;
    const color = fillOf(p.runs?.[0]?.props?.fill, scheme) ?? [255, 255, 255, 255];
    const bullet = p.props?.bullet?.kind === 'char';
    return {text: bullet && text ? `• ${text}` : text, size, color, align: p.props?.align ?? 'center', indent: Math.max(0, p.props?.marginLeft ?? 0)};
  }).filter(p => p.text !== '');
  if (!paras.length) return [];
  const lay = scale => paras.map(p => {
    const size = p.size * scale, avail = Math.max(8, width - p.indent * scale);
    const lines = [];
    let cur = '';
    for (const word of p.text.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && measure.textWidth(next, size, false) > avail) { lines.push(cur); cur = word; } else cur = next;
    }
    if (cur) lines.push(cur);
    return {...p, size, lines};
  });
  const heightOf = ls => ls.reduce((a, p) => a + p.lines.length * p.size * 1.2, 0);
  let scale = 1, laid = lay(1);
  for (let i = 0; i < 6 && heightOf(laid) > room && scale > 0.3; i++) { scale = Math.max(0.3, scale * Math.max(0.5, room / heightOf(laid)) * 0.98); laid = lay(scale); }
  let y = body.anchor === 'top' ? y0 : y0 + Math.max(0, (room - heightOf(laid)) / 2);
  const out = [];
  for (const p of laid) {
    for (const line of p.lines) {
      const left = p.align === 'left';
      const at = apply(M, {x: left ? x0 + p.indent * scale : (x0 + x1) / 2, y});
      out.push({t: 'text', x: at.x, y: at.y, text: line, size: p.size, color: p.color, bold: false, align: left ? 'left' : 'center', valign: 'top', rotation: 0});
      y += p.size * 1.2;
    }
  }
  return out;
}

/**
 * The graphic as chart primitives in points from its top left: every shape the layout generates, flattened and painted in the theme.
 * `spec` is a cleaned model; `measure` is the page's text measure ({textWidth(text, size, bold)}).
 */
export function smartArtPrims(spec, w, h, themeColors, measure = approx) {
  if (!(w >= 1 && h >= 1)) return [];
  const scheme = schemeOf(themeColors);
  const d = {kind: engineLayout(spec.layout), nodes: spec.items.map(n => ({...n})), colors: spec.colors ?? 'accent1', style: spec.style ?? 'flat'};
  let k = 0;
  const shapes = build(d, {x: 0, y: 0, w, h}, () => String(++k));
  const out = [];
  const mirror = !!spec.rtl;
  const place = p => ({x: mirror ? w - p.x : p.x, y: p.y});
  for (const sh of shapes) {
    const x = sh.xfrm;
    const M = xfrmAffine({x: x.x, y: x.y, w: x.w, h: x.h, rot: x.rot ?? 0, flipH: !!x.flipH, flipV: !!x.flipV});
    let geo;
    try { geo = shapeGeometry(sh, x.w, x.h); } catch { continue; }
    const fill = fillOf(sh.fill, scheme);
    const lineFill = fillOf(sh.line?.fill, scheme);
    const lw = Math.max(0.25, sh.line?.width ?? 0.75);
    const shadow = sh.effects?.outerShadow;
    for (const path of geo.paths) {
      const polys = [];
      let cur = null;
      flatten(path.path.map(el => (el.t === 'Z' ? el : {...el, ...(el.p ? {p: apply(M, el.p)} : {}), ...(el.p1 ? {p1: apply(M, el.p1)} : {}), ...(el.p2 ? {p2: apply(M, el.p2)} : {})})), 0.15, el => {
        if (el.t === 'M') { cur = {pts: [place(el.p)], closed: false}; polys.push(cur); } else if (el.t === 'L' && cur) cur.pts.push(place(el.p)); else if (el.t === 'Z' && cur) cur.closed = true;
      });
      for (const poly of polys) {
        const pts = poly.pts.map(p => [p.x, p.y]);
        if (pts.length < 2) continue;
        const filled = fill && path.fill !== 'none' && (poly.closed || pts.length > 2);
        if (filled && pts.length >= 3) {
          let col = fill;
          if (path.fill === 'darken') col = rgba(shade({r: fill[0], g: fill[1], b: fill[2]}, 0.8), fill[3] / 255);
          else if (path.fill === 'darkenLess') col = rgba(shade({r: fill[0], g: fill[1], b: fill[2]}, 0.9), fill[3] / 255);
          else if (path.fill === 'lighten') col = rgba(lighten({r: fill[0], g: fill[1], b: fill[2]}, 0.3), fill[3] / 255);
          else if (path.fill === 'lightenLess') col = rgba(lighten({r: fill[0], g: fill[1], b: fill[2]}, 0.15), fill[3] / 255);
          if (shadow && fill[3] > 200 && path.fill === 'norm') {
            const dy = Math.min(4, (shadow.dist ?? 3) * 0.6);
            out.push({t: 'poly', pts: pts.map(([px, py]) => [px, py + dy]), fill: [0, 0, 0, 55], stroke: null});
          }
          out.push({t: 'poly', pts, fill: col, stroke: lineFill && path.stroke !== false ? [lineFill, lw] : null});
        } else if (lineFill && path.stroke !== false) {
          out.push({t: 'line', pts: poly.closed ? [...pts, pts[0]] : pts, color: lineFill, width: lw, dash: false});
        }
      }
    }
    if (sh.text) {
      for (const t of textPrims(sh, geo, M, scheme, measure)) out.push(mirror ? {...t, x: w - t.x, align: t.align === 'left' ? 'right' : t.align} : t);
    }
  }
  return out;
}

const cache = new WeakMap();
/** smartArtPrims for a graphic's model, remembered while the model object, size and theme stay the same. */
export function cachedPrims(spec, w, h, themeColors, measure) {
  const hit = cache.get(spec);
  if (hit && hit.w === w && hit.h === h && hit.theme === themeColors && hit.measure === measure) return hit.prims;
  const prims = smartArtPrims(spec, w, h, themeColors, measure);
  cache.set(spec, {w, h, theme: themeColors, measure, prims});
  return prims;
}
