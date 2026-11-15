// Shape Format: position and size, rotation, flips, geometry, fill, outline, effects, styles,
// names and alt text; connectors, freeforms and Ink to Shape; picture crop, corrections, reset and
// change; media playback options.
// Translated from deckcraft crates/engine/src/cmd/shape.rs, cmd/shape/appearance.rs,
// cmd/shape/size.rs, cmd/shape/freeform.rs and cmd/shape/picture.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Ids, labels, params text and disabled reasons are upstream's. Shape ids are strings (schema 2);
// the bridge may send numbers, as deckcraft's MCP does. `shape.effects` bevel / 3-D (deckcraft
// cmd/three_d.rs keeps them as raw `sp3d`/`scene3d` XML) is core/prism/lib/three-d.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {
  UPSTREAM_COMMIT, bad, hasSlide, hasSelection, num, bool, str, usize, clamp, clampPos, clampSide, MIN_PT, MAX_PT, POS_LIMIT,
  targets, idOf, colorParam, colorValue, gradientParam, editShapes, editGeometry, applyDeep, currentSlide, writeShape, selectIds,
  newId, addMedia, mediaBytes, contentType, pictureAdjustDefault, lineDefault, effectsDefault, quickStyleFor, colorAlphaOf, withAlpha,
  colorScheme, colorRgb, fillSolid, fillNone,
} from '../lib/shape-common.mjs';
import {recognize} from '../lib/shape-inkshape.mjs';
import {shapesGallery} from './tool.mjs';
import {findShape, isLine, isGroup, presetName} from '../model/presentation.mjs';
import {info as presetInfo} from '../model/geom/preset/catalog.mjs';
import {pathD as squirclePathD} from '../model/geom/squircle.mjs';
import {rotNorm} from '../model/geom/index.mjs';
import {colorWith} from '../model/style.mjs';
import {formatAll} from '../model/edit.mjs';
import {ctxForSlide, fill as resolveFill, ctxColor} from '../model/resolve.mjs';
import {slideById, xfrmOf, slidePath} from '../model/doc.mjs';
import {sites as connectionSites, lineXfrm} from '../lib/connect.mjs';
import {parse3d, apply3d, store3d, flat3d} from '../lib/three-d.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: [
  'crates/engine/src/cmd/shape.rs', 'crates/engine/src/cmd/shape/appearance.rs', 'crates/engine/src/cmd/shape/size.rs',
  'crates/engine/src/cmd/shape/freeform.rs', 'crates/engine/src/cmd/shape/picture.rs', 'crates/engine/src/inkshape.rs']};

// ---------------------------------------------------------------------------------------------
// Param schemas (deckcraft params text in each description)

const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})], {description: 'shape id'});
const ids = s.optional(s.array(ID, {max: 5000, description: 'shapes (default: the selection)'}));
const id = s.optional(ID);
const n = d => s.optional(s.number({description: d}));
const b = d => s.optional(s.boolean({description: d}));
const color = d => s.optional(s.any({description: d ?? '#RRGGBB | accent1… | {scheme, lumMod…}'}));

// ---------------------------------------------------------------------------------------------
// Move, size, bounds (shape.rs move_by / resize / set_bounds)

function moveBy(ctx, p) {
  const dx = num(p, 'dx'), dy = num(p, 'dy'), ax = num(p, 'x'), ay = num(p, 'y');
  return editGeometry(ctx, p, 'shape.move', sh => {
    const x = sh.xfrm;
    if (!x) return;
    x.x = clampPos((ax ?? x.x) + (dx ?? 0));
    x.y = clampPos((ay ?? x.y) + (dy ?? 0));
  });
}

function resize(ctx, p) {
  const w = num(p, 'w') !== undefined ? Math.max(p.w, 0) : undefined;
  const h = num(p, 'h') !== undefined ? Math.max(p.h, 0) : undefined;
  const lock = p.lockAspect === true;
  return editGeometry(ctx, p, 'shape.resize', sh => {
    const x = sh.xfrm;
    if (!x) return;
    const ar = x.h > 0 ? x.w / x.h : 1;
    const cx = x.x + x.w / 2, cy = x.y + x.h / 2;
    if (w !== undefined && lock) { x.w = w; x.h = ar > 0 ? w / ar : x.h; }
    else if (w === undefined && h !== undefined && lock) { x.h = h; x.w = h * ar; }
    else { x.w = w ?? x.w; x.h = h ?? x.h; }
    x.w = clampSide(x.w);
    x.h = clampSide(x.h);
    // Rotated shapes resize about their centre; others keep the top-left.
    if ((x.rot ?? 0) !== 0) { x.x = clampPos(cx - x.w / 2); x.y = clampPos(cy - x.h / 2); }
  });
}

function setBounds(ctx, p) {
  return editGeometry(ctx, p, 'shape.setBounds', sh => {
    const x = sh.xfrm;
    if (!x) return;
    x.x = clampPos(num(p, 'x') ?? x.x);
    x.y = clampPos(num(p, 'y') ?? x.y);
    x.w = clampSide(num(p, 'w') ?? x.w);
    x.h = clampSide(num(p, 'h') ?? x.h);
  });
}

// ---------------------------------------------------------------------------------------------
// Size and Position… (shape/size.rs)

const SIZE_POS = 'shape.sizePosition';
const MAX_SCALE = 10000;
function sizeSpec(p) {
  const fin = k => {
    if (p[k] === undefined || p[k] === null) return undefined;
    if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) throw bad(SIZE_POS, `\`${k}\` must be a finite number`);
    return p[k];
  };
  const range = (k, lo, hi) => {
    const v = fin(k);
    if (v !== undefined && !(v >= lo && v <= hi)) throw bad(SIZE_POS, `\`${k}\` is out of range`);
    return v;
  };
  if (p.lockAspect !== undefined && p.lockAspect !== null && typeof p.lockAspect !== 'boolean') throw bad(SIZE_POS, '`lockAspect` must be true or false');
  const spec = {
    x: range('x', -POS_LIMIT, POS_LIMIT), y: range('y', -POS_LIMIT, POS_LIMIT), w: range('w', MIN_PT, MAX_PT), h: range('h', MIN_PT, MAX_PT),
    rot: fin('rot'), scaleW: range('scaleW', Number.MIN_VALUE, MAX_SCALE), scaleH: range('scaleH', Number.MIN_VALUE, MAX_SCALE), lock: p.lockAspect === true,
  };
  spec.widthSet = spec.w !== undefined || spec.scaleW !== undefined;
  spec.heightSet = spec.h !== undefined || spec.scaleH !== undefined;
  spec.any = spec.x !== undefined || spec.y !== undefined || spec.widthSet || spec.heightSet || spec.rot !== undefined;
  return spec;
}
const normDeg = r => { const v = r % 360; return v < 0 ? v + 360 : v; };
/** `apply_size`: width wins when both sides are set with the aspect locked, matching `shape.resize`. */
export function applySize(x, spec) {
  const ar = x.h > 0 ? x.w / x.h : 1;
  let nw = x.w, nh = x.h;
  if (spec.scaleW !== undefined) nw = x.w * spec.scaleW / 100;
  if (spec.scaleH !== undefined) nh = x.h * spec.scaleH / 100;
  if (spec.w !== undefined) nw = spec.w;
  if (spec.h !== undefined) nh = spec.h;
  if (spec.lock && (spec.widthSet || spec.heightSet)) {
    if (spec.widthSet) nh = ar > 0 ? nw / ar : nh;
    else nw = nh * ar;
  }
  x.w = clamp(nw, MIN_PT, MAX_PT);
  x.h = clamp(nh, MIN_PT, MAX_PT);
  if (spec.x !== undefined) x.x = spec.x;
  if (spec.y !== undefined) x.y = spec.y;
  if (spec.rot !== undefined) x.rot = normDeg(spec.rot);
}
const sameXfrm = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (a.rot ?? 0) === (b.rot ?? 0) && !!a.flipH === !!b.flipH && !!a.flipV === !!b.flipV;

