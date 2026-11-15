// Shape Format: Shape Fill (colour, transparency, gradient), Shape Outline (colour, weight), Shape Effects
// (shadow, glow, soft edges), Edit Shape › Change Shape, and the Text group (Text Direction, Align Text, Create
// Link, Break Link); Shape Format › Drawing Canvas (Fit, Expand, Scale Drawing).
//
// Translated from wordcraft crates/engine/src/cmd/shape_fill.rs (`shape_fill`, `targets`), objects/shape.rs
// (`shape_effects`, `text_box_target`, `set_text_body`, `link_text_box`), objects/specs.rs (`shape.outline`,
// `shape.change`, `shape.textDirection`, `shape.alignText`, `shape.breakLink`) and canvas.rs (`fit`, `expand`,
// `scale`, `edit_canvas`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// A shape is `{type: 'shape', kind, fill, stroke, strokeWidth, effects?, ...}` (model/para.mjs); a Drawing Canvas
// is a group with `canvas: {fill, stroke, strokeWidth}`. Shape Fill and Outline colour the canvas's background and
// border; effects belong to shapes. Picture and Texture fill, Preset effects and Reroute Connectors are in shape-rest.mjs (U:quill/rest). Hidden (no engine): Sketched,
// Dashes and Arrows for the outline, 3-D Rotation.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {UPSTREAM_COMMIT} from '../../lib/caret-session.mjs';
import * as P from '../../model/para.mjs';
import {parseRgb, rgbModified} from '../../model/props.mjs';
import {THEME_COLORS} from '../../model/content.mjs';
import {sanitizedFill, fillForm} from '../../model/fill.mjs';
import {reflectionPreset, defaultReflection, sanitizedReflection, sanitizedBevel, shadowPreset, defaultShadow, defaultGlow, sanitizedShadow, sanitizedGlow, sanitizedEffects, effectsExtent, shapeEffectsIsEmpty, SHADOW_PRESETS} from '../../model/effects.mjs';
import {BODY} from '../../model/document.mjs';
import {parseFill, variations, fillMainColor, fillParams} from '../../lib/shape-fill.mjs';
import {pickedAll, stateFor, target, editAt, finish, open, selectedIn, selectedAll, isShape, isShapeOrCanvas, disabled, NO_SHAPE, NO_OBJECT, ready} from '../../lib/object-edit.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/shape_fill.rs', 'crates/engine/src/cmd/objects/shape.rs', 'crates/engine/src/cmd/objects/specs.rs', 'crates/engine/src/cmd/canvas.rs']};
const NO_BOX = 'select a text box first';
const NO_CANVAS = 'select a drawing canvas first';
const MAX_TARGETS = 10_000;
/** The outline colour a new shape has (Insert › Shapes). */
const DEFAULT_STROKE = [0x0e, 0x40, 0x5a];
const COLOR = s.string({min: 1, max: 16});
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

const shapeOrCanvasState = stateFor(o => (isShapeOrCanvas(o) ? null : NO_SHAPE), NO_SHAPE);
const shapeState = stateFor(o => (isShape(o) ? null : NO_SHAPE), NO_SHAPE);
const canvasState = stateFor(o => (P.isCanvas(o) ? null : NO_CANVAS), NO_CANVAS);

/** The shapes (or, `canvases`, canvases too) in the selection. */
function targets(S, want) {
  // The selected shapes and those added with Shift+click.
  const out = pickedAll(S).slice(0, MAX_TARGETS).filter(h => want(h.obj));
  if (!out.length) throw disabled('no shape selected');
  return out;
}

/** Edit each of `hits` (positions in one document round); the last new object comes back. */
function editEach(S, hits, f) {
  let last = null;
  for (const h of hits) last = editAt(S, h.pos, f);
  return last;
}

// ---- Shape Fill and Outline ---------------------------------------------------------------------------

