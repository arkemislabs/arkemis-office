// Shape Format leftovers (U:quill/rest): Shape Fill › Picture and Texture, Shape Effects › Preset.
//
// Not checked against upstream (wordcraft has no engine for them; each follows Word):
// - Picture: the shape (text box, canvas background) filled with a picture from a file, stretched over it (`fill` {type: 'picture', media,
//   tile, scale, transparency}); saved as DrawingML a:blipFill. Texture: the same fill, tiled, from one of Word's 24 texture names drawn
//   by core/quill/lib/textures.mjs (our own drawings; Word's are photographs).
// - Preset: twelve combinations of the effects the page view draws (shadow, glow, reflection, bevel), as Word's twelve presets of that
//   gallery do with its richer set; "No Preset" takes all effects off.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import * as P from '../../model/para.mjs';
import {sanitizedFill} from '../../model/fill.mjs';
import {shadowPreset, reflectionPreset, bevelPreset, sanitizedEffects, shapeEffectsIsEmpty, effectsExtent, defaultGlow} from '../../model/effects.mjs';
import {bytesOf, base64Encode, imageExt, probe} from '../../lib/insert-objects.mjs';
import {encodePng} from '../../lib/picture-host.mjs';
import {isConnector, sites, sitePoint, floatSpin, rerouteGroup} from '../../model/connector.mjs';
import {TEXTURES, textureBitmap, textureInfo, averageColor} from '../../lib/textures.mjs';
import {pickedAll, stateFor, target, editAt, finish, open, isShape, isShapeOrCanvas, disabled, NO_SHAPE} from '../../lib/object-edit.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/shape_fill.rs']};
const MAX_TARGETS = 10_000;
const NONE = s.object({});
const bad = m => new CommandError('invalid_params', m);
const shapeOrCanvasState = stateFor(o => (isShapeOrCanvas(o) ? null : NO_SHAPE), NO_SHAPE);
const effectsState = stateFor(o => (isShape(o) || o?.type === 'image' ? null : NO_SHAPE), 'select a picture or shape first');

function targets(S, want) {
  const out = pickedAll(S).slice(0, MAX_TARGETS).filter(h => want(h.obj));
  if (!out.length) throw disabled('no shape selected');
  return out;
}

async function fillPicture(ctx, p) {
  let bytes;
  if (typeof p.data === 'string') { bytes = bytesOf(p.data); if (!bytes) throw bad('bad base64 data'); }
  else if (typeof p.path === 'string') {
    if (typeof ctx.host?.readFile !== 'function') throw new CommandError('unavailable', 'reading a picture by path is not available here; pass `data` (base64)');
    const got = await ctx.host.readFile(p.path);
    bytes = typeof got === 'string' ? bytesOf(got) : new Uint8Array(got);
  } else throw bad('`data` (base64) is required: Picture… picks the file in the window');
  const got = probe(bytes);
  if (got.notPicture) throw new CommandError('failed', 'not a supported image');
  if (got.refused) throw new CommandError('failed', got.refused);
  const S = open(ctx);
  const media = S.d.addMedia(base64Encode(bytes), imageExt(bytes));
  const fill = sanitizedFill({type: 'picture', media, tile: !!p.tile, scale: p.scale ?? 100, transparency: p.transparency ?? 0});
  return setFillIn(ctx, S, fill);
}

/** setFill over a session that already holds the new media. */
function setFillIn(ctx, S, fill) {
  const hits = targets(S, isShapeOrCanvas);
  let last = null;
  for (const h of hits) last = editAt(S, h.pos, o => (o.type === 'group' ? {...o, canvas: {...(o.canvas ?? {}), fill}} : {...o, fill}));
  return finish(ctx, S, {edit: true, result: {object: last, count: hits.length}});
}

async function fillTexture(ctx, p) {
  const info = textureInfo(p.texture);
  if (!info) throw bad('unknown texture `' + p.texture + '`');
  const bmp = textureBitmap(info[0], 64);
  const png = await encodePng(ctx.host, bmp);
  const S = open(ctx);
  const media = S.d.addMedia(base64Encode(png), 'png');
  const fill = sanitizedFill({type: 'picture', media, tile: true, scale: 100, transparency: 0, avg: averageColor(bmp), texture: info[0]});
  return setFillIn(ctx, S, fill);
}