function sizePosition(ctx, p) {
  const spec = sizeSpec(p);
  const sl = currentSlide(ctx, SIZE_POS);
  if (!spec.any) {
    const first = targets(ctx, p, SIZE_POS)[0];
    if (first === undefined) throw bad(SIZE_POS, 'nothing selected');
    const sh = findShape(sl.shapes, first);
    if (!sh) throw bad(SIZE_POS, 'no such shape');
    const x = xfrmOf(ctx.doc, sl.id, sh);
    return {dialog: 'dialog.sizePosition', params: {x: x.x, y: x.y, w: x.w, h: x.h, rot: x.rot ?? 0, scaleW: 100, scaleH: 100, lockAspect: false}};
  }
  const ids0 = targets(ctx, p, SIZE_POS);
  const free = ids0.filter(i => !findShape(sl.shapes, i)?.locked);
  if (ids0.length && !free.length) throw bad(SIZE_POS, 'the object is locked');
  const changed = free.some(i => {
    const sh = findShape(sl.shapes, i);
    if (!sh) return false;
    const x = {...xfrmOf(ctx.doc, sl.id, sh)};
    const before = {...x};
    applySize(x, spec);
    return !sameXfrm(x, before);
  });
  if (!changed) return null;
  return editGeometry(ctx, p, SIZE_POS, sh => { if (sh.xfrm) applySize(sh.xfrm, spec); });
}

// ---------------------------------------------------------------------------------------------
// Rotate and flip (shape/size.rs rotate, flip)

function rotate(ctx, p) {
  // A trackpad twist sends many small steps. `gesture: move` keeps them as one undo;
  // `gesture: end` commits that step and does not rotate again.
  const g = ctx.view?.rotateGesture ?? 0;
  if (p.gesture === 'end') { ctx.setView({rotateGesture: g + 1}); return {}; }
  if (p.gesture === 'move') { ctx.mergeUndo(`shape.rotate#${g}`); ctx.setUndoLabel('Rotation'); }
  const abs = num(p, 'deg'), by = num(p, 'by');
  return editGeometry(ctx, p, 'shape.rotate', sh => {
    const x = sh.xfrm;
    if (!x) return;
    const r = (abs ?? x.rot ?? 0) + (by ?? 0);
    x.rot = ((r % 360) + 360) % 360;
  });
}

function flip(ctx, p) {
  const v = String(p.axis ?? 'horizontal').startsWith('v');
  return editGeometry(ctx, p, 'shape.flip', sh => {
    const x = sh.xfrm;
    if (!x) return;
    if (v) x.flipV = !x.flipV; else x.flipH = !x.flipH;
    // `Xfrm::affine` flips first and rotates second; a true mirror also negates the rotation.
    x.rot = (360 - rotNorm(x)) % 360;
  });
}

// ---------------------------------------------------------------------------------------------
// Geometry (appearance.rs adjust, smooth_corners, change)

function adjust(ctx, p) {
  const i = Math.min(usize(p, 'index') ?? 0, 16);
  const v = num(p, 'value');
  if (v === undefined) throw bad('shape.adjust', 'missing `value`');
  return editGeometry(ctx, p, 'shape.adjust', sh => {
    if (sh.geom?.kind === 'custom') return;
    const name = presetName(sh.geom);
    const defaults = presetInfo(name)?.defaults ?? [];
    const adj = [...(sh.geom?.adj ?? [])];
    while (adj.length <= i) adj.push(defaults[adj.length] ?? 0);
    adj[i] = v;
    sh.geom = {kind: 'preset', name, adj};
  });
}

function smoothCorners(ctx, p) {
  const CMD = 'shape.smoothCorners';
  if (num(p, 'smoothing') === undefined) throw bad(CMD, 'missing `smoothing` (0–100)');
  const smoothing = clamp(p.smoothing, 0, 100) / 100;
  const radius = num(p, 'radius') !== undefined ? Math.max(p.radius, 0) : undefined;
  return editGeometry(ctx, p, CMD, sh => {
    const x = sh.xfrm;
    if (!x) throw bad(CMD, 'the shape has no size of its own');
    const ss = Math.max(Math.min(x.w, x.h), 0);
    const g = sh.geom ?? {kind: 'preset', name: 'rect'};
    let own;
    if (g.kind !== 'custom' && g.name === 'roundRect') own = ss * clamp(g.adj?.[0] ?? 16667, 0, 50000) / 100000;
    else if (g.kind !== 'custom' && (g.name ?? 'rect') === 'rect') own = ss * 16667 / 100000;
    // A custom outline qualifies only when it is a squircle this command drew with `radius`
    // (re-smoothing as the slider moves), never an arbitrary freeform.
    let custom = false;
    if (g.kind === 'custom' && radius !== undefined && (g.paths ?? []).length === 1) {
      const only = g.paths[0];
      for (let k = 0; k <= 100 && !custom; k++) custom = squirclePathD(only.w, only.h, radius, k / 100) === only.d;
    }
    let r;
    if (radius !== undefined && (own !== undefined || custom)) r = radius;
    else if (radius === undefined && own !== undefined) r = own;
    else throw bad(CMD, 'only rectangles, rounded rectangles and shapes already smoothed with this `radius` can be smoothed');
    sh.geom = {kind: 'custom', paths: [{w: x.w, h: x.h, d: squirclePathD(x.w, x.h, r, smoothing), fill: 'norm', stroke: true}]};
  });
}

function change(ctx, p) {
  const name = str(p, 'preset');
  if (name === undefined) throw bad('shape.change', 'missing `preset`');
  const info = presetInfo(name);
  if (!info) throw bad('shape.change', `unknown preset \`${name}\``);
  return editGeometry(ctx, p, 'shape.change', sh => { sh.geom = {kind: 'preset', name: info.name}; });
}

// ---------------------------------------------------------------------------------------------
// Fill (shape.rs requested_fill / inherited_fills / apply_fill, appearance.rs fill, picture_props)