function fillCmd(ctx, p) {
  const change = parseFill(p);
  const S = open(ctx);
  const hits = targets(S, isShapeOrCanvas);
  const last = editEach(S, hits, o => {
    const cv = o.type === 'group' ? o.canvas : null;
    const cur = cv ? cv.fill : o.fill;
    let next;
    if (change.kind === 'none') next = null;
    else if (change.kind === 'fill') next = change.fill;
    else if (change.kind === 'main') {
      const f = fillForm(cur);
      next = f ? sanitizedFill({type: 'solid', color: fillMainColor(f), transparency: f.type === 'solid' ? f.transparency ?? 0 : 0}) : null;
    } else {
      const kept = fillForm(cur)?.type === 'solid' ? fillForm(cur).transparency ?? 0 : 0;
      next = sanitizedFill({type: 'solid', color: change.color, transparency: change.transparency ?? kept});
    }
    return cv ? {...o, canvas: {...cv, fill: next}} : {...o, fill: next};
  });
  return finish(ctx, S, {edit: true, result: {object: last, count: hits.length}});
}

function outlineCmd(ctx, p) {
  // The palette's Automatic arrives as `auto`: the default outline colour; `none` is no outline.
  const auto = /^auto(matic)?$/i.test(String(p.color));
  const color = p.color === undefined || p.color === null || /^none$/i.test(String(p.color)) ? null : auto ? DEFAULT_STROKE : parseRgb(p.color);
  if (p.color !== undefined && p.color !== null && !color && !/^none$/i.test(String(p.color))) throw new CommandError('invalid_params', '`color`: "RRGGBB" or null', {path: '/color'});
  const {S, pos} = target(ctx, o => (isShapeOrCanvas(o) ? null : NO_SHAPE), NO_SHAPE);
  const width = p.width === undefined ? undefined : clamp(p.width, 0, 72);
  const next = editAt(S, pos, o => {
    // A weight alone keeps the colour the outline has (a shape with none gets the default one).
    const keep = p.color === undefined;
    if (o.type === 'group' && o.canvas) return {...o, canvas: {...o.canvas, stroke: keep ? o.canvas.stroke ?? DEFAULT_STROKE : color, ...(width !== undefined ? {strokeWidth: width} : {})}};
    const out = {...o, stroke: keep ? o.stroke ?? DEFAULT_STROKE : color, ...(width !== undefined ? {strokeWidth: width} : {})};
    // A colour chosen here replaces an outline gradient from a file.
    if (out.extra?.outlineFill) { out.extra = {...out.extra}; delete out.extra.outlineFill; }
    return out;
  });
  return finish(ctx, S, {edit: true, result: {object: next}});
}

// ---- Shape Effects ------------------------------------------------------------------------------------

const bad = m => new CommandError('invalid_params', m);
export function parseShadow(v) {
  if (v === undefined) return undefined;
  if (v === null || v === false || v === 'none') return null;
  if (v === true) return defaultShadow();
  const preset = id => { const sh = shadowPreset(id); if (!sh) throw bad(`unknown shadow preset \`${id}\``); return sh; };
  if (typeof v === 'string') return preset(v);
  if (typeof v === 'object') {
    const sh = typeof v.preset === 'string' ? preset(v.preset) : defaultShadow();
    if (v.color !== undefined) sh.color = parseRgb(v.color) ?? sh.color;
    for (const k of ['transparency', 'blur', 'distance', 'angle']) if (Number.isFinite(v[k])) sh[k] = v[k];
    return sanitizedShadow(sh);
  }
  throw bad('`shadow`: a preset name, an object or null');
}
export function parseGlow(v, accent = null) {
  if (v === undefined) return undefined;
  if (v === null || v === 'none') return null;
  if (typeof v === 'number') return sanitizedGlow({...defaultGlow(), ...(accent ? {color: accent} : {}), size: v});
  if (typeof v === 'object') return sanitizedGlow({color: parseRgb(v.color) ?? defaultGlow().color, size: Number.isFinite(v.size) ? v.size : defaultGlow().size, transparency: Number.isFinite(v.transparency) ? v.transparency : defaultGlow().transparency});
  throw bad('`glow`: a size in points, an object or null');
}
function parseSoft(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'number') return v;
  throw bad('`softEdge`: a radius in points or null');
}

function parseReflection(v) {
  if (v === undefined) return undefined;
  if (v === null || v === false || v === 'none') return null;
  if (typeof v === 'string') { const r = reflectionPreset(v); if (!r) throw bad('unknown reflection preset ' + v + ' (tight, half, full)'); return r; }
  if (typeof v === 'object') return sanitizedReflection({...defaultReflection(), ...v});
  throw bad('`reflection`: a preset, an object or null');
}
function parseBevel(v) {
  if (v === undefined) return undefined;
  if (v === null || v === false || v === 'none') return null;
  const b = sanitizedBevel(v);
  if (!b) throw bad('unknown bevel ' + (typeof v === 'string' ? v : v?.preset));
  return b;
}

