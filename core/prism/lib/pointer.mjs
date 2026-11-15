// Pointer tools on the slide: what a point hits, and what pressing, dragging, releasing,
// double-, triple- and right-clicking do with the active tool (select, draw a shape or text box,
// freeform, ink). Gestures arrive in slide coordinates (points) from the surface or the automation layer used by
// tests alike; each finished gesture is one undo step.
// Translated from deckcraft crates/engine/src/tools.rs and tools/{pointer,click,drag,hit,
// geometry}.rs (Session::pointer, hit_test, down/drag/up, double_click, context_click,
// place_caret, edit_text_at, snap_rect/snap_edges/snap_resize, set_xfrm, execute_dup_in_place,
// guide_at, ink_sample/add_ink/erase_at, finish_freeform, box_handles, resize_box, line_xfrm,
// constrain_45, edit_zone, hit_shape, shape_in_front, text_member_at) and
// crates/engine/src/cmd/text/layout.rs (text_frame, text_pos_at) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Foundation-owned (F:prism). No DOM, no Node built-ins.
//
// How it maps onto the kernel. deckcraft mutates the live document during a drag and pushes one
// history entry when the gesture ends. Here a `PointerSession` works on a copy of the current
// slide (the surface paints that copy while the pointer is down) and an IO adapter writes the
// result: the surface's adapter keeps it as a preview; the `surface.pointer` command's adapter
// replays the same events inside one kernel transaction and writes the changed slide and the
// selection through ctx.change, so the gesture lands as one undo entry labelled as deckcraft labels
// it ("Move", "Size", "Rotate", "Adjust Shape", "Duplicate", "Ink", "Erase"). Steps deckcraft runs as
// commands (text.edit, shape.insert, guide.move, ...) go through `io.run`, i.e. ctx.run, so they
// are the command families' own code; when a family is not registered the step is not taken.
//
// Edit Points vertex and handle drags are lib/points.mjs (cmd/points.rs). Not translated here (their
// hits never occur, so nothing pretends to do them): WordArt warp handles (geom/warp.rs) and the text-box
// refit after a resize (cmd/text fit_text_box, U:prism/text). Tables (cmd/table.rs table_frame, U:prism/table): cell
// hit testing, a click into a cell, a drag across cells (a range), and the borders that resize rows and columns.

import {findShape, isLine, isGroup, presetName, allocId, NO_ID_SPACE} from '../model/presentation.mjs';
import {info as presetInfo, isLineLike} from '../model/geom/preset/catalog.mjs';
import {handleValueAt, outline} from '../model/geom/preset/builder.mjs';
import {xfrmAffine, xfrmBounds, groupChildAffine, nearPath, snap as snapTo} from '../model/geom/index.mjs';
import {pt, add, sub, mul, hypot, apply, affInverse, affChain, affTranslate, affRotate, IDENTITY, rectFromPoints, rectUnion, winding,
  rectCenter, rectTranslate, rectInset} from '../model/geom/kurbo.mjs';
import {shapeGeometry} from '../model/render.mjs';
import {ctxForSlide} from '../model/resolve.mjs';
import {layoutText, hitText} from '../model/textlayout.mjs';
import {posOf, offsetOf, bodyLen} from '../model/text.mjs';
import {currentSlideId, selectedShapeIds, textSelection, shapeChain, selectShapes, selectSlides, selectText, selectNotes,
  textAddress, slideById, slideSizeOf, withSlideReplaced} from '../model/doc.mjs';
import {cellSelection, selectCellsOf, tableFrame as makeTableFrame, MIN_COLUMN_WIDTH} from './table-sel.mjs';
import {drawnHeights, resolveStyle as tableStyleOf, cellBody as tableCellBody, cellShape as tableCellShape} from '../model/table-style.mjs';
import * as pts from './points.mjs';
import {boxOf, nearestSite, siteShapeAt, sites as siteList, endpoints, lineXfrm, reroute, setGlue} from './connect.mjs';

/** deckcraft engine `Prefs` defaults for the pointer (Grid and Guides): snap to grid, 6 pt grid, smart guides. */
export const DEFAULT_PREFS = Object.freeze({snapToGrid: true, gridSpacing: 6, smartGuides: true});
/** Pointer preferences from the session prefs (`prefs.prism`), clamped as deckcraft's `Prefs::sanitized`. */
export function pointerPrefs(prefs) {
  const p = prefs?.prism ?? {};
  const spacing = Number.isFinite(p.gridSpacing) && p.gridSpacing > 0 ? Math.min(Math.max(p.gridSpacing, 0.5), 1000) : DEFAULT_PREFS.gridSpacing;
  return {snapToGrid: p.snapToGrid ?? DEFAULT_PREFS.snapToGrid, gridSpacing: spacing, smartGuides: p.smartGuides ?? DEFAULT_PREFS.smartGuides};
}

export const POINTER_KINDS = Object.freeze(['down', 'drag', 'up', 'move', 'doubleClick', 'tripleClick', 'contextClick']);
/** Shape-gallery names that draw a freeform path instead of a preset. */
export const FREEFORM_TOOLS = Object.freeze([['curve', 'Curve'], ['freeform', 'Freeform: Shape'], ['scribble', 'Freeform: Scribble']]);
/** Draw Table's pencil and eraser, as shape-tool presets (Insert › Table › Draw Table). */
export const DRAW_TABLE = 'drawTable';
export const TABLE_ERASER = 'tableEraser';
export const isFreeformTool = name => FREEFORM_TOOLS.some(f => f[0] === name);

/**
 * The active tool from the session view state. `view.tool` is written by the tool.* commands:
 * `{kind:'select'} | {kind:'shape', preset} | {kind:'textBox'} | {kind:'ink', mode:'pen'|'highlighter'|'eraser', color, width}`,
 * plus `sticky` (lock drawing mode).
 */
export function toolFromView(view) {
  const t = view?.tool;
  if (!t || typeof t !== 'object') return {kind: 'select'};
  if (t.kind === 'shape' && typeof t.preset === 'string' && t.preset) return {kind: 'shape', preset: t.preset};
  if (t.kind === 'textBox') return {kind: 'textBox'};
  if (t.kind === 'lasso') return {kind: 'lasso'};
  if (t.kind === 'eyedropper') return {kind: 'eyedropper', target: String(t.target ?? 'text')};
  if (t.kind === 'ink' && ['pen', 'highlighter', 'eraser'].includes(t.mode)) {
    return {kind: 'ink', mode: t.mode, color: t.color ?? {r: 0, g: 0, b: 0, a: 255}, width: Number.isFinite(t.width) ? t.width : 2.25};
  }
  return {kind: 'select'};
}

/** A fresh ToolState for `view` (deckcraft `ToolState::default` with the tool, sticky flag and guides from the view). */
export function newToolState(view = {}) {
  return {
    kind: toolFromView(view), sticky: !!view?.tool?.sticky, drag: restoreDrag(view?.toolDrag), marquee: null, preview: null, guides: [], hover: null,
    inkPreview: [], sites: [], glue: null, pathPreview: [], pathSmooth: false, pathClosing: false, guidesVisible: !!view?.guides, guideDrag: null,
    guideHover: null, pressure: null, editPoints: restoreEdit(view?.editPoints),
  };
}
/** Edit Points state kept between gestures (`view.editPoints`): the shape, the vertex whose handles show, the remembered point type. */
function restoreEdit(e) {
  if (!e || e.id === undefined || e.id === null) return null;
  return {id: String(e.id), vertex: Array.isArray(e.vertex) && e.vertex.length === 2 ? [e.vertex[0], e.vertex[1]] : null, ...(Array.isArray(e.segment) && e.segment.length === 3 ? {segment: [e.segment[0], e.segment[1], e.segment[2]]} : {}), ...(e.kind ? {kind: e.kind} : {})};
}
/**
 * The Ruler stencil (view.rulerStencil {x, y, angle, on}, 520 x 70 pt from its top left corner, turned by angle degrees): a function that puts a
 * point on the ruler's top edge when `p` is within 14 pt of it (any distance with `force`), else null. Not checked against upstream.
 */