export async function requestedFill(ctx, p) {
  if (p.reset === true) return {set: true, fill: null};
  if (p.none === true) return {set: true, fill: fillNone()};
  const c = colorParam(p, 'color');
  if (c) return {set: true, fill: fillSolid(c)};
  if (p.gradient !== undefined) {
    const g = gradientParam(p.gradient);
    if (!g) throw bad('shape.fill', 'gradient needs at least two `stops`: [[0, "#fff"], [1, "#000"]]');
    return {set: true, fill: {kind: 'gradient', ...g}};
  }
  if (p.pattern !== undefined) {
    const pt = p.pattern ?? {};
    return {set: true, fill: {kind: 'pattern', preset: typeof pt.preset === 'string' ? pt.preset : 'pct50',
      fg: colorValue(pt.fg) ?? colorScheme('accent1'), bg: colorValue(pt.bg) ?? colorScheme('bg1')}};
  }
  if (p.picture !== undefined || p.pick === true) {
    let q = {data: p.picture, name: p.name};
    if (p.picture === undefined) {
      // The UI path (Shape Fill › Picture…): the system Open dialog gathers the file; Cancel changes nothing.
      if (ctx.origin === 'bridge' || typeof ctx.host?.pickImage !== 'function') throw bad('shape.fill', 'give `picture` (base64)');
      const url = await ctx.host.pickImage();
      if (!url) return {cancelled: true};
      q = {data: String(url), name: p.name ?? 'Picture'};
    }
    const {name, bytes} = await mediaBytes(ctx, q, 'shape.fill');
    if (!contentType(name, bytes).startsWith('image/')) throw bad('shape.fill', `${name} is not a picture`);
    const media = addMedia(ctx, 'shape.fill', name, contentType(name, bytes), bytes);
    return {set: true, fill: {kind: 'picture', media, crop: [0, 0, 0, 0], mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: pictureAdjustDefault()}};
  }
  return {set: false};
}

/** The effective fill of each targeted shape (and its members), for a transparency change on an inherited (style) fill. */
function inheritedFills(ctx, p) {
  const sl = currentSlide(ctx, 'shape.fill');
  const rctx = ctxForSlide(ctx.doc, sl);
  const out = new Map();
  for (const tid of targets(ctx, p, 'shape.fill')) {
    const sh = findShape(sl.shapes, tid);
    if (!sh) continue;
    applyDeep(sh, m => {
      let f = null;
      if (rctx) {
        const [ef, ph] = resolveFill(rctx, m);
        f = ef?.kind === 'solid' ? fillSolid(colorRgb(ctxColor(rctx, ef.color, ph))) : ef ?? null;
      }
      out.set(m.id, f);
    });
  }
  return out;
}

/** Format Shape › Picture or texture fill options on a picture fill. */
export function pictureProps(pf, pp) {
  const f = k => (typeof pp[k] === 'number' && Number.isFinite(pp[k]) ? pp[k] : undefined);
  if (typeof pp.rotateWithShape === 'boolean') { if (pp.rotateWithShape) delete pf.upright; else pf.upright = true; }
  if (pp.tile === true && pf.mode?.kind !== 'tile') pf.mode = {kind: 'tile', tx: 0, ty: 0, sx: 1, sy: 1, flip: 'none', align: 'tl'};
  else if (pp.tile === false && pf.mode?.kind !== 'stretch') pf.mode = {kind: 'stretch', fillRect: [0, 0, 0, 0]};
  const m = pf.mode ?? (pf.mode = {kind: 'stretch', fillRect: [0, 0, 0, 0]});
  if (m.kind === 'tile') {
    if (f('offsetX') !== undefined) m.tx = clamp(f('offsetX'), -4000, 4000);
    if (f('offsetY') !== undefined) m.ty = clamp(f('offsetY'), -4000, 4000);
    if (f('scaleX') !== undefined) m.sx = clamp(f('scaleX'), 0.01, 10);
    if (f('scaleY') !== undefined) m.sy = clamp(f('scaleY'), 0.01, 10);
    if (['none', 'x', 'y', 'xy'].includes(pp.mirror)) m.flip = pp.mirror;
    if (['tl', 't', 'tr', 'l', 'ctr', 'r', 'bl', 'b', 'br'].includes(pp.align)) m.align = pp.align;
  } else if (Array.isArray(pp.stretch)) {
    const fr = [...(m.fillRect ?? [0, 0, 0, 0])];
    pp.stretch.slice(0, 4).forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v)) fr[i] = clamp(v, -10, 0.99); });
    m.fillRect = fr;
  }
}

function applyFill(sh, req, pic, transparency, inherited) {
  if (req.set) sh.fill = req.fill === null ? null : structuredClone(req.fill);
  if (pic && sh.fill?.kind === 'picture') pictureProps(sh.fill, pic);
  if (transparency !== undefined && sh.fill?.kind === 'picture') {
    const a = 1 - clamp(transparency, 0, 1);
    sh.fill.alpha = a < 1 ? a : null;
    return;
  }
  if (transparency !== undefined) {
    const base = sh.fill ?? inherited.get(sh.id) ?? null;
    if (base?.kind === 'solid') {
      const mods = (base.color.mods ?? []).filter(m => m.op !== 'alpha');
      if (transparency > 0) mods.push({op: 'alpha', val: Math.round((1 - clamp(transparency, 0, 1)) * 100000)});
      const c = {...base.color, mods};
      if (!mods.length) delete c.mods;
      sh.fill = fillSolid(c);
    }
  }
}

async function fill(ctx, p) {
  const req = await requestedFill(ctx, p);
  if (req.cancelled) return null;
  const transparency = num(p, 'transparency');
  const pic = p.pictureProps && typeof p.pictureProps === 'object' && !Array.isArray(p.pictureProps) ? p.pictureProps : undefined;
  if (!req.set && transparency === undefined && !pic) {
    throw bad('shape.fill', 'give `color`, `none`, `gradient`, `pattern`, `picture`, `pictureProps`, `transparency` or `reset`');
  }
  const inherited = inheritedFills(ctx, p);
  return editShapes(ctx, p, 'shape.fill', sh => applyDeep(sh, m => applyFill(m, req, pic, transparency, inherited)));
}

// ---------------------------------------------------------------------------------------------
// Outline (appearance.rs line)