const isPictureOrShape = o => isShape(o) || o?.type === 'image';

function effectsCmd(ctx, p) {
  const shadow = parseShadow(p.shadow), glow = parseGlow(p.glow), soft = parseSoft(p.softEdge), refl = parseReflection(p.reflection), bevel = parseBevel(p.bevel);
  const S = open(ctx);
  const hits = targets(S, isPictureOrShape);
  let last = null;
  for (const h of hits) {
    last = editAt(S, h.pos, o => {
      const e = {...(o.effects ?? {})};
      if (shadow !== undefined) { if (shadow === null) delete e.shadow; else e.shadow = shadow; }
      if (glow !== undefined) { if (glow === null) delete e.glow; else e.glow = glow; }
      if (soft !== undefined) { if (soft === null) delete e.softEdge; else e.softEdge = soft; }
      if (refl !== undefined) { if (refl === null) delete e.reflection; else e.reflection = refl; }
      if (bevel !== undefined) { if (bevel === null) delete e.bevel; else e.bevel = bevel; }
      const eff = sanitizedEffects(e);
      const out = {...o};
      if (shapeEffectsIsEmpty(eff)) delete out.effects; else out.effects = eff;
      // Room around the shape for its shadow and glow, as Word's effect extent.
      out.float = {...(o.float ?? P.defaultFloat()), effect: effectsExtent(eff, [o.w, o.h])};
      return out;
    });
  }
  return finish(ctx, S, {edit: true, result: {shapes: hits.length, effects: last?.effects ?? {}}});
}

// ---- Shape Styles (Quick Styles) ---------------------------------------------------------------------

const QS_NAMES = ['Dark 1', 'Accent 1', 'Accent 2', 'Accent 3', 'Accent 4', 'Accent 5', 'Accent 6'];
const QS_ROWS = ['Colored Outline', 'Colored Fill', 'Light 1 Outline, Colored Fill', 'Subtle Effect', 'Moderate Effect', 'Intense Effect'];

/**
 * The Shape Styles gallery's 42 styles (6 rows × Dark 1 and Accent 1–6) in the document's theme colours, as fill, outline and
 * effect: deckcraft's `quick_style_for` (cmd/shape/appearance.rs) resolved to colours (Word keeps a style reference). Rows:
 * Colored Outline (white fill), Colored Fill, Light 1 Outline Colored Fill (a tint, no outline), Subtle Effect, Moderate
 * Effect (with a shadow), Intense Effect (a darker fill, white outline).
 */
export function quickStyle(index, theme) {
  const slots = [0, 4, 5, 6, 7, 8, 9];
  const c = (theme?.[slots[index % 7]] ?? THEME_COLORS[slots[index % 7]]).slice(), white = (theme?.[1] ?? [255, 255, 255]).slice();
  switch (Math.floor(index / 7)) {
    case 0: return {fill: white, stroke: c, strokeWidth: 1.5, effects: null};
    case 1: return {fill: c, stroke: rgbModified(c, 'shade', 0.5), strokeWidth: 1, effects: null};
    case 2: return {fill: rgbModified(rgbModified(c, 'lumMod', 0.2), 'lumOff', 0.8), stroke: null, strokeWidth: 0.75, effects: null};
    case 3: return {fill: c, stroke: null, strokeWidth: 0.75, effects: null};
    case 4: return {fill: c, stroke: null, strokeWidth: 0.75, effects: {shadow: shadowPreset('offsetBottomRight')}};
    default: return {fill: rgbModified(c, 'lumMod', 0.75), stroke: white, strokeWidth: 1, effects: null};
  }
}

function quickStyleCmd(ctx, p) {
  const S = open(ctx);
  const i = Math.min(Math.max(Math.trunc(p.index ?? 1), 0), 41);
  const st = quickStyle(i, S.d.c.settings?.themeColors);
  const hits = targets(S, isShape);
  const last = editEach(S, hits, o => {
    const out = {...o, fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth};
    const eff = sanitizedEffects(st.effects ?? {});
    if (shapeEffectsIsEmpty(eff)) delete out.effects; else out.effects = eff;
    out.float = {...(o.float ?? P.defaultFloat()), effect: effectsExtent(eff, [o.w, o.h])};
    return out;
  });
  return finish(ctx, S, {edit: true, result: {object: last, count: hits.length, style: i}});
}

