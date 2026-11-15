// Shape Effects › Preset and the text effects Glow, Reflection, Bevel and 3-D Rotation (Format > WordArt Styles > Text Effects).
// PowerPoint's behaviour, not checked against upstream (deckcraft draws no text reflection, glow, bevel or 3-D rotation, and its
// shapes' 3-D camera and bevel are kept but not drawn; here the slide draws them: core/prism/lib/camera3d.mjs,
// src/apps/prism/surface/SlideView.tsx and effects.tsx).
//
// - `shape.effectPreset {index}` clears a shape's (or picture's) effects and applies one of the twelve presets (a shadow or a
//   reflection or a glow, a bevel, a 3-D rotation with a depth: core/prism/lib/camera3d.mjs EFFECT_PRESETS).
// - `format.textEffects {glow?, reflection?, bevel?, threeD?}`: glow and reflection are properties of the runs of the selected text (or all
//   the text of the selected shapes), as the file keeps them (`a:effectLst` of the run); bevel and 3-D rotation belong to the shape's text
//   (`a:bodyPr`'s `a:scene3d` and `a:sp3d`, `text.body.raw3d`).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasSelection, hasTextOrShapes, colorScheme, colorValue, clamp} from '../lib/shape-common.mjs';
import {formatRun, formatBody} from '../lib/format-text.mjs';
import {colorWith} from '../model/style.mjs';
import {parse3d, apply3d, to3dXml, flat3d, BEVELS} from '../lib/three-d.mjs';
import {EFFECT_PRESETS, CAMERA_MENU} from '../lib/camera3d.mjs';

/** The tiles of the Preset gallery: a sample shape with each preset's shadow, bevel, glow, reflection and 3-D rotation drawn on it. */
const presetTiles = () => [{id: 'none', label: 'No Presets', value: 0, art: {kind: 'shape3d', none: true}, iconOnly: false},
  ...EFFECT_PRESETS.map((e, i) => ({id: String(i + 1), label: `Preset ${i + 1}`, value: i + 1, group: 'Presets', iconOnly: false,
    art: {kind: 'shape3d', camera: e.threeD?.camera ?? null, depth: e.threeD?.depth ?? 0, bevel: !!e.bevel, shadow: e.shadow ?? null, glow: !!e.glow, reflection: !!e.reflection}}))];
/** The tiles of a 3-D Rotation gallery: a sample shape turned by each camera preset, under Parallel, Perspective and Oblique. */
const rotationTiles = () => [{id: 'orthographicFront', label: 'No Rotation', value: 'orthographicFront', art: {kind: 'shape3d'}, iconOnly: false},
  ...CAMERA_MENU.flatMap(g => g.items.map(([camera, label]) => ({id: camera, label, value: camera, group: g.group, art: {kind: 'shape3d', camera, depth: 6}, iconOnly: false})))];

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/three_d.rs', 'crates/engine/src/cmd/text_effects.rs']};
const accentGlow = () => colorWith(colorScheme('accent1'), {op: 'alpha', val: 40000});
const REFLECTIONS = {
  tight: {blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.35, dist: 0},
  half: {blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.55, dist: 4},
  full: {blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.9, dist: 4},
};
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function textEffects(ctx, p) {
  const C = 'format.textEffects';
  let glow;
  if (p.glow !== undefined) {
    if (p.glow === null || p.glow === 0 || p.glow === 'none') glow = null;
    else if (typeof p.glow === 'number') glow = {color: accentGlow(), radius: clamp(p.glow, 0, 150)};
    else if (isObj(p.glow)) glow = {color: colorValue(p.glow.color) ?? accentGlow(), radius: clamp(typeof p.glow.radius === 'number' ? p.glow.radius : 8, 0, 150)};
    else throw bad(C, '`glow` is a radius in points, {radius, color} or null');
  }
  let refl;
  if (p.reflection !== undefined) {
    if (p.reflection === 'none' || p.reflection === null) refl = null;
    else if (REFLECTIONS[p.reflection]) refl = {...REFLECTIONS[p.reflection]};
    else throw bad(C, '`reflection` is none, tight, half or full');
  }
  if (p.bevel !== undefined && p.bevel !== 'none' && !BEVELS.includes(p.bevel)) throw bad(C, `unknown bevel \`${p.bevel}\``);
  if (p.threeD !== undefined && !isObj(p.threeD)) throw bad(C, '`threeD` is an object: {camera?, rotX?, rotY?, rotZ?, depth?, reset?}');
  if (glow !== undefined || refl !== undefined) {
    formatRun(ctx, C, r => {
      const o = {...r};
      if (glow !== undefined) { if (glow && glow.radius > 0) o.glow = structuredClone(glow); else delete o.glow; }
      if (refl !== undefined) { if (refl) o.reflection = refl; else delete o.reflection; }
      return o;
    });
  }
  if (p.bevel !== undefined || p.threeD !== undefined) {
    formatBody(ctx, C, b => {
      const s3 = parse3d(b.raw3d);
      if (p.threeD?.reset === true) Object.assign(s3, flat3d());
      if (p.bevel !== undefined) apply3d(s3, {bevelTop: p.bevel});
      if (p.threeD) apply3d(s3, p.threeD);
      const xml = to3dXml(s3);
      if (xml) b.raw3d = xml; else delete b.raw3d;
      return b;
    });
  }
  return {};
}