// ---- Preset effects -----------------------------------------------------------------------------------

/** The twelve presets: [label, effects]; the sample the gallery draws is the shadow and glow of each. */
const accent = () => defaultGlow().color;
export const EFFECT_PRESETS = Object.freeze([
  ['Preset 1', () => ({shadow: shadowPreset('offsetBottomRight')})],
  ['Preset 2', () => ({shadow: {...shadowPreset('offsetBottom'), blur: 8, distance: 6, transparency: 70}})],
  ['Preset 3', () => ({glow: {...defaultGlow(), size: 5}})],
  ['Preset 4', () => ({glow: {...defaultGlow(), size: 12, transparency: 50}})],
  ['Preset 5', () => ({reflection: reflectionPreset('tight')})],
  ['Preset 6', () => ({reflection: reflectionPreset('half'), shadow: shadowPreset('offsetBottomRight')})],
  ['Preset 7', () => ({bevel: bevelPreset('circle')})],
  ['Preset 8', () => ({bevel: bevelPreset('softRound'), shadow: shadowPreset('offsetBottomRight')})],
  ['Preset 9', () => ({bevel: bevelPreset('slope'), reflection: reflectionPreset('tight')})],
  ['Preset 10', () => ({bevel: bevelPreset('angle'), glow: {...defaultGlow(), color: accent(), size: 5}})],
  ['Preset 11', () => ({bevel: bevelPreset('artDeco'), shadow: shadowPreset('offsetBottom')})],
  ['Preset 12', () => ({bevel: bevelPreset('coolSlant'), reflection: reflectionPreset('half'), shadow: shadowPreset('offsetBottomRight')})],
].map(Object.freeze));

function effectPreset(ctx, p) {
  const n = p.preset === 'none' || p.preset === 0 ? 0 : Number(p.preset);
  if (!(n === 0 || (Number.isInteger(n) && n >= 1 && n <= EFFECT_PRESETS.length))) throw bad('`preset` is none or 1 to ' + EFFECT_PRESETS.length);
  const S = open(ctx);
  const hits = targets(S, o => isShape(o) || o?.type === 'image');
  let last = null;
  for (const h of hits) {
    last = editAt(S, h.pos, o => {
      const eff = n === 0 ? {} : sanitizedEffects(EFFECT_PRESETS[n - 1][1]());
      const out = {...o};
      if (shapeEffectsIsEmpty(eff)) delete out.effects; else out.effects = eff;
      out.float = {...(o.float ?? P.defaultFloat()), effect: effectsExtent(eff, [o.w, o.h])};
      return out;
    });
  }
  return finish(ctx, S, {edit: true, result: {shapes: hits.length, effects: last?.effects ?? {}}});
}

// ---- Reroute Connectors -------------------------------------------------------------------------------

/** The drawing canvas whose connectors are rerouted: the selected one, with how many of its connectors are glued at both ends. */
const canvasWithGlued = o => {
  if (!P.isCanvas(o)) return 0;
  return (o.children ?? []).filter(c => c.obj?.type === 'shape' && isConnector(c.obj.kind) && c.obj.extra?.start && c.obj.extra?.end).length;
};

/** Each glued connector of the canvas takes the closest pair of connection sites of the two shapes it joins, then follows them. */
function rerouteConnectors(ctx) {
  const {S, pos, obj} = target(ctx, o => (canvasWithGlued(o) ? null : 'select a drawing canvas with connectors glued to its shapes'), 'select a drawing canvas first');
  const shapes = new Map();
  for (const c of obj.children ?? []) if (c.obj?.type === 'shape' && c.obj.extra?.id) shapes.set(c.obj.extra.id, c);
  let changed = 0;
  const next = editAt(S, pos, o => {
    const children = o.children.map(c => {
      const x = c.obj;
      if (x?.type !== 'shape' || !isConnector(x.kind) || !x.extra?.start || !x.extra?.end) return c;
      const a = shapes.get(x.extra.start.id), b = shapes.get(x.extra.end.id);
      if (!a || !b || a === b) return c;
      const frame = k => [k.x, k.y, k.obj.w, k.obj.h];
      let best = null;
      const na = sites(a.obj.kind, a.obj.w, a.obj.h).length, nb = sites(b.obj.kind, b.obj.w, b.obj.h).length;
      for (let i = 0; i < na; i++) {
        const pa = sitePoint(a.obj.kind, frame(a), floatSpin(a.obj.float), i);
        for (let j = 0; j < nb && pa; j++) {
          const pb = sitePoint(b.obj.kind, frame(b), floatSpin(b.obj.float), j);
          const d = pb ? Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) : Infinity;
          if (!best || d < best.d - 1e-9) best = {i, j, d};
        }
      }
      if (!best || (best.i === x.extra.start.site && best.j === x.extra.end.site)) return c;
      changed++;
      return {...c, obj: {...x, extra: {...x.extra, start: {...x.extra.start, site: best.i}, end: {...x.extra.end, site: best.j}}}};
    });
    return rerouteGroup({...o, children});
  });
  return finish(ctx, S, {edit: true, result: {object: next, rerouted: changed}});
}