// ---- Change Shape --------------------------------------------------------------------------------------

/** The shapes Change Shape offers: the ones the page view draws as themselves. */
export const CHANGE_KINDS = Object.freeze([['rectangle', 'Rectangle'], ['roundedRectangle', 'Rectangle: Rounded Corners'], ['ellipse', 'Oval'], ['triangle', 'Isosceles Triangle'],
  ['rightTriangle', 'Right Triangle'], ['diamond', 'Diamond']].map(Object.freeze));

// ---- Text box commands ---------------------------------------------------------------------------------

/** The text box the Text group works on: the selected one, or the one whose text the caret is in (text_box_target). */
function textBoxTarget(S) {
  const hit = selectedIn(S.d, S.sel);
  if (hit && hit.obj.type === 'shape' && hit.obj.story !== undefined && hit.obj.story !== null && S.d.c.parts[hit.obj.story]?.kind === 'textBox') return {pos: hit.pos, id: hit.obj.story};
  const story = S.sel.focus.story;
  if (story === BODY || S.d.c.parts[story]?.kind !== 'textBox') return null;
  const after = S.d.textBoxAnchor(story);
  if (!after || after.off < 1) return null;
  return {pos: {...after, off: after.off - 1}, id: story};
}
const textBoxState = ctx => {
  const st = ready(ctx);
  if (!st.enabled) return st;
  try { return textBoxTarget(open(ctx)) ? {enabled: true} : {enabled: false, reason: NO_BOX}; } catch { return {enabled: false, reason: NO_BOX}; }
};
function bodyState(extra) {
  return ctx => {
    const st = textBoxState(ctx);
    if (!st.enabled) return st;
    try { const S = open(ctx); const t = textBoxTarget(S); return {...st, ...extra(S.d.c.parts[t.id].body ?? {})}; } catch { return st; }
  };
}

/** set_text_body: change the target text box's body (direction, alignment, link) and lay its paragraph out again. */
function setBody(ctx, f) {
  const S = open(ctx);
  const t = textBoxTarget(S);
  if (!t) throw disabled(NO_BOX);
  const body = {...{vert: 'horz', anchor: 'top', next: null, inset: null, autoFit: false}, ...(S.d.c.parts[t.id].body ?? {})};
  f(body, S, t);
  S.d.setTextBody(t.id, body);
  editAt(S, t.pos, o => ({...o}));
  return finish(ctx, S, {edit: true, result: {textBox: t.id, body}});
}

const DIRS = {horz: 'horz', horizontal: 'horz', vert: 'vert', rotate90: 'vert', vert270: 'vert270', rotate270: 'vert270', wordArtVert: 'stacked', stacked: 'stacked'};
const ANCHORS = {t: 'top', top: 'top', ctr: 'center', middle: 'center', center: 'center', b: 'bottom', bottom: 'bottom'};

