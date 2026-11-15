// Shape Format › Insert Shapes › Merge Shapes: union, combine, fragment, intersect and subtract the
// outlines of the selected shapes. The result takes the formatting of the first selected shape, as
// in PowerPoint; a picture is cropped to the result so it stays where it was.
// Translated from deckcraft crates/engine/src/cmd/merge.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. A text box with no fill and no outline
// merges as its box here: deckcraft merges its letters, and the app has no text outlines yet.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasTwo, targets, currentSlide, writeShapes, newId, selectIds} from '../lib/shape-common.mjs';
import {findShape, isLine} from '../model/presentation.mjs';
import {xfrmOf} from '../model/doc.mjs';
import {shapeGeometry} from '../model/render.mjs';
import {xfrmAffine} from '../model/geom/index.mjs';
import {mergeAreas} from '../lib/polybool.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/merge.rs']};
export const OPS = Object.freeze(['union', 'combine', 'fragment', 'intersect', 'subtract']);
const SEGMENTS = 24;

/** The filled outline of a shape in slide points (curves flattened), as closed rings. */
export function areaOf(sh, x) {
  const m = xfrmAffine(x);
  const at = p => [m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]];
  const out = [];
  for (const sp of shapeGeometry(sh, x.w, x.h).paths) {
    if (sp.fill === 'none') continue;
    let cur = [], last = null;
    const flush = () => { if (cur.length > 2) out.push(cur); cur = []; };
    for (const e of sp.path ?? []) {
      if (e.t === 'M') { flush(); last = e.p; cur.push(at(e.p)); }
      else if (e.t === 'L') { last = e.p; cur.push(at(e.p)); }
      else if (e.t === 'Q' && last) {
        for (let i = 1; i <= SEGMENTS; i++) { const t = i / SEGMENTS, u = 1 - t; cur.push(at({x: u * u * last.x + 2 * u * t * e.p1.x + t * t * e.p.x, y: u * u * last.y + 2 * u * t * e.p1.y + t * t * e.p.y})); }
        last = e.p;
      } else if (e.t === 'C' && last) {
        for (let i = 1; i <= SEGMENTS; i++) {
          const t = i / SEGMENTS, u = 1 - t;
          cur.push(at({x: u ** 3 * last.x + 3 * u * u * t * e.p1.x + 3 * u * t * t * e.p2.x + t ** 3 * e.p.x, y: u ** 3 * last.y + 3 * u * u * t * e.p1.y + 3 * u * t * t * e.p2.y + t ** 3 * e.p.y}));
        }
        last = e.p;
      } else if (e.t === 'Z') flush();
    }
    flush();
  }
  // Drop repeated closing points.
  return out.map(r => (r.length > 1 && Math.abs(r[0][0] - r.at(-1)[0]) < 1e-9 && Math.abs(r[0][1] - r.at(-1)[1]) < 1e-9 ? r.slice(0, -1) : r)).filter(r => r.length > 2);
}

const num = v => String(Math.round(v * 100) / 100);
/** A custom-geometry box for `area`: its bounds and the path data relative to them. */
export function areaGeom(area) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of area) for (const p of r) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  if (!Number.isFinite(x0)) return null;
  const w = Math.max(x1 - x0, 0.01), h = Math.max(y1 - y0, 0.01);
  const d = area.map(r => `${r.map((p, i) => `${i ? 'L' : 'M'} ${num(p[0] - x0)} ${num(p[1] - y0)}`).join(' ')} Z`).join(' ');
  return {xfrm: {x: x0, y: y0, w, h}, geom: {kind: 'custom', paths: [{w, h, d, fill: 'norm', stroke: true}]}};
}

/** Keep a picture where it was on the slide when its box becomes `to` (upright, unflipped, stretched pictures only). */
function recrop(fill, from, to) {
  const f = fill.mode?.fillRect ?? [0, 0, 0, 0];
  if ((from.rot ?? 0) !== 0 || from.flipH || from.flipV || fill.mode?.kind === 'tile' || f.some(v => v !== 0)) return;
  const [l, t, r, b] = fill.crop ?? [0, 0, 0, 0];
  const fw = 1 - l - r, fh = 1 - t - b;
  if (!(fw > 1e-9 && fh > 1e-9 && from.w > 0 && from.h > 0)) return;
  const iw = from.w / fw, ih = from.h / fh, ix = from.x - l * iw, iy = from.y - t * ih;
  const c = [(to.x - ix) / iw, (to.y - iy) / ih, (ix + iw - to.x - to.w) / iw, (iy + ih - to.y - to.h) / ih];
  if (c.every(Number.isFinite)) fill.crop = c;
}

function merge(ctx, p) {
  const op = String(p.op ?? 'union').toLowerCase();
  if (!OPS.includes(op)) throw bad('shape.merge', `unknown op \`${op}\` (union, combine, fragment, intersect, subtract)`);
  const sl = currentSlide(ctx, 'shape.merge');
  const ids = targets(ctx, p, 'shape.merge');
  const shapes = ids.map(id => findShape(sl.shapes, id)).filter(Boolean);
  const mergeable = x => (x.kind?.type === 'shape' || x.kind?.type === 'picture') && !isLine(x);
  if (shapes.length < 2 || !shapes.every(mergeable) || shapes.some(x => !sl.shapes.some(t => t.id === x.id))) throw bad('shape.merge', 'select two or more shapes (not lines, groups, tables or charts)');
  const areas = shapes.map(x => areaOf(x, xfrmOf(ctx.doc, sl.id, x)));
  const results = mergeAreas(op, areas);
  const template = structuredClone(shapes[0]);
  const from = xfrmOf(ctx.doc, sl.id, shapes[0]);
  const newIds = [];
  const made = results.map((area, k) => {
    const g = areaGeom(area);
    if (!g) return null;
    const sh = structuredClone(template);
    sh.id = newId(ctx, 'shape.merge');
    newIds.push(sh.id);
    sh.ph = null;
    sh.xfrm = g.xfrm;
    sh.geom = g.geom;
    sh.name = `Freeform ${k + 1}`;
    if (sh.kind?.type === 'picture') recrop(sh.kind.fill, from, g.xfrm);
    if (k > 0) sh.text = null; // text stays with the first piece only
    return sh;
  }).filter(Boolean);
  const list = sl.shapes.filter(x => !ids.includes(x.id) || x.id === template.id);
  const at = list.findIndex(x => x.id === template.id);
  list.splice(at, 1, ...made);
  writeShapes(ctx, sl.id, list);
  selectIds(ctx, sl.id, newIds);
  return {ids: newIds};
}

const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);

export default defineCommands({
  family: 'merge',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [{
    id: 'shape.merge', label: 'Merge Shapes', risk: 'edit', state: hasTwo,
    description: '{op: union|combine|fragment|intersect|subtract, ids?: shapes in selection order (the first one keeps its formatting)} → {ids}',
    params: s.object({op: s.optional(s.string({max: 40})), ids: s.optional(s.array(ID, {max: 5000})), id: s.optional(ID)}),
    run: merge,
  }],
});