const lineEnd = v => (v === 'none' ? null : {kind: v, w: 'med', len: 'med'});
function line(ctx, p) {
  const reset = p.reset === true, none = p.none === true;
  const c = colorParam(p, 'color');
  const width = num(p, 'width') !== undefined ? clamp(p.width, 0, 1584) : undefined;
  const dash = str(p, 'dash') !== undefined ? {kind: 'preset', name: p.dash} : undefined;
  const head = str(p, 'head') !== undefined ? lineEnd(p.head) : undefined;
  const tail = str(p, 'tail') !== undefined ? lineEnd(p.tail) : undefined;
  const cap = str(p, 'cap') !== undefined ? (p.cap === 'round' ? 'round' : p.cap === 'square' ? 'square' : 'flat') : undefined;
  const compound = str(p, 'compound') !== undefined ? (['double', 'thickThin', 'thinThick', 'triple'].includes(p.compound) ? p.compound : 'single') : undefined;
  const endSize = k => (['sm', 'med', 'lg'].includes(p[k]) ? p[k] : undefined);
  const headSize = endSize('headSize'), tailSize = endSize('tailSize');
  const join = str(p, 'join') !== undefined ? (p.join === 'bevel' ? 'bevel' : p.join === 'miter' ? 'miter' : 'round') : undefined;
  const keepSize = (old, nw) => (nw ? {...nw, ...(old ? {w: old.w, len: old.len} : {})} : null);
  return editShapes(ctx, p, 'shape.line', top => applyDeep(top, sh => {
    if (reset) { sh.line = null; return; }
    const l = sh.line ?? (sh.line = lineDefault());
    if (none) l.fill = fillNone();
    if (c) l.fill = fillSolid(structuredClone(c));
    if (width !== undefined) {
      l.width = width;
      if (l.fill == null || (l.fill.kind === 'none' && !none)) l.fill = fillSolid(colorScheme('tx1'));
    }
    if (dash !== undefined) l.dash = {...dash};
    if (head !== undefined) l.head = keepSize(l.head, head);
    if (tail !== undefined) l.tail = keepSize(l.tail, tail);
    if (cap !== undefined) l.cap = cap;
    if (join !== undefined) l.join = join;
    if (compound !== undefined) l.compound = compound;
    // Arrowhead size (width and length together), kept when the kind changes.
    if (l.head && headSize) l.head = {...l.head, w: headSize, len: headSize};
    if (l.tail && tailSize) l.tail = {...l.tail, w: tailSize, len: tailSize};
  }));
}

// ---------------------------------------------------------------------------------------------
// Effects (appearance.rs effects, shadow_preset)