export function rulerSnap(view, p, force = false) {
  const r = view?.rulerStencil;
  if (!r || r.on === false || !Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
  const a = ((r.angle ?? 0) * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
  const along = (p.x - r.x) * ux + (p.y - r.y) * uy, dist = -(p.x - r.x) * uy + (p.y - r.y) * ux;
  if (!force && (Math.abs(dist) > 14 || along < -10 || along > 530)) return null;
  return q => { const t = (q.x - r.x) * ux + (q.y - r.y) * uy; return pt(r.x + t * ux, r.y + t * uy); };
}

/** A freeform being drawn spans several clicks: it is the only drag kept between gestures. */
function restoreDrag(d) {
  if (!d || d.kind !== 'freeform' || !Array.isArray(d.points)) return null;
  return {kind: 'freeform', mode: String(d.mode), points: d.points.filter(q => Number.isFinite(q?.x) && Number.isFinite(q?.y)).map(q => pt(q.x, q.y)), pressed: false};
}
/** What survives a gesture in the view state (`view.toolDrag`). */
export const persistDrag = tool => (tool.drag?.kind === 'freeform' ? {kind: 'freeform', mode: tool.drag.mode, points: tool.drag.points} : null);

// ---------------------------------------------------------------------------------------------
// Geometry helpers (tools.rs, tools/hit.rs)

/** Handle positions in slide coordinates for a box: 8 resize handles (NW, N, NE, E, SE, S, SW, W) and the rotate handle. */
export function boxHandles(x) {
  const a = xfrmAffine(x);
  const {w, h} = x;
  const local = [[0, 0], [w / 2, 0], [w, 0], [w, h / 2], [w, h], [w / 2, h], [0, h], [0, h / 2]];
  const pts = local.map(([px, py]) => apply(a, pt(px, py)));
  // The rotation handle sits above the top edge (in the shape's rotated frame).
  const up = x.flipV ? 1 : -1;
  const m = affChain(affTranslate(pt(x.x + w / 2, x.y + h / 2)), affRotate(((x.rot ?? 0) * Math.PI) / 180));
  return {pts, rot: apply(m, pt(0, up * (h / 2 + 20)))};
}

/** Constrain `b` to the nearest 45° direction from `a` (Shift while drawing lines). */
export function constrain45(a, b) {
  const d = sub(b, a);
  const ang = Math.atan2(d.y, d.x);
  const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
  const len = hypot(d);
  return add(a, pt(Math.cos(snapped) * len, Math.sin(snapped) * len));
}

/** New box when dragging resize handle `h` by `d` (slide space), keeping the shape's rotation. */
export function resizeBox(o, h, d, keepAspect, fromCenter) {
  const rot = affRotate((-(o.rot ?? 0) * Math.PI) / 180);
  const ld = apply(rot, pt(d.x, d.y));
  let l = 0, t = 0, r = o.w, b = o.h;
  const sx = o.flipH ? -1 : 1, sy = o.flipV ? -1 : 1;
  const dx = ld.x * sx, dy = ld.y * sy;
  switch (h) {
    case 0: l += dx; t += dy; break;
    case 1: t += dy; break;
    case 2: r += dx; t += dy; break;
    case 3: r += dx; break;
    case 4: r += dx; b += dy; break;
    case 5: b += dy; break;
    case 6: l += dx; b += dy; break;
    default: l += dx;
  }
  if (fromCenter) {
    // Symmetric growth about the centre.
    const gw = [0, 6, 7].includes(h) ? -dx : h >= 2 && h <= 4 ? dx : 0;
    const gh = h <= 2 ? -dy : h >= 4 && h <= 6 ? dy : 0;
    l = -gw; r = o.w + gw; t = -gh; b = o.h + gh;
  }
  let w = r - l;
  let hh = b - t;
  const sign = v => (v > 0 ? 1 : v < 0 ? -1 : v);
  // Rust f64::signum: +1 for +0.0 and positive, -1 for negative.
  const signum = v => (v < 0 || Object.is(v, -0) ? -1 : 1);
  if (keepAspect && o.w > 1e-9 && o.h > 1e-9 && ![1, 3, 5, 7].includes(h)) {
    const ar = o.w / o.h;
    if (Math.abs(w / ar) > Math.abs(hh)) hh = (Math.abs(w) / ar) * Math.max(signum(hh), hh === 0 ? 1 : signum(hh));
    else w = Math.abs(hh) * ar * Math.max(signum(w), w === 0 ? 1 : signum(w));
    if (h === 0 || h === 6) l = r - w; else r = l + w;
    if (h === 0 || h === 2) t = b - hh; else b = t + hh;
    if (fromCenter) {
      const cx = o.w / 2, cy = o.h / 2;
      l = cx - w / 2; r = cx + w / 2; t = cy - hh / 2; b = cy + hh / 2;
    }
  }
  void sign;
  // Dragging past the opposite edge flips.
  let fh = !!o.flipH, fv = !!o.flipV;
  if (r < l) { [l, r] = [r, l]; fh = !fh; }
  if (b < t) { [t, b] = [b, t]; fv = !fv; }
  const nw = r - l, nh = b - t;
  // New centre in slide space: old centre + rotated offset of the local centre change.
  const lc = pt(((l + r) / 2) * sx + (sx < 0 ? o.w : 0), ((t + b) / 2) * sy + (sy < 0 ? o.h : 0));
  const c = apply(xfrmAffine(o), pt(o.flipH ? o.w - lc.x : lc.x, o.flipV ? o.h - lc.y : lc.y));
  const out = {x: c.x - nw / 2, y: c.y - nh / 2, w: nw, h: nh};
  if (o.rot) out.rot = o.rot;
  if (fh) out.flipH = true;
  if (fv) out.flipV = true;
  return out;
}

/** Where a point falls against the box of the text being edited: 'inside', 'frame' (a band `tol` wide on the edge) or 'outside'. */
export function editZone(x, p, tol) {
  const l = apply(affInverse(xfrmAffine(x)), p);
  const w = Math.max(x.w, 0), h = Math.max(x.h, 0);
  const t = Number.isFinite(tol) ? Math.max(tol, 0) : 0;
  if (!(Number.isFinite(l.x) && Number.isFinite(l.y)) || l.x < -t || l.y < -t || l.x > w + t || l.y > h + t) return 'outside';
  const inner = Math.min(t, w / 4, h / 4);
  return l.x > inner && l.y > inner && l.x < w - inner && l.y < h - inner ? 'inside' : 'frame';
}

export const containsRect = (outer, inner) => inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
const childRect = g => { const c = g.kind?.child ?? {x: 0, y: 0, w: g.xfrm?.w ?? 0, h: g.xfrm?.h ?? 0}; return {x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h}; };
const rad = d => (d * Math.PI) / 180;

/** Copy-on-write update of shape `id` anywhere in `list` (groups included): returns the new list, or `list` when absent. */
export function updateShape(list, id, f) {
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.id === id) { const out = list.slice(); out[i] = f(s); return out; }
    if (isGroup(s)) {
      const kids = updateShape(s.kind.children ?? [], id, f);
      if (kids !== s.kind.children) { const out = list.slice(); out[i] = {...s, kind: {...s.kind, children: kids}}; return out; }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------------------------
// The session

/**
 * Pointer handling over one presentation and selection. `io`:
 *   read(): {content, selection}  the document as it stands (the kernel's, or the surface's base)
 *   write(content, selection)     take this session's edits (flushed before each `run`)
 *   run?(id, params)              run a command (absent in the surface's live preview)
 *   has?(id)                      is that command registered
 * `measure(font, text) -> width` and `metrics(font)` lay out text for caret placement.
 */
export class PointerSession {
  constructor({io, view = {}, prefs = null, tool = null, measure = null, metrics = null}) {
    this.io = io;
    this.view = view ?? {};
    this.prefs = pointerPrefs(prefs);
    this.tool = tool ?? newToolState(this.view);
    this.measure = measure;
    this.metrics = metrics;
    this.label = null;          // the open interaction's undo label (deckcraft `begin`)
    this.labels = [];           // every interaction label this session committed
    this.deferred = [];         // commands a preview could not run
    this.uiRequests = [];       // {pane:'format'} after a double-click on a picture etc.
    this.reload();
  }

  // ---- document access -------------------------------------------------------------------------

  reload() {
    const {content, selection} = this.io.read();
    this.base = content;
    this.content = content;
    this.slideId = currentSlideId(content, selection);
    this.sel = this.fromKernel(content, selection);
  }
  get slideIndex() { return (this.content.slides ?? []).findIndex(s => s.id === this.slideId); }
  /** The slide being edited: a real slide, or a master, layout, handout or notes master edited as one (a virtual slide). */
  slide() { return slideById(this.content, this.slideId); }
  size() { return slideSizeOf(this.content, this.slide()); }
  shapes() { return this.slide()?.shapes ?? []; }
  shape(id) { return findShape(this.shapes(), id); }
  xf(sh) { return boxOf(this.content, this.slide(), sh); }
  has(id) { return this.io.has ? !!this.io.has(id) : !!this.io.run; }

  /** deckcraft Selection from the kernel's: {shapes, text: {shape, chain, anchor:[p,c], caret:[p,c], cell, notes} | null}. */
  fromKernel(content, selection) {
    const sel = {shapes: selectedShapeIds(content, selection), text: null};
    const t = textSelection(content, selection);
    if (t && t.slide === this.slideId) {
      const sl = slideById(content, t.slide);
      const body = t.notes ? sl?.notes : t.cell ? findShape(sl?.shapes, t.shape)?.kind?.rows?.[t.cell[0]]?.cells?.[t.cell[1]]?.text : findShape(sl?.shapes, t.shape)?.text;
      const pos = n => (body ? posOf(body, Math.min(n, bodyLen(body))) : [0, 0]);
      sel.text = {shape: t.shape, chain: t.chain, anchor: pos(t.anchor), caret: pos(t.caret), cell: t.cell, notes: t.notes};
      if (!t.notes && t.shape && !sel.shapes.includes(t.shape)) sel.shapes = [t.shape];
    }
    // A range of table cells: two cell addresses, no text offset.
    sel.cells = null;
    const cs = !sel.text ? cellSelection(content, selection) : null;
    if (cs && cs.slide === this.slideId) { sel.cells = {shape: cs.shape, from: cs.from, to: cs.to}; sel.shapes = [cs.shape]; }
    return sel;
  }
  /** The kernel selection for this session's. */
  toKernel() {
    const sl = this.slide();
    if (!sl) return {ranges: [], primary: 0};
    const t = this.sel.text;
    if (t) {
      if (t.notes) return selectNotes(sl.id, offsetOf(sl.notes ?? {paragraphs: []}, t.anchor), offsetOf(sl.notes ?? {paragraphs: []}, t.caret));
      const chain = shapeChain(sl, t.shape) ?? [t.shape];
      const sh = findShape(sl.shapes, t.shape);
      if (t.cell) {
        const body = sh?.kind?.rows?.[t.cell[0]]?.cells?.[t.cell[1]]?.text ?? {paragraphs: []};
        const base = `/sl:${sl.id}${chain.map(id => `/sp:${id}`).join('')}/r:${t.cell[0]}/c:${t.cell[1]}`;
        return {ranges: [{anchor: `${base}/t:${offsetOf(body, t.anchor)}`, focus: `${base}/t:${offsetOf(body, t.caret)}`}], primary: 0};
      }
      const body = sh?.text ?? {paragraphs: []};
      return selectText(sl.id, chain, offsetOf(body, t.anchor), offsetOf(body, t.caret));
    }
    if (this.sel.cells) return selectCellsOf(this.content, sl.id, this.sel.cells.shape, this.sel.cells.from, this.sel.cells.to);
    const chains = this.sel.shapes.map(id => shapeChain(sl, id)).filter(Boolean);
    return chains.length ? selectShapes(sl.id, chains) : selectSlides([sl.id]);
  }

  /** deckcraft `Session::edit` on the current slide: `f(shapes, slide)` returns the new shape list; connectors reroute after. */
  edit(f) {
    const sl = this.slide();
    if (!sl) throw Object.assign(new Error('no slide'), {code: 'invalid_params'});
    const next = {...sl, shapes: f(sl.shapes.slice(), sl) ?? sl.shapes};
    next.shapes = next.shapes.slice();
    reroute(this.content, next);
    this.content = withSlideReplaced(this.content, next);
  }
  setShape(id, f) { this.edit(list => updateShape(list, id, f)); }
  select(f) { f(this.sel); this.clampSelection(); }
  clampSelection() {
    const list = this.shapes();
    this.sel.shapes = this.sel.shapes.filter(id => findShape(list, id));
    if (this.sel.text && !this.sel.text.notes && !findShape(list, this.sel.text.shape)) this.sel.text = null;
    // Cells stay selected only while their table is the one selected shape.
    const cs = this.sel.cells;
    if (cs && (this.sel.text || this.sel.shapes.length !== 1 || this.sel.shapes[0] !== cs.shape || findShape(list, cs.shape)?.kind?.type !== 'table')) this.sel.cells = null;
  }

  /** Hand the edits so far to the IO adapter. */
  flush() { this.io.write(this.content, this.toKernel()); }
  /** Run a command the way deckcraft's pointer does (`self.execute`). Returns its result, or null when it can't run here. */
  exec(id, params) {
    if (!this.io.run || !this.has(id)) { this.deferred.push(id); return null; }
    this.flush();
    const r = this.io.run(id, params);
    this.reload();
    // A command run inside an interaction (a table border drag) is the interaction's change.
    if (this.label) this.ranCommand = true;
    return r ?? null;
  }
  /** `execute(...).unwrap_or(Null)`: a command that can't apply (a pencil line that divides no cell) leaves the gesture as it was. */
  tryExec(id, params) {
    try { return this.exec(id, params); } catch { return null; }
  }
  begin(label) { if (!this.label) this.label = label; }
  commit() {
    if (this.label && (this.content !== this.base || this.ranCommand)) this.labels.push(this.label);
    this.label = null;
    this.ranCommand = false;
  }

  // ---- hit testing ------------------------------------------------------------------------------

  /** What's under `p` on the current slide (deckcraft `hit_test`). */
  hitTest(p, tol) {
    const sl = this.slide();
    if (!sl) return null;
    // In Edit Points, the edited shape's vertices come first.
    const ep = this.editingPoints();
    if (ep) {
      const x = this.xf(ep);
      const ed = this.tool.editPoints;
      if (ed.vertex) {
        const h = pts.slideHandles(ep, x, ed.vertex[0], ed.vertex[1]);
        if (h) for (const [q, out] of [[h.hout, true], [h.hin, false]]) if (q && hypot(sub(q, p)) <= tol * 1.6) return {kind: 'handle', id: ep.id, path: ed.vertex[0], index: ed.vertex[1], out};
      }
      const v = pts.vertexAt(ep, x, p, tol * 1.6);
      if (v) return {kind: 'vertex', id: ep.id, path: v[0], index: v[1]};
    }
    // Handles of selected shapes first.
    if (!this.sel.text || this.sel.shapes.length === 1) {
      for (const id of [...this.sel.shapes].reverse()) {
        const sh = this.shape(id);
        // A locked object shows no live handles: it can't be sized, rotated or reshaped.
        if (!sh || sh.locked) continue;
        const x = this.xf(sh);
        const a = xfrmAffine(x);
        if (isLine(sh)) {
          for (const [end, q] of [[0, apply(a, pt(0, 0))], [1, apply(a, pt(x.w, x.h))]]) {
            if (hypot(sub(q, p)) <= tol * 1.6) return {kind: 'lineEnd', id, end};
          }
          continue;
        }
        const geo = shapeGeometry(sh, x.w, x.h);
        for (const hd of geo.handles ?? []) {
          if (hypot(sub(apply(a, hd.pos), p)) <= tol * 1.6) return {kind: 'adjust', id, index: hd.index};
        }
        const {pts, rot} = boxHandles(x);
        if (hypot(sub(rot, p)) <= tol * 1.8 && !this.sel.text) return {kind: 'rotate', id};
        for (let i = 0; i < pts.length; i++) if (hypot(sub(pts[i], p)) <= tol * 1.6) return {kind: 'resize', id, handle: i};
      }
    }
    // The frame of the text being edited: grabbing it moves the box, unless a shape in front of
    // the text covers that spot (#931).
    const e = this.editedBox();
    if (e && e.movable && editZone(e.xfrm, p, tol) === 'frame' && !this.shapeInFront(this.shapes(), e.id, p, tol, 0)) return {kind: 'frame', id: e.id};
    // Shapes, topmost first. Locked objects are still picked (to format them or type in them); they just don't move.
    const list = this.shapes();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].hidden) continue;
      const h = this.hitShape(list[i], p, tol);
      if (h) return h;
    }
    return null;
  }

  isTextFirst(id) { const s = this.shape(id); return !!s && (!!s.ph || !!s.textBox); }

  /** The box whose text is being edited on the slide (not notes, not a table cell). */
  editedBox() {
    const t = this.sel.text;
    if (!t || t.notes || t.cell) return null;
    const sh = this.shape(t.shape);
    if (!sh) return null;
    return {id: t.shape, xfrm: this.xf(sh), movable: !isLine(sh) && !sh.locked};
  }

  /** Whether a visible shape drawn in front of `target` is under `p`. */
  shapeInFront(shapes, target, p, tol, depth) {
    if (depth > 64) return false;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.id === target) return false;
      if (findShape([s], target)) return this.shapeInFront(s.kind?.children ?? [], target, p, tol, depth + 1);
      if (!s.hidden && this.hitShape(s, p, tol)) return true;
    }
    return false;
  }

  /** deckcraft `hit_shape`. */
  hitShape(sh, p, tol) {
    const x = this.xf(sh);
    const local = apply(affInverse(xfrmAffine(x)), p);
    const k = sh.kind?.type;
    if (k === 'group') {
      // A group is hit when any child is hit; the group is what gets selected.
      const m = groupChildAffine(x, childRect(sh));
      const q = apply(affInverse(m), p);
      for (const c of [...(sh.kind.children ?? [])].reverse()) {
        const cx = c.xfrm;
        if (!cx) continue;
        const cl = apply(affInverse(xfrmAffine(cx)), q);
        if (cl.x >= -tol && cl.y >= -tol && cl.x <= cx.w + tol && cl.y <= cx.h + tol) return {kind: 'shape', id: sh.id, text: false};
      }
      return null;
    }
    if (k === 'ink') {
      for (const s of sh.kind.strokes ?? []) {
        if ((s.points ?? []).some(([px, py]) => hypot(sub(pt(px, py), p)) <= tol + (s.width ?? 0))) return {kind: 'shape', id: sh.id, text: false};
      }
      return null;
    }
    if (isLine(sh)) {
      const geo = shapeGeometry(sh, x.w, x.h);
      const lw = sh.line?.width ?? 1;
      return nearPath(outline(geo), local, Math.max(tol, lw)) ? {kind: 'shape', id: sh.id, text: false} : null;
    }
    if (k === 'table') {
      // The table as drawn (its rows may have grown): its borders resize rows and columns.
      const fr = this.tableFrame(sh.id);
      if (fr) {
        const q = fr.local(p);
        if (q.x < -tol || q.y < -tol || q.x > fr.width + tol || q.y > fr.height + tol) return null;
        const b = fr.borderAt(q, tol);
        if (b) return b.column !== undefined ? {kind: 'tableColumn', id: sh.id, col: b.column} : {kind: 'tableRow', id: sh.id, row: b.row};
        return {kind: 'shape', id: sh.id, text: false};
      }
    }
    const inside = local.x >= -tol && local.y >= -tol && local.x <= x.w + tol && local.y <= x.h + tol;
    if (!inside) return null;
    const isShape = k === 'shape';
    const hasText = isShape && ((!!sh.text && bodyLen(sh.text) > 0) || !!sh.ph || !!sh.textBox);
    // Empty interiors of unfilled, text-less shapes don't catch clicks.
    const filled = sh.fill?.kind !== 'none' || !!sh.style;
    const geo = shapeGeometry(sh, x.w, x.h);
    const out = outline(geo);
    const inGeo = winding(out, local) !== 0 || nearPath(out, local, tol);
    if (hasText || sh.ph || ['picture', 'table', 'chart', 'media', 'model3d', 'opaque'].includes(k) || (filled && inGeo) || nearPath(out, local, tol)) {
      return {kind: 'shape', id: sh.id, text: hasText || isShape};
    }
    return null;
  }

  /** The topmost text-holding member of group `sh` under `p` (nested groups included). */
  textMemberAt(sh, p, tol) {
    if (!isGroup(sh)) return null;
    const rec = (children, toAbs, depth) => {
      if (depth > 64) return null;
      const q = apply(affInverse(toAbs), p);
      for (const c of [...children].reverse()) {
        const cx = c.xfrm;
        if (!cx) continue;
        const local = apply(affInverse(xfrmAffine(cx)), q);
        if (local.x < -tol || local.y < -tol || local.x > cx.w + tol || local.y > cx.h + tol) continue;
        if (isGroup(c)) {
          const id = rec(c.kind.children ?? [], affChain(toAbs, groupChildAffine(cx, childRect(c))), depth + 1);
          if (id) return id;
        } else if ((c.kind?.type === 'shape' || c.kind?.type === 'connector') && !isLine(c)) return c.id;
      }
      return null;
    };
    return rec(sh.kind.children ?? [], groupChildAffine(this.xf(sh), childRect(sh)), 0);
  }

  /** Shape-local → slide affine of any shape on the slide, through the groups that hold it. */
  shapeAffine(id) {
    const sl = this.slide();
    const chain = shapeChain(sl, id);
    if (!chain) return null;
    let m = IDENTITY;
    let list = sl.shapes;
    let sh = null;
    for (let k = 0; k < chain.length; k++) {
      sh = list.find(s => s.id === chain[k]);
      if (!sh) return null;
      const x = k === 0 ? this.xf(sh) : sh.xfrm ?? {x: 0, y: 0, w: 0, h: 0};
      if (k === chain.length - 1) return {m: affChain(m, xfrmAffine(x)), x, sh};
      m = affChain(m, groupChildAffine(x, childRect(sh)));
      list = sh.kind?.children ?? [];
    }
    return null;
  }

  /** deckcraft `table_frame`: table `id` as drawn (cell rectangles, rows grown to their text) with its table-local to slide transform; null for a non-table. */
  tableFrame(id) {
    const f = this.shapeAffine(id);
    const sh = f?.sh;
    if (!f || sh.kind?.type !== 'table') return null;
    const rc = ctxForSlide(this.content, this.slide());
    if (!rc) return null;
    const fr = makeTableFrame(sh.kind, drawnHeights(rc, sh), q => apply(f.m, q), q => apply(affInverse(f.m), q));
    fr.m = f.m;
    return fr;
  }

  /** The text position under slide point `p` in cell `cell` of table `id` (deckcraft `text_pos_at` with a cell). */
  textPosInCell(id, cell, p) {
    const fr = this.tableFrame(id);
    const sh = this.shape(id);
    const rc = ctxForSlide(this.content, this.slide());
    const r = fr?.cellRect(cell[0], cell[1]);
    const cellObj = sh?.kind?.rows?.[cell[0]]?.cells?.[cell[1]];
    if (!fr || !r || !cellObj || !rc) return [0, 0];
    const body = tableCellBody(rc, sh.kind, cell[0], cell[1], cellObj, tableStyleOf(rc, sh.kind));
    const lay = body.paragraphs?.length ? body : {...body, paragraphs: [{level: 0, runs: []}]};
    const rect = {x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1};
    const l = layoutText(rc, tableCellShape(sh, lay), lay, {rect, measure: this.measure ?? undefined, metrics: this.metrics ?? undefined});
    const c = rectCenter(rect);
    const q0 = fr.local(p);
    const q = l.rotation ? apply(affInverse(affChain(affTranslate(c), affRotate(rad(l.rotation)), affTranslate(mul(c, -1)))), q0) : q0;
    return hitText(l, q.x, q.y);
  }

  /** deckcraft `text_frame` + `text_pos_at`: the text position under slide point `p` in shape `id`'s text. */
  textPosAt(id, p) {
    const f = this.shapeAffine(id);
    if (!f) return [0, 0];
    const {m, x, sh} = f;
    const geo = shapeGeometry(sh, x.w, x.h);
    const body = sh.text && (sh.text.paragraphs ?? []).length ? sh.text : {...(sh.text ?? {body: {}}), paragraphs: [{level: 0, runs: []}]};
    const ctx = ctxForSlide(this.content, this.slide());
    if (!ctx) return [0, 0];
    const l = layoutText(ctx, sh, body, {rect: geo.textRect, measure: this.measure ?? undefined, metrics: this.metrics ?? undefined});
    const tr = geo.textRect;
    const c = rectCenter(tr);
    // deckcraft render `text_transform`: vertical text turns about the text rectangle's centre.
    const tm = l.rotation ? affChain(m, affTranslate(c), affRotate(rad(l.rotation)), affTranslate(mul(c, -1))) : m;
    const q = apply(affInverse(tm), p);
    return hitText(l, q.x, q.y);
  }

  // ---- the pointer ------------------------------------------------------------------------------

  /** Feed a pointer event `{kind, x, y, mods:{shift,alt,cmd}, tol, pressure}` to the active tool. Returns what happened. */
  pointer(ev) {
    const tol = ev.tol > 0 ? ev.tol : 4;
    const p = pt(ev.x, ev.y);
    const mods = {shift: !!ev.mods?.shift, alt: !!ev.mods?.alt, cmd: !!ev.mods?.cmd};
    this.tool.pressure = Number.isFinite(ev.pressure) ? Math.min(Math.max(ev.pressure, 0), 1) : null;
    if (!(Number.isFinite(p.x) && Number.isFinite(p.y)) || !this.slide()) return null;
    switch (ev.kind) {
      case 'move': {
        const d = this.tool.drag;
        if (d?.kind === 'freeform') {
          const closing = d.points.length > 2 && hypot(sub(d.points[0], p)) <= tol * 2;
          this.tool.pathPreview = [...d.points, p];
          this.tool.pathSmooth = d.mode === 'curve';
          this.tool.pathClosing = closing;
          return null;
        }
        this.tool.hover = this.hitTest(p, tol);
        { const ep = this.editingPoints(); this.tool.hoverSegment = ep && !this.tool.hover ? pts.segmentAt(ep, this.xf(ep), p, tol * 1.6) : null; }
        this.tool.guideHover = !this.tool.hover && this.tool.kind.kind === 'select' ? this.guideAt(p, tol) : null;
        const lineTool = this.tool.kind.kind === 'shape' && isLineLike(this.tool.kind.preset);
        if (lineTool) this.updateSites(p, tol, null);
        else { this.tool.sites = []; this.tool.glue = null; }
        return null;
      }
      case 'down': return this.down(p, mods, tol);
      case 'drag': return this.drag(p, mods, tol);
      case 'up': return this.up(p, mods);
      case 'doubleClick': {
        const before = this.textTarget();
        const r = this.doubleClick(p, tol);
        return this.paintIfSelectionChanged(before, r);
      }
      case 'contextClick': return this.contextClick(p, tol);
      case 'tripleClick': {
        if (!this.sel.text) return null;
        const before = this.textTarget();
        const r = this.exec('text.selectParagraph', {});
        return this.paintIfSelectionChanged(before, r);
      }
      default: return null;
    }
  }

  /** The shape in Edit Points, while it is still the one selected shape and a freeform. */
  editingPoints() {
    const e = this.tool.editPoints;
    if (!e || this.sel.text || this.sel.shapes.length !== 1 || String(this.sel.shapes[0]) !== String(e.id)) return null;
    const sh = this.shapes().find(x => x.id === e.id);
    return sh?.geom?.kind === 'custom' ? sh : null;
  }

  textTarget() { const t = this.sel.text; return t ? JSON.stringify([t.shape, t.cell, t.notes, t.anchor, t.caret]) : null; }
  /** Format Painter applies once a text range is selected (drag, word or paragraph click). */
  paintTextSelection() {
    const t = this.sel.text;
    if (this.view.painter && t && (t.anchor[0] !== t.caret[0] || t.anchor[1] !== t.caret[1])) return this.exec('format.painterApply', {});
    return null;
  }
  paintIfSelectionChanged(before, r) {
    if (this.textTarget() === before) return r;
    return this.paintTextSelection() ?? r;
  }

  down(p, mods, tol) {
    const d0 = this.tool.drag;
    if (d0?.kind === 'freeform') {
      // Next click of a freeform: close on the start point, else add a vertex.
      if (d0.points.length > 2 && hypot(sub(d0.points[0], p)) <= tol * 2) {
        this.tool.drag = {...d0, pressed: false};
        return this.finishFreeform(true);
      }
      const points = [...d0.points, p];
      this.tool.pathPreview = points.slice();
      this.tool.drag = {kind: 'freeform', mode: d0.mode, points, pressed: true};
      return null;
    }
    const kind = this.tool.kind;
    if (kind.kind === 'shape' && isFreeformTool(kind.preset)) {
      this.tool.drag = {kind: 'freeform', mode: kind.preset, points: [p], pressed: true};
      this.tool.pathPreview = [p];
      this.tool.pathSmooth = kind.preset === 'curve';
      this.tool.pathClosing = false;
      return null;
    }
    if (kind.kind === 'shape' && kind.preset === TABLE_ERASER) {
      // Click a border to merge the cells on either side; elsewhere does nothing.
      return this.tryExec('table.eraseLine', {at: [p.x, p.y], tol: Math.max(tol, 4)});
    }
    // The Eyedropper (and Set Transparent Color): the click asks the surface for the colour of the slide as drawn under it.
    if (kind.kind === 'eyedropper') { this.uiRequests.push({pickColor: {target: kind.target, x: p.x, y: p.y}}); return null; }
    if (kind.kind === 'lasso') {
      // Draw Lasso Select: a loop drawn freehand; what is inside it is selected on release.
      this.tool.drag = {kind: 'lasso', points: [p]};
      this.tool.pathPreview = [p];
      return null;
    }
    if (kind.kind === 'shape' || kind.kind === 'textBox') {
      this.tool.drag = {kind: 'create', start: p};
      this.tool.preview = {x: p.x, y: p.y, w: 0, h: 0};
      return null;
    }
    if (kind.kind === 'ink') {
      if (kind.mode === 'eraser') return this.eraseAt(p, tol);
      // The Draw tab's Ruler: ink started on its edge runs straight along it.
      const snap = rulerSnap(this.view, p);
      const sample = this.inkSample(snap ? snap(p) : p);
      this.tool.drag = {kind: 'ink', points: [sample], ...(snap ? {ruler: true} : {})};
      this.tool.inkPreview = [sample];
      return null;
    }
    // Clicking inside the text being edited moves the caret / starts a text selection.
    const before = this.textTarget();
    const placed = this.placeCaret(p, tol, mods.shift);
    if (placed) {
      this.tool.drag = {kind: 'textSelect', shape: placed[0], before, press: this.sel.text ? {...this.sel.text} : null};
      return {caret: placed[1]};
    }
    const hit = this.hitTest(p, tol);
    // Edit Points: drag a vertex or a handle, Ctrl-click a vertex to delete it or the outline to add one; a click anywhere else leaves Edit Points.
    const ep = this.editingPoints();
    if (ep) {
      if (hit?.kind === 'vertex') {
        if (mods.cmd) return this.exec('shape.deletePoint', {id: hit.id, path: hit.path, index: hit.index});
        this.tool.editPoints = {...this.tool.editPoints, vertex: [hit.path, hit.index], segment: undefined};
        this.begin('Edit Points');
        this.tool.drag = {kind: 'vertex', id: hit.id, path: hit.path, index: hit.index};
        return {vertex: [hit.path, hit.index]};
      }
      if (hit?.kind === 'handle') {
        this.begin('Edit Points');
        this.tool.drag = {kind: 'handle', id: hit.id, path: hit.path, index: hit.index, out: hit.out};
        return {handle: [hit.path, hit.index]};
      }
      const seg = pts.segmentAt(ep, this.xf(ep), p, tol * 1.6);
      if (seg) {
        if (mods.cmd) return this.exec('shape.addPoint', {id: ep.id, path: seg.path, segment: seg.index, t: seg.t});
        return null;
      }
      this.tool.editPoints = null;
    }
    switch (hit?.kind) {
      case 'vertex': case 'handle': break;
      case 'resize': {
        const sh = this.shape(hit.id);
        this.begin('Size');
        this.tool.drag = {kind: 'resize', id: hit.id, handle: hit.handle, orig: sh ? this.xf(sh) : {x: 0, y: 0, w: 0, h: 0}, start: p};
        break;
      }
      case 'lineEnd': {
        const sh = this.shape(hit.id);
        this.begin('Size');
        this.tool.drag = {kind: 'lineEnd', id: hit.id, end: hit.end, orig: sh ? this.xf(sh) : {x: 0, y: 0, w: 0, h: 0}};
        break;
      }
      case 'rotate': {
        const ids = this.sel.shapes.includes(hit.id) ? this.sel.shapes.slice() : [hit.id];
        const origs = ids.map(i => [i, this.shape(i)]).filter(([, s]) => s).map(([i, s]) => [i, this.xf(s)]);
        const own = this.shape(hit.id);
        const ox = own ? this.xf(own) : null;
        const center = ox ? pt(ox.x + ox.w / 2, ox.y + ox.h / 2) : p;
        const start = Math.atan2(p.y - center.y, p.x - center.x);
        this.begin('Rotate');
        this.tool.drag = {kind: 'rotate', ids, center, start, origs};
        break;
      }
      case 'adjust': {
        const sh = this.shape(hit.id);
        this.begin('Adjust Shape');
        this.tool.drag = {kind: 'adjust', id: hit.id, index: hit.index, orig: sh ? this.xf(sh) : {x: 0, y: 0, w: 0, h: 0}};
        break;
      }
      case 'frame': {
        // Like PowerPoint: the box leaves text editing and is selected whole (a click without a
        // drag stops there), and dragging moves it as one undo step.
        const sh = this.shape(hit.id);
        const origs = sh ? [[hit.id, this.xf(sh)]] : [];
        this.select(s => { s.shapes = [hit.id]; s.text = null; s.cells = null; });
        this.tool.drag = {kind: 'move', ids: [hit.id], start: p, origs, moved: false, duplicate: mods.alt, enterText: null};
        break;
      }
      case 'tableColumn':
      case 'tableRow': this.beginTableBorder(hit, p); break;
      case 'shape': {
        const id = hit.id;
        const selected = this.sel.shapes.includes(id);
        const toggle = mods.shift || mods.cmd;
        const isTable = this.shape(id)?.kind?.type === 'table';
        if (isTable && !toggle && this.sel.cells?.shape === id) {
          // A press in a table whose cells are selected starts again in the cell under the pointer: a click puts the caret there and a
          // drag selects another range. A press on the table outside its cells selects and moves the table like any shape.
          const fr0 = this.tableFrame(id);
          if (fr0?.inCell(fr0.local(p))) {
            const before0 = this.textTarget();
            if (this.editTextAt(id, p)) {
              this.select(s => { s.cells = null; });
              this.tool.drag = {kind: 'textSelect', shape: id, before: before0, press: this.sel.text ? {...this.sel.text} : null};
              break;
            }
          }
        }
        let ids;
        if (toggle) ids = selected ? this.sel.shapes.filter(x => x !== id) : [...this.sel.shapes, id];
        else ids = selected ? this.sel.shapes.slice() : [id];
        // Locked objects stay put when the selection is dragged.
        const origs = ids.map(i => [i, this.shape(i)]).filter(([, s]) => s && !s.locked).map(([i, s]) => [i, this.xf(s)]);
        // A click (no drag) on text puts the caret there; unselected text boxes and placeholders
        // take the caret straight away like PowerPoint. A click on the frame band of a text box
        // selects the box whole, so it can be moved, duplicated or deleted.
        const sh = this.shape(id);
        const onFrame = hit.text && this.isTextFirst(id) && !!sh && editZone(this.xf(sh), p, tol) === 'frame';
        const inCell = isTable && selected && (() => { const fr1 = this.tableFrame(id); return !!fr1 && fr1.inCell(fr1.local(p)); })();
        const enterText = !toggle && !onFrame && ((hit.text && (selected || this.isTextFirst(id))) || inCell) ? [id, p] : null;
        this.select(s => { s.shapes = ids.slice(); s.text = null; s.cells = null; });
        const duplicate = mods.alt && origs.length === ids.length;
        this.tool.drag = {kind: 'move', ids, start: p, origs, moved: false, duplicate, enterText};
        // Format Painter and Animation Painter apply on click.
        if (this.view.painter && !toggle) this.exec('format.painterApply', {ids: [id]});
        if (this.view.animPainter && !toggle) this.exec('animation.painterApply', {ids: [id]});
        break;
      }
      default: {
        const gi = this.guideAt(p, tol);
        if (gi !== null) {
          // Away from every shape a press on a guide picks the guide up.
          this.tool.drag = {kind: 'guide', index: gi};
          this.tool.guideDrag = [gi, this.content.guides?.[gi]?.pos ?? 0];
          break;
        }
        const add = mods.shift || mods.cmd;
        this.select(s => { s.text = null; s.cells = null; if (!add) s.shapes = []; });
        this.tool.drag = {kind: 'marquee', start: p, add};
        this.tool.marquee = rectFromPoints(p, p);
      }
    }
    return {hit};
  }

  up(p, mods) {
    void mods;
    const drag = this.tool.drag;
    this.tool.drag = null;
    this.tool.guides = [];
    this.tool.sites = [];
    this.tool.glue = null;
    let out = null;
    switch (drag?.kind) {
      case 'guide': {
        // Dropped off the slide: the guide is deleted.
        const [index, pos] = this.tool.guideDrag ?? [drag.index, 0];
        this.tool.guideDrag = null;
        const size = this.size();
        const vertical = !!this.content.guides?.[index]?.vertical;
        const limit = vertical ? size.width : size.height;
        out = pos < 0 || pos > limit ? this.exec('guide.delete', {index}) : this.exec('guide.move', {index, pos});
        break;
      }
      case 'move':
        // Plain click on text: caret at the click.
        if (!drag.moved && drag.enterText && this.editTextAt(drag.enterText[0], drag.enterText[1])) out = {editing: drag.enterText[0]};
        break;
      case 'marquee': {
        const r = rectFromPoints(drag.start, p);
        this.tool.marquee = null;
        if (r.x1 - r.x0 > 1 || r.y1 - r.y0 > 1) {
          const ids = this.shapes().filter(s => !s.hidden && !s.locked && containsRect(r, xfrmBounds(this.xf(s)))).map(s => s.id);
          this.select(s => {
            if (drag.add) { for (const i of ids) if (!s.shapes.includes(i)) s.shapes.push(i); }
            else s.shapes = ids.slice();
          });
          out = {selected: ids};
        }
        break;
      }
      case 'create': out = this.finishCreate(drag.start, p); break;
      case 'lasso': {
        this.tool.pathPreview = [];
        out = this.finishLasso([...drag.points, p]);
        break;
      }
      case 'freeform': {
        if (drag.mode === 'scribble') {
          // A scribble ending back at its start closes into a filled shape.
          const pts = drag.points;
          const closed = pts.length > 3 && hypot(sub(pts[0], pts[pts.length - 1])) <= 6;
          this.tool.drag = {...drag, pressed: false};
          return this.finishFreeform(closed);
        }
        // Polygon / curve: keep going until double-click, Enter or a click on the start.
        this.tool.drag = {...drag, pressed: false};
        return null;
      }
      case 'ink':
        this.tool.inkPreview = [];
        if (drag.points.length > 1) { this.begin('Ink'); out = this.addInk(drag.points); }
        break;
      case 'textSelect':
        out = this.paintIfSelectionChanged(drag.before, out);
        break;
      default: break;
    }
    // Any open interaction (move etc.) ends here.
    this.commit();
    return out;
  }

  finishCreate(start, p) {
    const kind = this.tool.kind;
    const preview = this.tool.preview;
    this.tool.preview = null;
    const dragged = hypot(sub(p, start)) > 2;
    let res = null;
    if (kind.kind === 'shape' && kind.preset === DRAW_TABLE) {
      // Inside a table: split cells along the line (table.drawLine decides). Elsewhere: a one-cell table.
      const inTable = this.shapes().some(s => s.kind?.type === 'table' && !s.hidden && containsRect(xfrmBounds(this.xf(s)), rectFromPoints(start, start)));
      if (inTable) res = this.tryExec('table.drawLine', {from: [start.x, start.y], to: [p.x, p.y]});
      else if (preview && dragged && preview.w >= 8 && preview.h >= 8) res = this.exec('insert.table', {rows: 1, cols: 1, rect: [preview.x, preview.y, preview.w, preview.h]});
    } else if (kind.kind === 'shape') {
      const line = isLineLike(kind.preset);
      const rect = preview && dragged ? preview : line ? {x: start.x, y: start.y, w: 72, h: 0} : {x: start.x, y: start.y, w: 72, h: 72};
      res = this.exec('shape.insert', {preset: kind.preset, rect: [rect.x, rect.y, rect.w, rect.h], flip: `${rect.flipH ? 'h' : ''}${rect.flipV ? 'v' : ''}`});
      const id = res && (typeof res.id === 'string' || typeof res.id === 'number') ? String(res.id) : null;
      if (id && preview && dragged && line) {
        this.setXfrmCmd(id, preview);
        // Glue the ends that landed on connection sites.
        const [p0, p1] = endpoints(preview);
        const g0 = this.glueAt(p0, 4), g1 = this.glueAt(p1, 4);
        if (g0 || g1) {
          this.edit(list => { setGlue(list, id, 0, g0 ? [g0[0], g0[1]] : null); setGlue(list, id, 1, g1 ? [g1[0], g1[1]] : null); return list; });
        }
      }
    } else if (kind.kind === 'textBox') {
      const w = preview && dragged ? preview.w : 0;
      const at = preview && dragged ? pt(preview.x, preview.y) : start;
      res = this.exec('insert.textBox', {rect: [at.x, at.y, w, 30]});
    }
    // The table pencil stays on until you pick another tool, as in PowerPoint.
    if (!this.tool.sticky && !(kind.kind === 'shape' && kind.preset === DRAW_TABLE)) this.tool.kind = {kind: 'select'};
    return res;
  }

  drag(p, mods, tol) {
    const drag = this.tool.drag;
    if (!drag) return null;
    switch (drag.kind) {
      case 'guide': {
        const vertical = !!this.content.guides?.[drag.index]?.vertical;
        let pos = vertical ? p.x : p.y;
        // Guides move in whole points unless snapping is off, as in PowerPoint.
        if (this.prefs.snapToGrid && !mods.alt) pos = Math.round(pos);
        this.tool.guideDrag = [drag.index, pos];
        break;
      }
      case 'move': return this.dragMove(drag, p, mods, tol);
      case 'resize': {
        const nx0 = resizeBox(drag.orig, drag.handle, sub(p, drag.start), mods.shift || this.isPicture(drag.id), mods.alt);
        const nx = this.snapResize(nx0, drag.handle, drag.id, tol);
        this.setXfrm(drag.id, nx);
        break;
      }
      case 'lineEnd': {
        const a = xfrmAffine(drag.orig);
        const p0 = apply(a, pt(0, 0)), p1 = apply(a, pt(drag.orig.w, drag.orig.h));
        let q = p;
        const other = drag.end === 0 ? p1 : p0;
        if (mods.shift) q = constrain45(other, q);
        const glue = this.updateSites(q, tol, drag.id);
        if (glue) q = glue[2];
        const [s0, s1] = drag.end === 0 ? [q, p1] : [p0, q];
        this.setXfrm(drag.id, lineXfrm(s0, s1));
        this.edit(list => { setGlue(list, drag.id, drag.end, glue ? [glue[0], glue[1]] : null); return list; });
        break;
      }
      case 'rotate': {
        const ang = Math.atan2(p.y - drag.center.y, p.x - drag.center.x);
        let delta = ((ang - drag.start) * 180) / Math.PI;
        for (const [id, o] of drag.origs) {
          let r = (o.rot ?? 0) + delta;
          if (mods.shift) { r = Math.round(r / 15) * 15; delta = r - (o.rot ?? 0); }
          const nx = {...o, rot: ((r % 360) + 360) % 360};
          if (drag.ids.length > 1) {
            // Rotate positions around the common centre too.
            const c = pt(o.x + o.w / 2, o.y + o.h / 2);
            const rc = apply(affChain(affTranslate(drag.center), affRotate(rad(delta)), affTranslate(mul(drag.center, -1))), c);
            nx.x = rc.x - o.w / 2;
            nx.y = rc.y - o.h / 2;
          }
          if (!nx.rot) delete nx.rot;
          this.setXfrm(id, nx);
        }
        break;
      }
      case 'vertex': this.setShape(drag.id, sh => pts.movedVertex(sh, drag.path, drag.index, p)); break;
      case 'handle': this.setShape(drag.id, sh => pts.movedHandle(sh, drag.path, drag.index, drag.out, p, this.tool.editPoints?.kind)); break;
      case 'adjust': return this.dragAdjust(drag.id, drag.index, drag.orig, p);
      case 'marquee': this.tool.marquee = rectFromPoints(drag.start, p); break;
      case 'create': this.dragCreate(drag.start, p, mods, tol); break;
      case 'lasso': {
        const last = drag.points[drag.points.length - 1];
        if (hypot(sub(last, p)) < 1.5) break;
        const points = [...drag.points, p];
        this.tool.pathPreview = points.slice();
        this.tool.drag = {...drag, points};
        break;
      }
      case 'textSelect': return this.dragTextSelect(drag, p);
      case 'tableBorder': {
        const local = apply(affInverse(drag.m), p);
        const d = drag.column ? local.x - drag.start.x : local.y - drag.start.y;
        if (!drag.moved && Math.abs(d) < Math.max(tol, 1)) return null;
        if (!drag.moved) this.begin(drag.column ? 'Column Width' : 'Row Height');
        // An inner column border moves between its two columns (the table keeps its width); the right edge widens the last column and
        // the table. A row's height is a minimum: rows still grow to fit their text.
        if (drag.column) this.tryExec('table.columnWidth', {id: drag.id, col: drag.index, width: Math.max(drag.size + d, MIN_COLUMN_WIDTH), keepTotal: true});
        else this.tryExec('table.rowHeight', {id: drag.id, row: drag.index, height: Math.max(drag.size + d, 1)});
        this.tool.drag = {...drag, moved: true};
        break;
      }
      case 'freeform': {
        // Dragging scribbles (except for curves, which only take clicked points).
        const points = drag.points.slice();
        if (drag.pressed && drag.mode !== 'curve' && (!points.length || hypot(sub(points[points.length - 1], p)) >= 1.5)) points.push(p);
        this.tool.pathPreview = drag.mode === 'curve' ? [...points, p] : points.slice();
        this.tool.drag = {...drag, points};
        break;
      }
      case 'ink': {
        const along = drag.ruler ? rulerSnap(this.view, p, true) : null;
        const points = [...drag.points, this.inkSample(along ? along(p) : p)];
        this.tool.inkPreview = points;
        this.tool.drag = {kind: 'ink', points, ...(drag.ruler ? {ruler: true} : {})};
        break;
      }
      default: break;
    }
    return null;
  }

  dragMove(drag, p, mods, tol) {
    const {ids, start, origs, moved, duplicate, enterText} = drag;
    let d = sub(p, start);
    if (!moved && (hypot(d) < Math.max(tol, 1) || !origs.length)) return null;
    if (!moved) {
      this.begin(duplicate ? 'Duplicate' : 'Move');
      // Alt-drag: drag a copy, leave the original.
      if (duplicate) this.dupInPlace(ids);
    }
    const idsNow = duplicate ? this.sel.shapes.slice() : ids;
    if (mods.shift) { if (Math.abs(d.x) > Math.abs(d.y)) d = pt(d.x, 0); else d = pt(0, d.y); }
    // Smart guides on the moved group's bounds.
    const bounds = origs.map(([, x]) => xfrmBounds(x)).reduce((a, b) => rectUnion(a, b));
    const movedB = rectTranslate(bounds, d);
    const [snapOff, guides] = this.snapEdges(movedB, idsNow, tol * 1.5, !mods.cmd, [true, true, true], [true, true, true]);
    d = add(d, snapOff);
    this.tool.guides = guides;
    const origs2 = duplicate ? idsNow.map((id, i) => [id, origs[i]?.[1]]).filter(([, o]) => o) : origs;
    const movedIds = origs2.map(o => o[0]);
    this.edit(list => {
      let out = list;
      for (const [id, o] of origs2) out = updateShape(out, id, sh => ({...sh, xfrm: {...o, x: o.x + d.x, y: o.y + d.y}}));
      // A connector dragged away from shapes that stay put comes unglued at those ends.
      return out.map(sh => {
        if (!movedIds.includes(sh.id) || sh.kind?.type !== 'connector') return sh;
        const kind = {...sh.kind};
        let changed = false;
        for (const end of ['start', 'end']) if (kind[end] && !movedIds.includes(kind[end][0])) { kind[end] = null; changed = true; }
        return changed ? {...sh, kind} : sh;
      });
    });
    this.tool.drag = {kind: 'move', ids: idsNow, start, origs: origs2, moved: true, duplicate: false, enterText: null};
    void enterText;
    return null;
  }

  dragAdjust(id, index, orig, p) {
    const sh = this.shape(id);
    if (!sh || sh.geom?.kind === 'custom') return null;
    const local = apply(affInverse(xfrmAffine(orig)), p);
    const geo = shapeGeometry(sh, orig.w, orig.h);
    const h = (geo.handles ?? []).find(x => x.index === index);
    if (!h) return null;
    const name = presetName(sh.geom) ?? '';
    const free2d = name.includes('Callout') && !name.includes('Arrow');
    const vals = free2d
      ? [[0, Math.round(((local.x - orig.w / 2) / Math.max(orig.w, 1e-6)) * 1e5)], [1, Math.round(((local.y - orig.h / 2) / Math.max(orig.h, 1e-6)) * 1e5)]]
      : [[index, handleValueAt(h, local)]];
    this.setShape(id, s => {
      const g = s.geom ?? {kind: 'preset', name: 'rect'};
      const adj = (g.adj ?? []).slice();
      const defaults = presetInfo(g.name)?.defaults ?? [];
      for (const [i, v] of vals) {
        while (adj.length <= i) adj.push(defaults[adj.length] ?? 0);
        adj[i] = v;
      }
      return {...s, geom: {...g, adj}};
    });
    return null;
  }

  dragCreate(start, p, mods, tol) {
    const kind = this.tool.kind;
    const line = kind.kind === 'shape' && isLineLike(kind.preset);
    let x;
    if (line) {
      let q = mods.shift ? constrain45(start, p) : p;
      const g = this.updateSites(q, tol, null);
      if (g) q = g[2];
      const s0 = this.glueAt(start, tol)?.[2] ?? start;
      x = lineXfrm(s0, q);
    } else if (kind.kind === 'shape' && kind.preset === DRAW_TABLE
      && this.shapes().some(s => s.kind?.type === 'table' && containsRect(xfrmBounds(this.xf(s)), rectFromPoints(start, start)))) {
      // The pencil inside a table draws a straight border, across or down.
      const q = Math.abs(p.x - start.x) >= Math.abs(p.y - start.y) ? pt(p.x, start.y) : pt(start.x, p.y);
      const r = rectFromPoints(start, q);
      x = {x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0};
    } else {
      let r = rectFromPoints(start, p);
      if (mods.shift) {
        const s = Math.max(r.x1 - r.x0, r.y1 - r.y0);
        r = rectFromPoints(start, add(start, pt(p.x < start.x ? -s : s, p.y < start.y ? -s : s)));
      }
      if (mods.alt) {
        const d = sub(p, start);
        r = {x0: start.x - Math.abs(d.x), y0: start.y - Math.abs(d.y), x1: start.x + Math.abs(d.x), y1: start.y + Math.abs(d.y)};
      }
      x = {x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0};
    }
    this.tool.preview = x;
  }

  dragTextSelect(drag, p) {
    const shape = drag.shape, press = drag.press;
    // In a table, leaving the cell the drag started in selects whole cells, as in PowerPoint; coming back to that cell selects text in it again.
    if (press?.cell) {
      const fr = this.tableFrame(shape);
      const cell = fr?.cellAt(fr.local(p));
      if (cell) {
        if (cell[0] !== press.cell[0] || cell[1] !== press.cell[1]) {
          this.select(s => { s.text = null; s.shapes = [shape]; s.cells = {shape, from: press.cell, to: cell}; });
          return null;
        }
        if (!this.sel.text) this.select(s => { s.cells = null; s.text = {...press}; });
      }
    }
    const t = this.sel.text;
    if (t && t.shape === shape && !t.notes) {
      const pos = t.cell ? this.textPosInCell(shape, t.cell, p) : this.textPosAt(shape, p);
      this.select(s => { if (s.text) s.text = {...s.text, caret: pos}; });
    }
    return null;
  }

  /**
   * Draw > Lasso Select (PowerPoint's; not in deckcraft, not checked against upstream): the loop's inside selects the visible, unlocked
   * objects whose centre is in it, and an ink stroke with a point in it. A loop around nothing selects nothing.
   */
  finishLasso(points) {
    if (points.length < 3) return null;
    const inside = q => {
      let c = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    };
    const ids = this.shapes().filter(sh => {
      if (sh.hidden || sh.locked) return false;
      const x = this.xf(sh);
      if (sh.kind?.type === 'ink') {
        const m = xfrmAffine(x);
        return (sh.kind.strokes ?? []).some(st => (st.points ?? []).some(([px, py]) => inside(apply(m, pt(px, py)))));
      }
      return inside(apply(xfrmAffine(x), pt(x.w / 2, x.h / 2)));
    }).map(sh => sh.id);
    this.select(s => { s.text = null; s.cells = null; s.shapes = ids; });
    return {selected: ids};
  }

  /** Press on a table border: dragging it resizes the column or row. Editing a cell of the table goes on; otherwise the table becomes the selection. */
  beginTableBorder(hit, p) {
    const fr = this.tableFrame(hit.id);
    if (!fr) return;
    const column = hit.kind === 'tableColumn';
    const index = column ? hit.col : hit.row;
    const size = (column ? fr.cols[index] : fr.heights[index]) ?? 0;
    if (!(this.sel.text && this.sel.text.shape === hit.id)) this.select(s => { s.shapes = [hit.id]; s.text = null; s.cells = null; });
    this.tool.drag = {kind: 'tableBorder', id: hit.id, column, index, start: fr.local(p), size, m: fr.m, moved: false};
  }

  doubleClick(p, tol) {
    const d = this.tool.drag;
    if (d?.kind === 'freeform') {
      // The double-click's own click added a duplicate vertex.
      const points = d.points.slice();
      while (points.length > 2 && hypot(sub(points[points.length - 1], points[points.length - 2])) <= tol) points.pop();
      this.tool.drag = {kind: 'freeform', mode: d.mode, points, pressed: false};
      return this.finishFreeform(false);
    }
    if (this.tool.kind.kind !== 'select') {
      // Double-click while drawing: lock drawing mode off.
      this.tool.sticky = false;
      return null;
    }
    // The double-click's second press started a click (caret on release): this replaces it.
    if (d?.kind === 'move' && !d.moved) this.tool.drag = null;
    // In the text being edited: select the word double-clicked.
    if (this.placeCaret(p, tol, false)) return this.exec('text.selectWord', {});
    const hit = this.hitTest(p, tol);
    if (hit?.kind !== 'shape') return null;
    const sh = this.shape(hit.id);
    if (!sh) return null;
    const k = sh.kind?.type;
    if ((k === 'table' || k === 'shape' || k === 'connector') && !isLine(sh)) {
      // Caret at the double-click, then select the word there.
      if (!this.editTextAt(hit.id, p)) return null;
      return this.exec('text.selectWord', {});
    }
    if (k === 'group') {
      // A group is a single selection unit, but its text stays editable: double-click reaches the
      // text-holding member under the cursor.
      const mid = this.textMemberAt(sh, p, tol);
      const m = mid ? this.shape(mid) : null;
      if (!m || isLine(m)) return null;
      const pos = this.textPosAt(mid, p);
      if (this.exec('text.edit', {id: mid, at: pos}) === null) return null;
      return this.exec('text.selectWord', {});
    }
    this.uiRequests.push({pane: 'format'});
    return null;
  }

  /**
   * Right-button press: the selection the context menu will act on, as in PowerPoint. Never edits
   * text, starts a drag or adds an undo step.
   */
  contextClick(p, tol) {
    if (this.tool.kind.kind !== 'select' || this.tool.drag) return null;
    const t = this.sel.text;
    if (t && !t.notes && !t.cell) {
      const sh = this.shape(t.shape);
      if (sh) {
        const b = rectInset(xfrmBounds(this.xf(sh)), tol);
        if (p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) return {hit: {kind: 'text', id: t.shape}, selected: [t.shape], editing: true};
      }
    }
    const hit = this.hitTest(p, tol);
    // Right-clicking in Edit Points picks the vertex or the segment for its menu.
    const ep = this.editingPoints();
    if (ep) {
      if (hit?.kind === 'vertex') { this.tool.editPoints = {...this.tool.editPoints, vertex: [hit.path, hit.index], segment: undefined}; return {hit, selected: this.sel.shapes.slice(), editing: false}; }
      const seg = pts.segmentAt(ep, this.xf(ep), p, tol * 1.6);
      if (seg) { this.tool.editPoints = {...this.tool.editPoints, vertex: null, segment: [seg.path, seg.index, seg.t]}; return {hit: {kind: 'segment', id: ep.id, ...seg}, selected: this.sel.shapes.slice(), editing: false}; }
    }
    const id = hit?.id ?? null;
    if (!(id && this.sel.shapes.includes(id))) this.select(s => { s.text = null; s.shapes = id ? [id] : []; });
    return {hit, selected: this.sel.shapes.slice(), editing: !!this.sel.text};
  }

  /**
   * A click at `p` inside the text being edited: the caret goes there (`extend`: the selection grows
   * to it). Returns [shapeId, caret] or null when `p` isn't in the edited text (or is on a handle).
   */
  placeCaret(p, tol, extend) {
    const t = this.sel.text;
    if (!t || t.notes) return null;
    const sh = this.shape(t.shape);
    if (!sh) return null;
    if (t.cell) {
      // A table cell: anywhere over the table, short of a handle or a border; a click in another cell moves the caret there.
      const fr = this.tableFrame(t.shape);
      if (!fr) return null;
      const q = fr.local(p);
      const over = q.x >= -tol && q.y >= -tol && q.x <= fr.width + tol && q.y <= fr.height + tol;
      const h = over && !this.shapeInFront(this.shapes(), t.shape, p, tol, 0) ? this.hitTest(p, tol) : null;
      if (!over || !h || ['resize', 'rotate', 'adjust', 'frame', 'tableColumn', 'tableRow'].includes(h.kind)) return null;
      const cell = fr.cellAt(q) ?? t.cell;
      const pos0 = this.textPosInCell(t.shape, cell, p);
      const same = cell[0] === t.cell[0] && cell[1] === t.cell[1];
      this.select(s => { if (s.text) s.text = {...s.text, cell, caret: pos0, anchor: extend && same ? s.text.anchor : pos0}; });
      return [t.shape, pos0];
    }
    const e = this.editedBox();
    const inside = !!e && editZone(e.xfrm, p, tol) !== 'outside';
    // A shape in front of the edited text takes the click, as in PowerPoint (#931).
    const inFront = this.shapeInFront(this.shapes(), t.shape, p, tol, 0);
    const h = inside && !inFront ? this.hitTest(p, tol) : null;
    if (!inside || inFront || ['resize', 'rotate', 'adjust', 'frame'].includes(h?.kind)) return null;
    const pos = this.textPosAt(t.shape, p);
    this.select(s => { if (s.text) s.text = {...s.text, caret: pos, anchor: extend ? s.text.anchor : pos}; });
    return [t.shape, pos];
  }

  /** Start editing shape `id`'s text with the caret at slide point `p` (text.edit). Returns whether editing started. */
  editTextAt(id, p) {
    const sh = this.shape(id);
    if (!sh) return false;
    if (sh.kind?.type === 'table') {
      const fr = this.tableFrame(id);
      const cell = fr?.cellAt(fr.local(p));
      if (!cell) return false;
      return this.exec('text.edit', {id, cell, at: this.textPosInCell(id, cell, p)}) !== null;
    }
    const pos = this.textPosAt(id, p);
    return this.exec('text.edit', {id, at: pos}) !== null;
  }

  // ---- geometry.rs ---------------------------------------------------------------------------------

  finishFreeform(closed) {
    const d = this.tool.drag;
    this.tool.drag = null;
    if (d?.kind !== 'freeform') return null;
    this.tool.pathPreview = [];
    this.tool.pathClosing = false;
    if (!this.tool.sticky) this.tool.kind = {kind: 'select'};
    if (d.points.length < 2) return null;
    return this.exec('shape.freeform', {points: d.points.map(q => [q.x, q.y]), closed, smooth: d.mode === 'curve'});
  }

  /** The connection site within glue range of `p`: [shapeId, site, point]. */
  glueAt(p, tol) { return nearestSite(this.content, this.slide(), this.shapes(), p, Math.max(tol * 2, 6), null); }

  /** Show the sites of the shape near `p` and return the site an end at `p` would glue to. */
  updateSites(p, tol, exclude) {
    const sl = this.slide();
    const shapes = this.shapes();
    const near = siteShapeAt(this.content, sl, shapes, p, tol * 3, exclude);
    const s = near ? shapes.find(x => x.id === near) : null;
    this.tool.sites = s ? siteList(this.content, sl, s) : [];
    const glue = nearestSite(this.content, sl, shapes, p, Math.max(tol * 2, 6), exclude);
    this.tool.glue = glue ? glue[2] : null;
    return glue;
  }

  /** Set a shape's box; tables resize their columns and rows proportionally. */
  setXfrm(id, x) {
    // Rows scale from their drawn heights: a stored height is only a minimum.
    const drawn = this.tableFrame(id)?.heights;
    this.setShape(id, sh => {
      const out = {...sh, xfrm: x};
      if (sh.kind?.type === 'table') {
        const t = sh.kind;
        const heights = drawn && drawn.length === (t.rows ?? []).length ? drawn.map(h => Math.max(h, 0)) : (t.rows ?? []).map(r => Math.max(r.height ?? 0, 0));
        const tw = Math.max((t.cols ?? []).reduce((a, b) => a + b, 0), 1e-6), th = heights.reduce((a, b) => a + b, 0);
        const kx = x.w / tw;
        const cols = (t.cols ?? []).map(c => c * kx);
        const rows = th > 1e-6 ? t.rows.map((r, i) => ({...r, height: heights[i] * (x.h / th)})) : t.rows;
        out.kind = {...t, cols, rows};
      }
      return out;
    });
  }

  /** shape.setBounds then the flips (lines drawn right-to-left or bottom-to-top). */
  setXfrmCmd(id, x) {
    this.exec('shape.setBounds', {ids: [id], x: x.x, y: x.y, w: x.w, h: x.h});
    if (x.flipH || x.flipV) {
      this.setShape(id, sh => {
        const xx = {...(sh.xfrm ?? x)};
        if (x.flipH) xx.flipH = true; else delete xx.flipH;
        if (x.flipV) xx.flipV = true; else delete xx.flipV;
        return {...sh, xfrm: xx};
      });
    }
  }

  /** Alt-drag: copies of `ids` in place (new ids, no placeholder link), selected. */
  dupInPlace(ids) {
    let next = this.content.nextId;
    const content = this.content;
    const reid = sh => {
      const a = allocId({...content, nextId: next});
      if (!a) throw Object.assign(new Error(NO_ID_SPACE), {code: 'invalid_params'});
      next = a[1];
      const out = {...sh, id: a[0]};
      if (isGroup(sh)) out.kind = {...sh.kind, children: (sh.kind.children ?? []).map(reid)};
      return out;
    };
    const copies = this.shapes().filter(x => ids.includes(x.id)).map(c => ({...reid(c), xfrm: this.xf(c), ph: null}));
    this.edit(list => [...list, ...copies]);
    this.content = {...this.content, nextId: next};
    this.select(s => { s.shapes = copies.map(c => c.id); s.text = null; });
  }

  /** The drawing guide within `tol` of `p` (only while guides are shown). */
  guideAt(p, tol) {
    if (!this.tool.guidesVisible) return null;
    let best = null;
    (this.content.guides ?? []).forEach((g, i) => {
      const d = g.vertical ? Math.abs(p.x - g.pos) : Math.abs(p.y - g.pos);
      if (d <= Math.max(tol, 2) && (!best || d < best[1])) best = [i, d];
    });
    return best ? best[0] : null;
  }

  /**
   * Smart guides: snap rect `r`'s edges/centres (`xsOn` left, centre, right; `ysOn` top, centre,
   * bottom) to the slide, drawing guides and other shapes. Returns [offset, guides to draw].
   */
  snapEdges(r, exclude, tol, enabled, xsOn, ysOn) {
    if (!enabled || !this.prefs.smartGuides || !this.slide()) return [pt(0, 0), []];
    const size = this.size();
    const xs = [[0, {x0: 0, y0: 0, x1: 0, y1: size.height}], [size.width / 2, {x0: size.width / 2, y0: 0, x1: size.width / 2, y1: size.height}],
      [size.width, {x0: size.width, y0: 0, x1: size.width, y1: size.height}]];
    const ys = [[0, {x0: 0, y0: 0, x1: size.width, y1: 0}], [size.height / 2, {x0: 0, y0: size.height / 2, x1: size.width, y1: size.height / 2}],
      [size.height, {x0: 0, y0: size.height, x1: size.width, y1: size.height}]];
    if (this.tool.guidesVisible) {
      for (const g of this.content.guides ?? []) {
        if (g.vertical) xs.push([g.pos, {x0: g.pos, y0: 0, x1: g.pos, y1: size.height}]);
        else ys.push([g.pos, {x0: 0, y0: g.pos, x1: size.width, y1: g.pos}]);
      }
    }
    for (const sh of this.shapes()) {
      if (exclude.includes(sh.id) || sh.hidden) continue;
      const b = xfrmBounds(this.xf(sh));
      for (const x of [b.x0, (b.x0 + b.x1) / 2, b.x1]) xs.push([x, b]);
      for (const y of [b.y0, (b.y0 + b.y1) / 2, b.y1]) ys.push([y, b]);
    }
    const best = (edges, lines) => {
      let out = null;
      for (const edge of edges) {
        for (const [v, b] of lines) {
          const d = v - edge;
          if (Math.abs(d) <= tol && (!out || Math.abs(d) < Math.abs(out[0]))) out = [d, v, b];
        }
      }
      return out;
    };
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const bx = best([r.x0, cx, r.x1].filter((_, i) => xsOn[i]), xs);
    const by = best([r.y0, cy, r.y1].filter((_, i) => ysOn[i]), ys);
    let ox = 0, oy = 0;
    const guides = [];
    if (bx) {
      ox = bx[0];
      const rr = rectTranslate(r, pt(ox, 0));
      guides.push({vertical: true, pos: bx[1], from: Math.min(bx[2].y0, rr.y0), to: Math.max(bx[2].y1, rr.y1)});
    } else if (this.prefs.snapToGrid && xsOn.includes(true)) {
      const at = xsOn[0] ? r.x0 : xsOn[2] ? r.x1 : cx;
      ox = snapTo(at, this.prefs.gridSpacing) - at;
    }
    if (by) {
      oy = by[0];
      const rr = rectTranslate(r, pt(0, oy));
      guides.push({vertical: false, pos: by[1], from: Math.min(by[2].x0, rr.x0), to: Math.max(by[2].x1, rr.x1)});
    } else if (this.prefs.snapToGrid && ysOn.includes(true)) {
      const at = ysOn[0] ? r.y0 : ysOn[2] ? r.y1 : cy;
      oy = snapTo(at, this.prefs.gridSpacing) - at;
    }
    return [pt(ox, oy), guides];
  }

  /** Snap the edges that resize handle `handle` drags in the resized box `x` to the smart guides. */
  snapResize(x, handle, id, tol) {
    if (x.rot) { this.tool.guides = []; return x; }
    const r = {x0: x.x, y0: x.y, x1: x.x + x.w, y1: x.y + x.h};
    // Only the dragged edges move, so only they look for a line to snap to. In a flipped box the
    // dragged handle is on the other side.
    const left = [0, 6, 7].includes(handle), right = handle >= 2 && handle <= 4;
    const top = handle <= 2, bottom = handle >= 4 && handle <= 6;
    const [ml, mr] = x.flipH ? [right, left] : [left, right];
    const [mt, mb] = x.flipV ? [bottom, top] : [top, bottom];
    const [off, guides] = this.snapEdges(r, [id], tol * 1.5, true, [ml, false, mr], [mt, false, mb]);
    const nx = {...x};
    if (ml) { nx.x += off.x; nx.w -= off.x; } else if (mr) nx.w += off.x;
    if (mt) { nx.y += off.y; nx.h -= off.y; } else if (mb) nx.h += off.y;
    nx.w = Math.max(nx.w, 0);
    nx.h = Math.max(nx.h, 0);
    this.tool.guides = guides;
    return nx;
  }

  isPicture(id) { const k = this.shape(id)?.kind?.type; return k === 'picture' || k === 'media'; }

  /** One ink sample [x, y, pressure]. No device reading is full pen width (1). */
  inkSample(p) { return [p.x, p.y, this.tool.pressure ?? 1]; }

  /** Strokes join the slide's ink layer (one ink shape per slide). */
  addInk(points) {
    const k = this.tool.kind;
    if (k.kind !== 'ink') return null;
    const stroke = {points, color: k.color, width: k.width, highlighter: k.mode === 'highlighter'};
    let id = [...this.shapes()].reverse().find(s => s.kind?.type === 'ink')?.id ?? null;
    if (!id) {
      const a = allocId(this.content);
      if (!a) throw Object.assign(new Error(NO_ID_SPACE), {code: 'invalid_params'});
      id = a[0];
      this.content = {...this.content, nextId: a[1]};
      const size = this.size();
      const ink = {id, name: 'Ink', xfrm: {x: 0, y: 0, w: size.width, h: size.height}, kind: {type: 'ink', strokes: []}, geom: {kind: 'preset', name: 'rect'},
        ph: null, fill: null, line: null, effects: null, style: null, text: null, hidden: false, locked: false, textBox: false, descr: '', title: '',
        decorative: false, click: null, hover: null};
      this.edit(list => [...list, ink]);
    }
    const inkId = id;
    this.setShape(inkId, sh => ({...sh, kind: {...sh.kind, strokes: [...(sh.kind.strokes ?? []), stroke]}}));
    return {ink: inkId};
  }

  eraseAt(p, tol) {
    const ink = [...this.shapes()].reverse().find(s => s.kind?.type === 'ink');
    if (!ink) return null;
    this.begin('Erase');
    this.setShape(ink.id, sh => ({...sh, kind: {...sh.kind,
      strokes: (sh.kind.strokes ?? []).filter(s => !(s.points ?? []).some(([x, y]) => hypot(sub(pt(x, y), p)) <= tol * 2 + (s.width ?? 0)))}}));
    this.commit();
    return null;
  }
}