export default defineCommands({
  family: 'effects3d',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'shape.effectPreset', label: 'Preset', risk: 'edit',
      state: ctx => { const st = hasSelection(ctx); return st.enabled ? {...st, value: presetTiles()} : st; },
      description: 'Shape Effects › Preset: clear the effects of the selected shapes (`ids`) and apply preset `index` (0 is No Presets, 1..12: a shadow, reflection or glow, a bevel and, from 8 on, a 3-D rotation with a depth). Not checked against upstream.',
      params: s.object({index: s.integer({min: 0, max: EFFECT_PRESETS.length}), ids: s.optional(s.array(s.any(), {max: 5000})), id: s.optional(s.any())}),
      async run(ctx, p) {
        const target = {...(p.ids ? {ids: p.ids} : {}), ...(p.id !== undefined ? {id: p.id} : {})};
        await ctx.run('shape.effects', {...target, reset: true});
        if (p.index > 0) await ctx.run('shape.effects', {...target, ...EFFECT_PRESETS[p.index - 1]});
        return {index: p.index};
      },
    },
    {
      id: 'shape.rotation3d', label: '3-D Rotation', risk: 'edit',
      state: ctx => { const st = hasSelection(ctx); return st.enabled ? {...st, value: rotationTiles()} : st; },
      description: '{camera: orthographicFront|isometricLeftDown|perspectiveRelaxed|obliqueTopLeft|… (a 3-D Rotation preset), ids?}: Shape Format › Shape Effects › 3-D Rotation: turn the selected shapes by a camera preset (orthographicFront is No Rotation). Not checked against upstream.',
      params: s.object({camera: s.string({max: 48}), ids: s.optional(s.array(s.any(), {max: 5000})), id: s.optional(s.any())}),
      run: (ctx, p) => ctx.run('shape.effects', {...(p.ids ? {ids: p.ids} : {}), ...(p.id !== undefined ? {id: p.id} : {}), threeD: {camera: p.camera}}),
    },
    {
      id: 'format.textRotation3d', label: '3-D Rotation', risk: 'edit',
      state: ctx => { const st = hasTextOrShapes(ctx); return st.enabled ? {...st, value: rotationTiles()} : st; },
      description: '{camera: a 3-D Rotation preset (orthographicFront is No Rotation)}: Shape Format › Text Effects › 3-D Rotation: turn the text of the selected shapes by a camera preset. Not checked against upstream.',
      params: s.object({camera: s.string({max: 48})}),
      run: (ctx, p) => ctx.run('format.textEffects', {threeD: {camera: p.camera}}),
    },
    {
      id: 'format.textEffects', label: 'Text Effects', risk: 'edit', state: hasTextOrShapes,
      description: '{glow?: pt radius | {radius, color} | null, reflection?: none|tight|half|full, bevel?: none|circle|…, threeD?: {camera?, rotX?, rotY?, rotZ?, depth?, reset?}}: the glow and reflection of the selected text (else all the text of the selected shapes), the bevel and 3-D rotation of the text of the selected shapes. Not checked against upstream.',
      params: s.object({glow: s.optional(s.any()), reflection: s.optional(s.any()), bevel: s.optional(s.any()), threeD: s.optional(s.any())}),
      run: textEffects,
    },
  ],
});