function link(ctx, p) {
  const S = open(ctx);
  const t = textBoxTarget(S);
  if (!t) throw disabled(NO_BOX);
  if (S.d.c.parts[t.id].body?.next != null) throw new CommandError('failed', 'this text box is already linked: break the link first');
  // The target: a Selection Pane index (the nth drawing in the body) or a text box position.
  const boxes = [];
  for (const path of S.d.paraPaths(BODY)) {
    const para = S.d.para(BODY, path);
    for (const [off, o] of P.objectsWithOffsets(para)) if (P.isDrawing(o)) boxes.push({pos: {story: BODY, path, off}, obj: o});
  }
  let at = null;
  if (p.target === undefined || p.target === null) {
    // Without a target, the next empty text box no other box links to (the page view has no pointer mode for Create Link).
    const linked = new Set(S.d.textBoxChains().flatMap(c => c.slice(1)));
    at = boxes.find(b => b.obj.type === 'shape' && b.obj.story != null && b.obj.story !== t.id && S.d.c.parts[b.obj.story]?.kind === 'textBox'
      && !linked.has(b.obj.story) && !S.d.plainText(b.obj.story).trim() && !S.d.textBoxChain(t.id)?.includes(b.obj.story)) ?? null;
    if (!at) throw new CommandError('failed', 'there is no empty text box to link to: insert one first');
  } else if (Number.isInteger(p.target)) at = boxes[p.target] ?? null;
  else if (p.target && typeof p.target === 'object') at = boxes.find(b => b.pos.story === p.target.story && b.pos.off === p.target.off && b.pos.path.join('.') === (p.target.path ?? []).join('.')) ?? null;
  if (!at) throw bad('no object there');
  const to = at.obj.type === 'shape' && S.d.c.parts[at.obj.story]?.kind === 'textBox' ? at.obj.story : null;
  if (to === null) throw bad("the target isn't a text box");
  if (to === t.id || S.d.textBoxChain(t.id)?.includes(to)) throw new CommandError('failed', "a text box can't link to itself or to a box its text already runs through");
  if (S.d.textBoxChains().some(c => c.slice(1).includes(to))) throw new CommandError('failed', 'another text box already links to that one');
  if (S.d.plainText(to).trim()) throw new CommandError('failed', 'the text box to link to must be empty');
  const body = {...{vert: 'horz', anchor: 'top', next: null, inset: null, autoFit: false}, ...(S.d.c.parts[t.id].body ?? {}), next: to};
  S.d.setTextBody(t.id, body);
  editAt(S, t.pos, o => ({...o}));
  editAt(S, at.pos, o => ({...o}));
  return finish(ctx, S, {edit: true, result: {textBox: t.id, next: to}});
}

// ---- Drawing Canvas ------------------------------------------------------------------------------------

const MAX_SIDE = 4000, MIN_SIDE = 9;
/** The members' bounds [x0, y0, x1, y1], or null when the canvas is empty. */
function memberBounds(children) {
  let out = null;
  for (const c of children) {
    const fr = P.objectFrame(c.obj);
    if (!fr) continue;
    const b = [fin(c.x), fin(c.y), fin(c.x) + fin(fr[0]), fin(c.y) + fin(fr[1])];
    out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : b;
  }
  return out;
}
function editCanvas(ctx, f) {
  const {S, pos} = target(ctx, o => (P.isCanvas(o) ? null : NO_CANVAS), NO_CANVAS);
  const next = editAt(S, pos, o => {
    const out = {...o, children: (o.children ?? []).map(c => ({...c}))};
    f(out);
    out.w = clamp(fin(out.w), MIN_SIDE, MAX_SIDE);
    out.h = clamp(fin(out.h), MIN_SIDE, MAX_SIDE);
    out.ch_w = out.w; out.ch_h = out.h;
    return out;
  });
  return finish(ctx, S, {edit: true, result: {object: next}});
}