/** The address a text position would have (for results and tests). */
export const caretAddress = (slideId, chain, body, pos) => textAddress(slideId, chain, offsetOf(body, pos));

/**
 * Run a list of pointer events as one gesture against a kernel command context (the
 * `surface.pointer` command): replays them, writes the changed slide, `nextId` and the selection
 * through the change API, labels the undo entry, and stores the tool state the next gesture needs.
 */
export function runGesture(ctx, {events, tol, measure, metrics}) {
  const base = () => ctx.doc;
  const io = {
    read: () => ({content: ctx.doc, selection: ctx.selection}),
    write(content, selection) {
      const doc = base();
      (content.slides ?? []).forEach((sl, i) => { if (doc.slides[i] !== sl && doc.slides[i]?.id === sl.id) ctx.change.set(['slides', i], sl); });
      // A master view's gestures change the shapes of a master, a layout, the handout or the notes master.
      (content.masters ?? []).forEach((m, mi) => {
        const was = doc.masters?.[mi];
        if (!was || m === was) return;
        if (m.shapes !== was.shapes) ctx.change.set(['masters', mi, 'shapes'], m.shapes);
        (m.layouts ?? []).forEach((l, li) => { if (was.layouts?.[li] && l !== was.layouts[li] && l.shapes !== was.layouts[li].shapes) ctx.change.set(['masters', mi, 'layouts', li, 'shapes'], l.shapes); });
      });
      for (const k of ['handoutMaster', 'notesMaster']) if (content[k] && doc[k] && content[k] !== doc[k] && content[k].shapes !== doc[k].shapes) ctx.change.set([k, 'shapes'], content[k].shapes);
      if (content.nextId !== doc.nextId) ctx.change.set(['nextId'], content.nextId);
      ctx.setSelection(selection);
    },
    run: (id, params) => ctx.run(id, params),
    has: id => !!ctx.registry?.has?.(id),
  };
  const s = new PointerSession({io, view: ctx.view ?? {}, prefs: ctx.prefs, measure, metrics});
  const results = [];
  for (const ev of events) results.push(s.pointer({...ev, tol: ev.tol ?? tol}));
  s.flush();
  const label = s.labels[s.labels.length - 1] ?? null;
  if (label) ctx.setUndoLabel(label);
  const kindBefore = toolFromView(ctx.view);
  const view = {toolDrag: persistDrag(s.tool)};
  const was = ctx.view?.editPoints ?? null, now = s.tool.editPoints;
  if (JSON.stringify(was) !== JSON.stringify(now)) view.editPoints = now;
  if (s.tool.kind.kind !== kindBefore.kind) view.tool = s.tool.kind.kind === 'select' ? null : {...s.tool.kind, sticky: s.tool.sticky};
  else if (!s.tool.sticky && ctx.view?.tool?.sticky) view.tool = {...ctx.view.tool, sticky: false};
  ctx.setView(view);
  return {results, label, deferred: s.deferred, ui: s.uiRequests, selection: ctx.selection};
}