export default defineCommands({
  family: 'objects/shape-rest',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'shape.rerouteConnectors', label: 'Reroute Connectors', risk: 'edit',
      state: stateFor(o => (canvasWithGlued(o) ? null : 'select a drawing canvas with connectors glued to its shapes'), 'select a drawing canvas first'),
      description: 'Reroute Connectors (Shape Format › Edit Shape): every connector of the selected drawing canvas that is glued to a shape at both ends takes the closest pair of connection sites of those two shapes, and follows them. Not checked against upstream.',
      params: NONE, run: rerouteConnectors},
    {id: 'shape.fillPicture', label: 'Picture Fill', risk: 'edit', state: shapeOrCanvasState,
      description: 'Picture (Shape Format › Shape Fill): every selected shape, text box and canvas background filled with a picture (`data` base64 or a data URL, or `path`), stretched over it or, with `tile`, repeated at `scale` percent; `transparency` percent. Not checked against upstream.',
      params: s.object({data: s.optional(s.string({max: 300_000_000})), path: s.optional(s.string({max: 4096})), tile: s.optional(s.boolean()), scale: s.optional(s.number({min: 1, max: 1000})), transparency: s.optional(s.number({min: 0, max: 100}))}),
      run: fillPicture},
    {id: 'shape.fillTexture', label: 'Texture Fill', risk: 'edit',
      state: ctx => {
        const st = shapeOrCanvasState(ctx);
        return st.enabled ? {...st, value: TEXTURES.map(([id, label]) => ({id, label, value: id, art: {kind: 'texture', id}, iconOnly: false}))} : st;
      },
      description: 'Texture (Shape Format › Shape Fill): the shape filled with one of the 24 textures (papyrus, canvas, denim, woven-mat, water-droplets, paper-bag, fish-fossil, sand, green-marble, white-marble, brown-marble, granite, newsprint, recycled-paper, parchment, stationery, blue-tissue-paper, pink-tissue-paper, purple-mesh, bouquet, cork, walnut, oak, medium-wood), tiled. Not checked against upstream.',
      params: s.object({texture: s.enum(TEXTURES.map(t => t[0]))}),
      run: fillTexture},
    {id: 'shape.effectPreset', label: 'Preset Effects', risk: 'edit',
      state: ctx => {
        const st = effectsState(ctx);
        return st.enabled ? {...st, value: [{id: 'none', label: 'No Preset', value: 'none', iconOnly: false}, ...EFFECT_PRESETS.map(([label, make], i) => {
          const e = make();
          return {id: String(i + 1), label, value: i + 1, art: {kind: 'effect', line: 1, shadow: e.shadow ? {blur: e.shadow.blur, dist: e.shadow.distance, alpha: 1 - e.shadow.transparency / 100} : null, glow: e.glow ? e.glow.size : null, flat: !!e.bevel}, iconOnly: true};
        })]} : st;
      },
      description: 'Preset (Shape Format and Picture Format › Effects): one of 12 combinations of shadow, glow, reflection and bevel on every selected shape or picture, or `none` for no effects at all. Not checked against upstream.',
      params: s.object({preset: s.union([s.integer({min: 0, max: 12}), s.enum(['none'])])}),
      run: effectPreset},
  ],
});