export default defineCommands({
  family: 'objects/shape',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'shape.fill', label: 'Shape Fill', risk: 'edit', state: shapeOrCanvasState,
      description: 'Shape Fill (Shape Format › Shape Styles): `color` RRGGBB (or null for no fill) with its `transparency` percent, or a `gradient` {stops: [{pos, color, transparency?}], type?: linear|radial|rectangular|path, angle?, focus?, tile?, scaled?, rotateWithShape?}, for every selected shape, text box and canvas background; a colour alone keeps the shape\'s transparency.',
      params: s.object({color: s.optional(s.nullable(COLOR)), transparency: s.optional(s.number({min: 0, max: 100})), gradient: s.optional(s.nullable(s.any()))}),
      run: fillCmd},
    ...['light', 'dark'].map((set, k) => ({id: set === 'light' ? 'shape.lightVariation' : 'shape.darkVariation', label: set === 'light' ? 'Light Variations' : 'Dark Variations', risk: 'edit',
      state: ctx => {
        const st = shapeOrCanvasState(ctx);
        if (!st.enabled) return st;
        let main = (ctx.doc?.settings?.themeColors ?? [])[4] ?? [68, 114, 196];
        try { const S = open(ctx); const o = selectedIn(S.d, S.sel)?.obj; const f = o?.type === 'group' ? o.canvas?.fill : o?.fill; if (f) main = fillMainColor(f); } catch { /* the accent */ }
        return {...st, value: variations(main)[k].map(({fill, name}, i) => ({id: String(i), label: name, value: fillParams(fill).gradient, art: {kind: 'gradient', fill}, iconOnly: true}))};
      },
      description: (set === 'light' ? 'Light' : 'Dark') + ' Variations (Shape Format › Shape Fill › Gradient): one of the 13 gradients of the shape\'s colour, as shape.fill.',
      params: s.object({gradient: s.optional(s.any())}),
      run: (ctx, p) => fillCmd(ctx, {gradient: p.gradient})})),
    {id: 'shape.outline', label: 'Shape Outline', risk: 'edit', state: shapeOrCanvasState,
      description: 'Shape Outline (Shape Format › Shape Styles): `color` RRGGBB (null: no outline) and `width` in points (0–72) of the selected shape, text box or canvas border.',
      params: s.object({color: s.optional(s.nullable(COLOR)), width: s.optional(s.number({min: 0, max: 72}))}),
      run: outlineCmd},
    {id: 'shape.effects', label: 'Shape Effects', risk: 'edit', state: stateFor(o => (isPictureOrShape(o) ? null : NO_SHAPE), 'select a picture or shape first'),
      description: 'Shape Effects (Shape Format › Shape Styles): `shadow` a preset (' + SHADOW_PRESETS.map(p => p[0]).join(', ') + ') or {preset?, color?, transparency?, blur?, distance?, angle?} or null, `glow` points or {color?, size?, transparency?} or null, `softEdge` points or null, `reflection` tight, half, full, {blur?, startAlpha?, endAlpha?, endPos?, dist?} or null, `bevel` relaxedInset, circle, slope, cross, angle, softRound, convex, coolSlant, divot, riblet, hardEdge, artDeco, {preset, w?, h?} or null; an omitted key is left as it is; every selected picture or shape (Picture Effects are the same effects).',
      params: s.object({shadow: s.optional(s.nullable(s.any())), glow: s.optional(s.nullable(s.any())), softEdge: s.optional(s.nullable(s.number({min: 0, max: 100}))), reflection: s.optional(s.nullable(s.any())), bevel: s.optional(s.nullable(s.any()))}),
      run: effectsCmd},
    {id: 'shape.quickStyle', label: 'Shape Styles', risk: 'edit',
      state: ctx => {
        const st = shapeState(ctx);
        if (!st.enabled) return st;
        const theme = ctx.doc?.settings?.themeColors;
        return {...st, value: Array.from({length: 42}, (_, i) => { const q = quickStyle(i, theme); return {id: String(i), label: QS_ROWS[Math.floor(i / 7)] + ' - ' + QS_NAMES[i % 7], group: QS_ROWS[Math.floor(i / 7)], value: i, art: {kind: 'shapeStyle', fill: q.fill, line: q.stroke, lineWidth: q.strokeWidth, shadow: !!q.effects?.shadow}, iconOnly: true}; })};
      },
      description: 'Shape Styles (Shape Format): `index` 0–41, the row (Colored Outline, Colored Fill, Light 1 Outline Colored Fill, Subtle, Moderate, Intense Effect) times Dark 1 and Accent 1–6, in the theme colours; the fill, outline and effect of the selected shapes. Not in wordcraft: from deckcraft quick_style_for.',
      params: s.object({index: s.optional(s.integer({min: 0, max: 41}))}),
      run: quickStyleCmd},
    {id: 'shape.change', label: 'Change Shape', risk: 'edit',
      state: ctx => { const st = shapeState(ctx); return st.enabled ? {...st, value: CHANGE_KINDS.map(([id, label]) => ({id, label, value: id}))} : st; },
      description: 'Change Shape (Shape Format › Insert Shapes › Edit Shape): the selected shape becomes another kind (' + CHANGE_KINDS.map(k => k[0]).join(', ') + ').',
      params: s.object({kind: s.optional(s.enum(P.SHAPE_KINDS))}),
      run(ctx, p) {
        const {S, pos} = target(ctx, o => (isShape(o) ? null : NO_SHAPE), NO_SHAPE);
        const kind = p.kind ?? 'rectangle';
        const next = editAt(S, pos, o => ({...o, kind}));
        return finish(ctx, S, {edit: true, result: {object: next}});
      }},
    {id: 'shape.textDirection', label: 'Text Direction', risk: 'edit',
      state: bodyState(b => ({value: b.vert ?? 'horz'})),
      description: 'Text Direction (Shape Format › Text): `dir` horz, vert (rotate all text 90°), vert270 or wordArtVert (stacked) for the selected text box or the one the caret is in.',
      params: s.object({dir: s.optional(s.enum(Object.keys(DIRS)))}),
      run(ctx, p) { const v = DIRS[p.dir ?? 'horz']; return setBody(ctx, b => { b.vert = v; }); }},
    {id: 'shape.alignText', label: 'Align Text', risk: 'edit',
      state: bodyState(b => ({value: b.anchor ?? 'top'})),
      description: 'Align Text (Shape Format › Text): `anchor` t, ctr or b, the top, middle or bottom of the text box (for turned text, from the side its lines start on).',
      params: s.object({anchor: s.optional(s.enum(Object.keys(ANCHORS)))}),
      run(ctx, p) { const a = ANCHORS[p.anchor ?? 't']; return setBody(ctx, b => { b.anchor = a; }); }},
    {id: 'shape.link', label: 'Create Link', risk: 'edit',
      state: ctx => { const st = textBoxState(ctx); if (!st.enabled) return st; try { const S = open(ctx); const t = textBoxTarget(S); return S.d.c.parts[t.id].body?.next != null ? {enabled: false, reason: 'this text box is already linked: break the link first'} : st; } catch { return st; } },
      description: 'Create Link (Shape Format › Text): the selected text box\'s text continues in `target`, an empty text box (its position or Selection Pane index) no other box links to.',
      params: s.object({target: s.optional(s.any())}),
      run: link},
    {id: 'shape.breakLink', label: 'Break Link', risk: 'edit',
      state: ctx => { const st = textBoxState(ctx); if (!st.enabled) return st; try { const S = open(ctx); const t = textBoxTarget(S); return S.d.c.parts[t.id].body?.next != null ? st : {enabled: false, reason: "this text box isn't linked to another"}; } catch { return st; } },
      description: 'Break Link (Shape Format › Text): the text stops at the end of the selected box; the boxes after it go back to their own text.',
      params: s.object({}),
      run: ctx => setBody(ctx, (b, S, t) => { if (b.next == null) throw disabled("this text box isn't linked to another"); b.next = null; })},
    {id: 'canvas.fit', label: 'Fit', risk: 'edit', state: canvasState,
      description: 'Fit (Shape Format › Drawing Canvas): shrinks the selected canvas\'s frame to its drawing; the members move to its top-left corner.',
      params: s.object({}),
      run: ctx => editCanvas(ctx, o => {
        const b = memberBounds(o.children);
        if (!b) return;
        for (const c of o.children) { c.x = clamp(fin(c.x) - b[0], -MAX_SIDE, MAX_SIDE); c.y = clamp(fin(c.y) - b[1], -MAX_SIDE, MAX_SIDE); }
        o.w = b[2] - b[0]; o.h = b[3] - b[1];
      })},
    {id: 'canvas.expand', label: 'Expand', risk: 'edit', state: canvasState,
      description: 'Expand (Shape Format › Drawing Canvas): grows the frame right and down by `by` points (default 36); at least enough to show every member.',
      params: s.object({by: s.optional(s.number({min: 0, max: MAX_SIDE}))}),
      run: (ctx, p) => editCanvas(ctx, o => {
        const by = clamp(p.by ?? 36, 0, MAX_SIDE), b = memberBounds(o.children) ?? [0, 0, 0, 0];
        o.w = Math.max(o.w + by, b[2]); o.h = Math.max(o.h + by, b[3]);
      })},
    {id: 'canvas.scale', label: 'Scale Drawing', risk: 'edit', state: canvasState,
      description: 'Scale Drawing (Shape Format › Drawing Canvas): scales the frame and every member together by `factor` (0.1–10).',
      params: s.object({factor: s.number({min: 0.1, max: 10})}),
      run: (ctx, p) => editCanvas(ctx, o => {
        const k = p.factor;
        o.w *= k; o.h *= k;
        for (const c of o.children) {
          c.x = clamp(fin(c.x) * k, -MAX_SIDE, MAX_SIDE); c.y = clamp(fin(c.y) * k, -MAX_SIDE, MAX_SIDE);
          const fr = P.objectFrame(c.obj);
          if (fr) c.obj = P.setObjectSize(c.obj, clamp(fr[0] * k, 1, MAX_SIDE), clamp(fr[1] * k, 1, MAX_SIDE));
        }
      })},
  ],
});