const black = a => colorWith(colorRgb({r: 0, g: 0, b: 0, a: 255}), {op: 'alpha', val: a});
const shadowBase = inner => ({color: black(40000), blur: 4, dist: 3, dir: 45, inner, sx: 1, sy: 1, kx: 0, ky: 0, align: 'tl', rotateWithShape: false});
/** `shadow_preset`: undefined (not a shadow value), null (none) or a shadow. */
export function shadowPreset(v) {
  if (typeof v === 'string') {
    switch (v) {
      case 'none': return null;
      case 'inner': return shadowBase(true);
      case 'perspective': return {...shadowBase(false), sy: 0.23, kx: -1200000 / 60000, dir: 90, dist: 0, blur: 6, align: 'bl'};
      case 'bottom': return {...shadowBase(false), dir: 90};
      case 'center': return {...shadowBase(false), dist: 0, blur: 8};
      default: return shadowBase(false);
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const f = (k, d) => (typeof v[k] === 'number' ? v[k] : d);
    return {...shadowBase(false), color: colorValue(v.color) ?? black(40000), blur: clamp(f('blur', 4), 0, 200), dist: clamp(f('dist', 3), 0, 200),
      dir: f('dir', 45), inner: typeof v.inner === 'boolean' ? v.inner : false};
  }
  return undefined;
}
const accentGlow = () => colorWith(colorScheme('accent1'), {op: 'alpha', val: 40000});
const fnum = (v, k) => (typeof v?.[k] === 'number' && Number.isFinite(v[k]) ? v[k] : undefined);

function effects(ctx, p) {
  const bevel = typeof p.bevel === 'string' ? p.bevel : undefined;
  const threeD = p.threeD && typeof p.threeD === 'object' && !Array.isArray(p.threeD) ? p.threeD : undefined;
  const reset = p.reset === true;
  const shadow = p.shadow !== undefined ? shadowPreset(p.shadow) : undefined;
  let glow;
  if (p.glow !== undefined) {
    if (p.glow && typeof p.glow === 'object' && !Array.isArray(p.glow)) glow = {color: colorValue(p.glow.color) ?? accentGlow(), radius: clamp(typeof p.glow.radius === 'number' ? p.glow.radius : 8, 0, 150)};
    else if (typeof p.glow === 'number') glow = {color: accentGlow(), radius: clamp(Number.isFinite(p.glow) ? p.glow : 8, 0, 150)};
    else glow = null;
  }
  const soft = p.softEdges !== undefined ? (typeof p.softEdges === 'number' && p.softEdges > 0 ? Math.min(p.softEdges, 100) : null) : undefined;
  let refl;
  if (typeof p.reflection === 'string') {
    refl = p.reflection === 'none' ? null
      : p.reflection === 'half' ? {blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.55, dist: 4}
      : p.reflection === 'full' ? {blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.9, dist: 4}
      : {blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.35, dist: 0};
  }
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const sp = isObj(p.shadowProps) ? p.shadowProps : undefined;
  const gp = isObj(p.glowProps) ? p.glowProps : undefined;
  const rp = isObj(p.reflectionProps) ? p.reflectionProps : undefined;
  return editShapes(ctx, p, 'shape.effects', sh => {
    if (reset) { sh.effects = null; return; }
    const e = sh.effects ?? (sh.effects = effectsDefault());
    if (shadow !== undefined) {
      if (shadow && shadow.inner) { e.innerShadow = structuredClone(shadow); e.outerShadow = null; }
      else if (shadow) { e.outerShadow = structuredClone(shadow); e.innerShadow = null; }
      else { e.outerShadow = null; e.innerShadow = null; }
    }
    if (glow !== undefined) e.glow = glow ? structuredClone(glow) : null;
    if (soft !== undefined) e.softEdge = soft;
    if (bevel !== undefined || threeD) {
      const s3 = parse3d(e.raw3d);
      if (bevel !== undefined) apply3d(s3, {bevelTop: bevel});
      if (threeD) {
        if (threeD.reset === true) Object.assign(s3, flat3d());
        apply3d(s3, threeD);
      }
      store3d(e, s3);
    }
    if (refl !== undefined) e.reflection = refl ? {...refl} : null;
    if (sp) {
      const key = e.innerShadow ? 'innerShadow' : 'outerShadow';
      const x = e[key] ? {...e[key]} : shadowPreset('outer');
      if (colorValue(sp.color)) x.color = withAlpha(colorValue(sp.color), colorAlphaOf(x.color));
      if (fnum(sp, 'transparency') !== undefined) x.color = withAlpha(x.color, 1 - clamp(sp.transparency, 0, 1));
      if (fnum(sp, 'blur') !== undefined) x.blur = clamp(sp.blur, 0, 100);
      if (fnum(sp, 'dist') !== undefined) x.dist = clamp(sp.dist, 0, 200);
      if (fnum(sp, 'dir') !== undefined) x.dir = ((sp.dir % 360) + 360) % 360;
      e[key] = x;
    }
    if (gp) {
      const g = e.glow ? {...e.glow} : {color: accentGlow(), radius: 8};
      if (colorValue(gp.color)) g.color = withAlpha(colorValue(gp.color), colorAlphaOf(g.color));
      if (fnum(gp, 'transparency') !== undefined) g.color = withAlpha(g.color, 1 - clamp(gp.transparency, 0, 1));
      if (fnum(gp, 'radius') !== undefined) g.radius = clamp(gp.radius, 0, 150);
      e.glow = g.radius > 0 ? g : null;
    }
    if (rp) {
      const r = e.reflection ? {...e.reflection} : {blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.35, dist: 0};
      if (fnum(rp, 'transparency') !== undefined) r.startAlpha = 1 - clamp(rp.transparency, 0, 1);
      if (fnum(rp, 'size') !== undefined) r.endPos = clamp(rp.size, 0, 1);
      if (fnum(rp, 'dist') !== undefined) r.dist = clamp(rp.dist, 0, 100);
      if (fnum(rp, 'blur') !== undefined) r.blur = clamp(rp.blur, 0, 100);
      e.reflection = r;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Quick styles (appearance.rs quick_style)

function quickStyle(ctx, p) {
  const i = Math.min(usize(p, 'index') ?? 1, 41);
  const [st, f, l] = quickStyleFor(i);
  return editShapes(ctx, p, 'shape.quickStyle', sh => {
    sh.style = structuredClone(st);
    sh.fill = f ? structuredClone(f) : null;
    sh.line = l ? structuredClone(l) : null;
    sh.effects = null;
    if (sh.text) sh.text = formatAll(sh.text, r => { const o = {...r}; delete o.fill; return o; });
  });
}

/** The Quick Styles gallery (ribbon/galleries.rs `quick_styles`): 6 rows × (Dark 1, Accent 1–6), index row × 7 + colour. */
const QS_NAMES = ['Dark 1', 'Accent 1', 'Accent 2', 'Accent 3', 'Accent 4', 'Accent 5', 'Accent 6'];
const QS_ROWS = ['Colored Outline', 'Colored Fill', 'Light 1 Outline, Colored Fill', 'Subtle Effect', 'Moderate Effect', 'Intense Effect'];
export const QUICK_STYLES = Object.freeze(Array.from({length: 42}, (_, i) => ({id: String(i), label: `${QS_ROWS[Math.floor(i / 7)]} - ${QS_NAMES[i % 7]}`, value: i})));

// ---------------------------------------------------------------------------------------------
// Names, alt text, visibility, lock, default (shape.rs)

function setLocked(sh, to, depth) {
  sh.locked = to;
  if (depth > 64) return;
  if (isGroup(sh)) for (const c of sh.kind.children ?? []) setLocked(c, to, depth + 1);
}

function setDefault(ctx) {
  const sl = currentSlide(ctx, 'shape.setDefault');
  const first = targets(ctx, {}, 'shape.setDefault')[0];
  const sh = first !== undefined ? findShape(sl.shapes, first) : null;
  if (!sh) return null;
  // New shapes drawn in this session take this look (Set as Default Shape).
  const run = sh.text?.paragraphs?.[0]?.runs?.[0];
  ctx.setView({defaultLook: {run: run ? {...(run.props ?? {})} : null, para: null, fill: sh.fill ?? null, line: sh.line ?? null,
    effects: sh.effects ?? null, style: sh.style ?? null}});
  return null;
}

// ---------------------------------------------------------------------------------------------
// Connectors, freeforms, ink (shape/freeform.rs)

function sitesOf(ctx, sl, sh) {
  return connectionSites(ctx.doc, sl, sh) ?? [];
}

function sites(ctx, p) {
  const i = idOf(p.id);
  if (i === null) throw bad('shape.sites', 'missing `id`');
  const sl = currentSlide(ctx, 'shape.sites');
  const sh = findShape(sl.shapes, i);
  if (!sh) throw bad('shape.sites', 'no such shape');
  return sitesOf(ctx, sl, sh).map(q => [q.x, q.y]);
}

async function connect(ctx, p) {
  const from = idOf(p.from), to = idOf(p.to);
  if (from === null || to === null) throw bad('shape.connect', 'missing `from` / `to`');
  const sl = currentSlide(ctx, 'shape.connect');
  const list = i => { const sh = findShape(sl.shapes, i); return sh ? sitesOf(ctx, sl, sh) : []; };
  const a = list(from), bb = list(to);
  if (!a.length || !bb.length) throw bad('shape.connect', 'both shapes need connection sites (lines and groups have none)');
  const pick = (v, k) => { const x = usize(p, k); return x !== undefined && x < v.length ? x : undefined; };
  const fi = pick(a, 'fromSite'), fj = pick(bb, 'toSite');
  let ia, ib;
  if (fi !== undefined && fj !== undefined) { ia = fi; ib = fj; } else {
    let best = [Infinity, 0, 0];
    a.forEach((pa, i) => {
      if (fi !== undefined && fi !== i) return;
      bb.forEach((pb, j) => {
        if (fj !== undefined && fj !== j) return;
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (d < best[0]) best = [d, i, j];
      });
    });
    [, ia, ib] = best;
  }
  const p0 = a[ia], p1 = bb[ib];
  let lid = p.id !== undefined ? idOf(p.id) : null;
  if (lid === null) {
    const r = await ctx.run('shape.insert', {preset: str(p, 'preset') ?? 'straightConnector1', rect: [p0.x, p0.y, 1, 1]});
    lid = r?.id;
    if (!lid) throw bad('shape.connect', 'insert failed');
  }
  const cur = findShape(slideById(ctx.doc, sl.id).shapes, lid);
  if (!cur) throw bad('shape.connect', 'no such line');
  if (!isLine(cur)) throw bad('shape.connect', '`id` is not a line or connector');
  writeShape(ctx, sl.id, {...cur, xfrm: lineXfrm(p0, p1), kind: {type: 'connector', start: [from, ia], end: [to, ib]}});
  return {id: lid, fromSite: ia, toSite: ib};
}

const fmt2 = v => { const t = v.toFixed(2); return t.replace(/0+$/, '').replace(/\.$/, ''); };
/** `freeform_path`: path data through `pts` (shape-local): straight segments, or a Catmull-Rom curve as cubics. */
export function freeformPath(pts, closed, smooth) {
  const f = v => { const r = fmt2(v); return r === '-0' ? '-0' : r; };
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  const len = pts.length;
  if (smooth && len > 2) {
    const at = i => (closed ? pts[((i % len) + len) % len] : pts[clamp(i, 0, len - 1)]);
    const segs = closed ? len : len - 1;
    for (let i = 0; i < segs; i++) {
      const q0 = at(i - 1), q1 = at(i), q2 = at(i + 1), q3 = at(i + 2);
      const c1 = {x: q1.x + (q2.x - q0.x) / 6, y: q1.y + (q2.y - q0.y) / 6};
      const c2 = {x: q2.x - (q3.x - q1.x) / 6, y: q2.y - (q3.y - q1.y) / 6};
      d += ` C ${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(q2.x)} ${f(q2.y)}`;
    }
  } else {
    for (const q of pts.slice(1)) d += ` L ${f(q.x)} ${f(q.y)}`;
  }
  if (closed) d += ' Z';
  return d;
}

async function freeform(ctx, p) {
  const pts = [];
  for (const v of Array.isArray(p.points) ? p.points : []) {
    if (pts.length >= 20000) break;
    const x = Array.isArray(v) ? v[0] : v?.x, y = Array.isArray(v) ? v[1] : v?.y;
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) pts.push({x, y});
  }
  if (pts.length < 2) throw bad('shape.freeform', 'need at least two points');
  const closed = p.closed === true && pts.length > 2;
  const smooth = p.smooth === true;
  let x0 = pts[0].x, y0 = pts[0].y, x1 = x0, y1 = y0;
  for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
  const d = freeformPath(pts.map(q => ({x: q.x - x0, y: q.y - y0})), closed, smooth);
  // Closed shapes take the default shape style, open paths the line style.
  const r = await ctx.run('shape.insert', {preset: closed ? 'rect' : 'line', rect: [x0, y0, w, h]});
  const nid = r?.id;
  if (!nid) throw bad('shape.freeform', 'insert failed');
  const sl = currentSlide(ctx, 'shape.freeform');
  const cur = findShape(sl.shapes, nid);
  if (!cur) throw bad('shape.freeform', 'insert failed');
  writeShape(ctx, sl.id, {...cur, geom: {kind: 'custom', paths: [{w, h, d, fill: closed ? 'norm' : 'none', stroke: true}]},
    xfrm: {x: x0, y: y0, w, h}, kind: {type: 'shape'}, name: `Freeform ${nid}`});
  return {id: nid};
}

function inkToShape(ctx) {
  const sl = currentSlide(ctx, 'draw.inkToShape');
  const ink = (sl.shapes ?? []).find(sh => sh.kind?.type === 'ink');
  if (!ink) return {shapes: [], kept: 0};
  const off = ink.xfrm ? [ink.xfrm.x, ink.xfrm.y] : [0, 0];
  const strokes = ink.kind.strokes ?? [];
  const found = strokes.map(st => (st.highlighter ? null : recognize((st.points ?? []).map(q => [q[0] + off[0], q[1] + off[1]]))));
  if (found.every(f => !f)) return {shapes: [], kept: strokes.length};
  const kept = [], made = [];
  strokes.forEach((st, i) => {
    const r = found[i];
    if (!r) { kept.push(st); return; }
    let preset, xfrm;
    if (r.kind === 'line') { preset = 'line'; xfrm = lineXfrm({x: r.x0, y: r.y0}, {x: r.x1, y: r.y1}); }
    else if (r.kind === 'rect') { preset = 'rect'; xfrm = {x: r.x, y: r.y, w: r.w, h: r.h}; }
    else if (r.kind === 'ellipse') { preset = 'ellipse'; xfrm = {x: r.x, y: r.y, w: r.w, h: r.h}; }
    else { preset = 'triangle'; xfrm = {x: r.x, y: r.y, w: r.w, h: r.h, ...(r.flipV ? {flipV: true} : {})}; }
    made.push({preset, xfrm, color: st.color, width: st.width});
  });
  const listPath = [...slidePath(ctx.doc, sl.id), 'shapes'];
  let list = [...sl.shapes];
  const pos = list.findIndex(sh => sh.id === ink.id);
  if (kept.length === 0) list.splice(pos, 1);
  else list[pos] = {...ink, kind: {...ink.kind, strokes: kept}};
  const added = [];
  for (const m of made) {
    const nid = newId(ctx, 'draw.inkToShape');
    const label = m.preset === 'line' ? 'Straight Connector' : m.preset === 'rect' ? 'Rectangle' : m.preset === 'ellipse' ? 'Oval' : 'Isosceles Triangle';
    list.push({id: nid, name: `${label} ${nid}`, xfrm: m.xfrm, kind: {type: 'shape'}, geom: {kind: 'preset', name: m.preset}, ph: null, fill: fillNone(),
      line: {...lineDefault(), fill: fillSolid(colorRgb(m.color ?? {r: 0, g: 0, b: 0, a: 255})), width: clamp(m.width ?? 1, 0.25, 100)},
      effects: null, style: null, text: null, hidden: false, locked: false, textBox: false, descr: '', title: '', decorative: false, click: null, hover: null});
    added.push(nid);
  }
  ctx.change.set(listPath, list);
  selectIds(ctx, sl.id, added);
  return {shapes: added, kept: kept.length};
}

// ---------------------------------------------------------------------------------------------
// Pictures and media (shape/picture.rs)

function crop(ctx, p) {
  const c = [num(p, 'left'), num(p, 'top'), num(p, 'right'), num(p, 'bottom')];
  return editGeometry(ctx, p, 'picture.crop', sh => {
    if (sh.kind?.type !== 'picture') return;
    const fc = [...(sh.kind.fill.crop ?? [0, 0, 0, 0])];
    c.forEach((v, i) => { if (v !== undefined) fc[i] = clamp(v, -10, 0.95); });
    sh.kind.fill.crop = fc;
  });
}

function pictureAdjust(ctx, p) {
  return editShapes(ctx, p, 'picture.adjust', sh => {
    if (sh.kind?.type !== 'picture') return;
    const fl = sh.kind.fill;
    if (p.reset === true) fl.adjust = pictureAdjustDefault();
    const a = fl.adjust ?? (fl.adjust = pictureAdjustDefault());
    if (num(p, 'brightness') !== undefined) a.brightness = clamp(p.brightness, -1, 1);
    if (num(p, 'contrast') !== undefined) a.contrast = clamp(p.contrast, -1, 1);
    if (num(p, 'saturation') !== undefined) a.saturation = clamp(p.saturation, 0, 4);
    if (bool(p, 'grayscale') !== undefined) a.grayscale = p.grayscale;
    if (num(p, 'transparency') !== undefined) fl.alpha = clamp(1 - p.transparency, 0, 1);
  });
}

function pictureReset(ctx, p) {
  return editShapes(ctx, p, 'picture.reset', sh => {
    if (sh.kind?.type === 'picture') {
      const fl = sh.kind.fill;
      fl.adjust = pictureAdjustDefault();
      fl.crop = [0, 0, 0, 0];
      fl.alpha = null;
      if (fl.artistic) { fl.media = fl.artistic.original; delete fl.artistic; }
    }
    sh.effects = null;
    sh.line = null;
  });
}

async function pictureChange(ctx, pIn) {
  let p = pIn;
  // The UI path (Change Picture › From a File…): the system Open dialog gathers the file; Cancel changes nothing.
  if (p.path === undefined && p.data === undefined && ctx.origin !== 'bridge' && typeof ctx.host?.pickImage === 'function') {
    const url = await ctx.host.pickImage();
    if (!url) return null;
    p = {...p, data: String(url), name: p.name ?? 'Picture'};
  }
  const {name, bytes} = await mediaBytes(ctx, p, 'picture.change');
  if (!contentType(name, bytes).startsWith('image/')) throw bad('picture.change', `${name} is not a picture`);
  const media = addMedia(ctx, 'picture.change', name, contentType(name, bytes), bytes);
  return editShapes(ctx, p, 'picture.change', sh => {
    if (sh.kind?.type !== 'picture') return;
    sh.kind.fill.media = media;
    sh.kind.fill.crop = [0, 0, 0, 0];
    delete sh.kind.fill.artistic;
  });
}

function mediaOptions(ctx, p) {
  const ms = k => (Number.isSafeInteger(p[k]) && p[k] >= 0 ? Math.min(p[k], 0xffffffff) : undefined);
  editShapes(ctx, p, 'media.options', sh => {
    if (sh.kind?.type !== 'media') return;
    const m = sh.kind;
    const set = (k, field) => { if (bool(p, k) !== undefined) m[field] = p[k]; };
    set('autoplay', 'autoplay'); set('loop', 'loopPlay'); set('rewind', 'rewind'); set('acrossSlides', 'playAcrossSlides');
    set('hide', 'hideWhileNotPlaying'); set('fullScreen', 'fullScreen');
    if (num(p, 'volume') !== undefined) m.volume = clamp(p.volume, 0, 1);
    if (ms('trimStart') !== undefined) m.trimStartMs = ms('trimStart');
    if (ms('trimEnd') !== undefined) m.trimEndMs = ms('trimEnd');
    if (ms('fadeIn') !== undefined) m.fadeInMs = ms('fadeIn');
    if (ms('fadeOut') !== undefined) m.fadeOutMs = ms('fadeOut');
  });
  return {};
}

// ---------------------------------------------------------------------------------------------

const selected = hasSelection;
const stateValue = (ctx, f) => {
  const st = selected(ctx);
  if (!st.enabled) return st;
  const sl = currentSlide(ctx, 'shape');
  const first = targets(ctx, {}, 'shape')[0];
  const sh = first !== undefined ? findShape(sl.shapes, first) : null;
  return sh ? {enabled: true, value: f(sh, xfrmOf(ctx.doc, sl.id, sh))} : st;
};

export default defineCommands({
  family: 'shape',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'shape.connect', label: 'Connect Shapes', risk: 'edit', state: hasSlide,
      description: '{from: shape id, to: shape id, fromSite?, toSite?: site index (default: the closest pair), id?: existing line to glue (else a new connector), preset?: straightConnector1|bentConnector3|curvedConnector3} → {id}',
      params: s.object({from: ID, to: ID, fromSite: s.optional(s.integer({min: 0})), toSite: s.optional(s.integer({min: 0})), id,
        preset: s.optional(s.enum(['straightConnector1', 'bentConnector3', 'curvedConnector3']))}),
      run: connect},
    {id: 'shape.freeform', label: 'Freeform', risk: 'edit', state: hasSlide,
      description: '{points: [[x, y], …] slide pt (≥ 2), closed?: bool (filled shape), smooth?: bool (curve through the points)} → {id}',
      params: s.object({points: s.array(s.any(), {max: 100000}), closed: b('filled shape'), smooth: b('curve through the points')}),
      run: freeform},
    {id: 'draw.inkToShape', label: 'Ink to Shape', risk: 'edit', state: hasSlide,
      description: '{} → {shapes: [ids], kept: n} turns recognisable ink strokes on the slide into lines, rectangles, ellipses and triangles',
      params: s.object({}), run: inkToShape},
    {id: 'shape.sites', label: 'Connection Sites', risk: 'read', state: hasSlide,
      description: '{id} → [[x, y]] connection sites in slide points', params: s.object({id: ID}), run: sites},
    {id: 'shape.move', label: 'Move', risk: 'edit', state: selected,
      description: '{dx?: pt (relative), dy?: pt (relative), ids?} | {x?: pt (absolute), y?: pt (absolute), ids?}',
      params: s.object({dx: n('pt, relative'), dy: n('pt, relative'), x: n('pt, absolute'), y: n('pt, absolute'), ids, id}), run: moveBy},
    {id: 'shape.resize', label: 'Size', risk: 'edit', state: (ctx, p) => (p?.w !== undefined ? stateValue(ctx, (sh, x) => x.w) : stateValue(ctx, (sh, x) => x.h)),
      description: '{w?: pt, h?: pt, lockAspect?: bool, ids?}',
      params: s.object({w: n('pt'), h: n('pt'), lockAspect: b(), ids, id}), run: resize},
    {id: 'shape.setBounds', label: 'Position and Size', risk: 'edit', state: selected, description: '{x, y, w, h, ids?}',
      params: s.object({x: n(), y: n(), w: n(), h: n(), ids, id}), run: setBounds},
    {id: 'shape.rotate', label: 'Rotation', risk: 'edit', state: selected, description: '{deg?: absolute, by?: relative, ids?, gesture?: move|end}',
      params: s.object({deg: n('absolute'), by: n('relative'), ids, id, gesture: s.optional(s.enum(['move', 'end']))}), run: rotate},
    {id: 'shape.sizePosition', label: 'Size and Position…', risk: 'edit', state: selected, dialog: 'dialog.sizePosition',
      description: '{x?, y?: pt, w?, h?: pt, rot?: deg, scaleW?, scaleH?: percent of the current size (100 = unchanged), lockAspect?: bool, ids?} — with none of those keys, opens the dialog',
      params: s.object({x: s.optional(s.any()), y: s.optional(s.any()), w: s.optional(s.any()), h: s.optional(s.any()), rot: s.optional(s.any()),
        scaleW: s.optional(s.any()), scaleH: s.optional(s.any()), lockAspect: s.optional(s.any()), ids, id}),
      run: sizePosition},
    {id: 'shape.flip', label: 'Flip', risk: 'edit', state: selected, description: '{axis: horizontal|vertical, ids?}',
      params: s.object({axis: s.optional(s.enum(['horizontal', 'vertical'])), ids, id}), run: flip},
    {id: 'shape.adjust', label: 'Adjust Shape', risk: 'edit', state: selected, description: '{index, value (file units), ids?}',
      params: s.object({index: s.optional(s.integer({min: 0})), value: s.number(), ids, id}), run: adjust},
    {id: 'shape.change', label: 'Change Shape', risk: 'edit',
      state: ctx => { const st = selected(ctx); return st.enabled ? {enabled: true, value: shapesGallery().filter(i => presetInfo(i.value))} : st; }, description: '{preset, ids?}',
      params: s.object({preset: s.string({min: 1, max: 64}), ids, id}), run: change},
    {id: 'shape.smoothCorners', label: 'Smooth Corners', risk: 'edit', state: selected,
      description: "{smoothing: 0..100 (%), radius?: pt (default: the rounded rectangle's own), ids?} → rectangle outline with smoothed (squircle) corners",
      params: s.object({smoothing: s.number(), radius: n('pt'), ids, id}), run: smoothCorners},
    {id: 'shape.fill', label: 'Shape Fill', risk: 'edit', state: selected,
      description: '{color? | none?: true | gradient?: {stops: [[pos, color]], angle?, kind?: linear|radial} | picture?: base64 | pattern?: {preset, fg, bg} | transparency?: 0..1 | reset?: true, ids?}; pictureProps?: {tile?: bool, offsetX?, offsetY?: pt, scaleX?, scaleY?: 0..10, align?: tl|t|tr|l|ctr|r|bl|b|br, mirror?: none|x|y|xy, stretch?: [l, t, r, b] fractions, rotateWithShape?: bool} adjusts a picture fill; a group also formats its members',
      params: s.object({color: color(), none: b(), gradient: s.optional(s.any()), picture: s.optional(s.string()), name: s.optional(s.string({max: 255})),
        pattern: s.optional(s.any()), transparency: n('0..1'), reset: b(), pictureProps: s.optional(s.any()), pick: b('the system Open dialog picks the picture (UI only)'), ids, id}),
      run: fill},
    {id: 'shape.line', label: 'Shape Outline', risk: 'edit', state: selected,
      description: '{color?, none?, width?: pt, dash?: solid|dot|dash|lgDash|dashDot|sysDot|sysDash, cap?: flat|round|square, join?: round|bevel|miter, compound?: single|double|thickThin|thinThick|triple, head?: none|triangle|stealth|diamond|oval|arrow, tail?, headSize?: sm|med|lg, tailSize?, reset?, ids?}; a group also formats its members',
      params: s.object({color: color(), none: b(), width: n('pt'), dash: s.optional(s.string({max: 32})), cap: s.optional(s.string({max: 16})),
        join: s.optional(s.string({max: 16})), compound: s.optional(s.string({max: 16})), head: s.optional(s.string({max: 16})), tail: s.optional(s.string({max: 16})),
        headSize: s.optional(s.string({max: 8})), tailSize: s.optional(s.string({max: 8})), reset: b(), ids, id}),
      run: line},
    {id: 'shape.effects', label: 'Shape Effects', risk: 'edit', state: selected,
      description: '{shadow?: none|outer|inner|perspective|{color, blur, dist, dir}, glow?: none|{color, radius}, softEdges?: pt, reflection?: none|tight|half|full, bevel?: none|circle|…, threeD?: {…}, shadowProps?: {color?, transparency?: 0..1, blur?: pt, dist?: pt, dir?: deg}, glowProps?: {color?, transparency?, radius?: pt}, reflectionProps?: {transparency?, size?: 0..1, dist?: pt, blur?: pt}, reset?, ids?} (the *Props keys adjust the current effect, adding a default one when there is none)',
      params: s.object({shadow: s.optional(s.any()), glow: s.optional(s.any()), softEdges: s.optional(s.any()), reflection: s.optional(s.string({max: 16})),
        bevel: s.optional(s.any()), threeD: s.optional(s.any()), shadowProps: s.optional(s.any()), glowProps: s.optional(s.any()),
        reflectionProps: s.optional(s.any()), reset: b(), ids, id}),
      run: effects},
    {id: 'shape.quickStyle', label: 'Quick Styles', risk: 'edit', state: ctx => { const st = selected(ctx); return st.enabled ? {enabled: true, value: QUICK_STYLES} : st; }, description: '{index: 0..41 (theme style row×accent), ids?}',
      params: s.object({index: s.optional(s.integer({min: 0})), ids, id}), run: quickStyle},
    {id: 'shape.rename', label: 'Rename', risk: 'edit', state: selected, dialog: 'dialog.renameShape', description: '{name, id?}',
      params: s.object({name: s.string({max: 255}), id, ids}),
      run(ctx, p) { return editShapes(ctx, p, 'shape.rename', sh => { sh.name = p.name; }); }},
    {id: 'shape.altText', label: 'Alt Text', risk: 'edit', state: selected, dialog: 'dialog.altText', description: '{text, decorative?: bool, ids?}',
      params: s.object({text: s.optional(s.string({max: 100000})), decorative: b(), ids, id}),
      run(ctx, p) {
        return editShapes(ctx, p, 'shape.altText', sh => { sh.descr = p.text ?? ''; if (typeof p.decorative === 'boolean') sh.decorative = p.decorative; });
      }},
    {id: 'shape.visible', label: 'Show/Hide', risk: 'edit', state: selected, description: '{visible?: bool, ids?}',
      params: s.object({visible: b(), ids, id}),
      run(ctx, p) { return editShapes(ctx, p, 'shape.visible', sh => { sh.hidden = !(p.visible ?? sh.hidden); }); }},
    {id: 'shape.lock', label: 'Lock', risk: 'edit', state: selected,
      description: '{locked?: bool (default: toggle), ids?} (a group locks or unlocks with everything in it)',
      params: s.object({locked: b('default: toggle'), ids, id}),
      run(ctx, p) { return editShapes(ctx, p, 'shape.lock', sh => setLocked(sh, p.locked ?? !sh.locked, 0)); }},
    {id: 'shape.setDefault', label: 'Set as Default Shape', risk: 'read', effect: 'view', state: selected, description: '{}',
      params: s.object({}), run: setDefault},
    {id: 'picture.crop', label: 'Crop', risk: 'edit', state: selected,
      description: '{left?: fraction 0..1, top?: fraction 0..1, right?: fraction 0..1, bottom?: fraction 0..1, ids?}',
      params: s.object({left: n(), top: n(), right: n(), bottom: n(), ids, id}), run: crop},
    {id: 'picture.adjust', label: 'Corrections', risk: 'edit', state: selected,
      description: '{brightness?: -1..1, contrast?: -1..1, saturation?: 0..4, grayscale?: bool, transparency?: 0..1, reset?: bool, ids?}',
      params: s.object({brightness: n(), contrast: n(), saturation: n(), grayscale: b(), transparency: n(), reset: b(), ids, id}), run: pictureAdjust},
    {id: 'picture.reset', label: 'Reset Picture', risk: 'edit', state: selected, description: '{ids?}', params: s.object({ids, id}), run: pictureReset},
    {id: 'picture.change', label: 'Change Picture', risk: 'edit', state: selected, description: '{path? | data: base64, name?, ids?}',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string()), name: s.optional(s.string({max: 255})), ids, id}),
      run: pictureChange},
    {id: 'media.options', label: 'Playback', risk: 'edit', state: selected, dialog: 'dialog.trim',
      description: '{autoplay?, loop?, rewind?, acrossSlides?, hide?, fullScreen?, volume?: 0..1, trimStart?: ms, trimEnd?: ms, fadeIn?: ms, fadeOut?: ms, ids?}',
      params: s.object({autoplay: b(), loop: b(), rewind: b(), acrossSlides: b(), hide: b(), fullScreen: b(), volume: n(), trimStart: n(), trimEnd: n(),
        fadeIn: n(), fadeOut: n(), ids, id}),
      run: mediaOptions},
  ],
});
