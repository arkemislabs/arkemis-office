// Picture Format › Picture Styles: PowerPoint's quick styles for pictures, each a frame (shape,
// outline) and effects applied as one step, replacing the previous style.
// Translated from deckcraft crates/engine/src/cmd/picture_style.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, always, hasSelection, editShapes, lineNoneFull, lineDefault, effectsDefault, colorRgb, fillSolid, colorWith} from '../lib/shape-common.mjs';
import {effectsEmpty} from '../model/style.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/picture_style.rs']};

/** (id, label), in PowerPoint's gallery order. */
export const STYLES = Object.freeze([
  ['simpleFrameWhite', 'Simple Frame, White'], ['beveledMatteWhite', 'Beveled Matte, White'], ['metalFrame', 'Metal Frame'],
  ['dropShadowRectangle', 'Drop Shadow Rectangle'], ['roundedDiagonalCornerWhite', 'Rounded Diagonal Corner, White'],
  ['snipDiagonalCornerWhite', 'Snip Diagonal Corner, White'], ['moderateFrameWhite', 'Moderate Frame, White'], ['rotatedWhite', 'Rotated, White'],
  ['perspectiveShadowWhite', 'Perspective Shadow, White'], ['softEdgeRectangle', 'Soft Edge Rectangle'], ['doubleFrameBlack', 'Double Frame, Black'],
  ['thickMatteBlack', 'Thick Matte, Black'], ['simpleFrameBlack', 'Simple Frame, Black'], ['beveledOvalBlack', 'Beveled Oval, Black'],
  ['compoundFrameBlack', 'Compound Frame, Black'], ['centerShadowRectangle', 'Center Shadow Rectangle'], ['softEdgeOval', 'Soft Edge Oval'],
  ['reflectedRoundedRectangle', 'Reflected Rounded Rectangle'], ['reflectedBevelWhite', 'Reflected Bevel, White'],
  ['metalRoundedRectangle', 'Metal Rounded Rectangle'], ['moderateFrameBlack', 'Moderate Frame, Black'], ['bevelRectangle', 'Bevel Rectangle'],
  ['bevelPerspective', 'Bevel Perspective'], ['metalOval', 'Metal Oval'],
]);

const WHITE = {r: 255, g: 255, b: 255, a: 255}, BLACK = {r: 0, g: 0, b: 0, a: 255}, SILVER = {r: 0xc0, g: 0xc0, b: 0xc0, a: 255};
const l = (preset, frame, shadow, extra = {}) => ({preset, frame, shadow, softEdge: null, reflection: false, bevel: null, rot: null, ...extra});
/** `look`: a style's geometry, outline (colour, width) and effects. */
export function look(id) {
  switch (id) {
    case 'simpleFrameWhite': return l('rect', [WHITE, 7], 'soft');
    case 'beveledMatteWhite': return l('rect', [WHITE, 6], 'soft', {bevel: 'circle'});
    case 'metalFrame': return l('rect', [SILVER, 7], 'soft', {bevel: 'angle'});
    case 'dropShadowRectangle': return l('rect', null, 'drop');
    case 'roundedDiagonalCornerWhite': return l('round2DiagRect', [WHITE, 6], 'soft');
    case 'snipDiagonalCornerWhite': return l('snip2DiagRect', [WHITE, 6], 'soft');
    case 'moderateFrameWhite': return l('rect', [WHITE, 4.5], 'soft');
    case 'rotatedWhite': return l('rect', [WHITE, 6], 'soft', {rot: 356});
    case 'perspectiveShadowWhite': return l('rect', [WHITE, 4], 'perspective');
    case 'softEdgeRectangle': return l('rect', null, null, {softEdge: 10});
    case 'doubleFrameBlack': return l('rect', [BLACK, 6], null);
    case 'thickMatteBlack': return l('rect', [BLACK, 10], 'soft');
    case 'simpleFrameBlack': return l('rect', [BLACK, 5], null);
    case 'beveledOvalBlack': return l('ellipse', [BLACK, 4], 'soft', {bevel: 'circle'});
    case 'compoundFrameBlack': return l('rect', [BLACK, 4.5], null);
    case 'centerShadowRectangle': return l('rect', null, 'center');
    case 'softEdgeOval': return l('ellipse', null, null, {softEdge: 12});
    case 'reflectedRoundedRectangle': return l('roundRect', null, null, {reflection: true});
    case 'reflectedBevelWhite': return l('rect', [WHITE, 4], null, {reflection: true, bevel: 'circle'});
    case 'metalRoundedRectangle': return l('roundRect', [SILVER, 6], 'soft', {bevel: 'angle'});
    case 'moderateFrameBlack': return l('rect', [BLACK, 4.5], 'soft');
    case 'bevelRectangle': return l('rect', null, 'soft', {bevel: 'angle'});
    case 'bevelPerspective': return l('rect', null, 'perspective', {bevel: 'relaxedInset'});
    case 'metalOval': return l('ellipse', [SILVER, 6], 'soft', {bevel: 'angle'});
    default: return null;
  }
}

function shadow(kind) {
  const base = {color: colorWith(colorRgb(BLACK), {op: 'alpha', val: 40000}), blur: 4, dist: 3, dir: 45, inner: false, sx: 1, sy: 1, kx: 0, ky: 0, align: 'tl',
    rotateWithShape: false};
  switch (kind) {
    case 'drop': return {...base, blur: 12, dist: 6, dir: 90};
    case 'center': return {...base, blur: 16, dist: 0};
    case 'perspective': return {...base, sy: 0.23, kx: -20, dir: 90, dist: 0, blur: 6, align: 'bl'};
    default: return base;
  }
}

/** `apply`: style `id` (or clear it with `none`) on `sh`. Returns false for an unknown style. */
export function applyStyle(sh, id) {
  if (id === 'none') {
    sh.geom = {kind: 'preset', name: 'rect'};
    sh.line = null;
    sh.effects = null;
    return true;
  }
  const lk = look(id);
  if (!lk) return false;
  sh.geom = {kind: 'preset', name: lk.preset};
  sh.line = lk.frame ? {...lineDefault(), fill: fillSolid(colorRgb(lk.frame[0])), width: lk.frame[1]} : lineNoneFull();
  const e = {...effectsDefault(), outerShadow: lk.shadow ? shadow(lk.shadow) : null, softEdge: lk.softEdge,
    reflection: lk.reflection ? {blur: 0.5, startAlpha: 0.5, endAlpha: 0, endPos: 0.35, dist: 0} : null, bevel: lk.bevel};
  sh.effects = effectsEmpty(e) ? null : e;
  if (lk.rot !== null && sh.xfrm) sh.xfrm.rot = lk.rot;
  return true;
}

const gallery = () => STYLES.map(([id, label]) => ({id, label}));

export default defineCommands({
  family: 'picture_style',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'picture.style', label: 'Picture Styles', risk: 'edit',
      state: ctx => { const st = hasSelection(ctx); return st.enabled ? {enabled: true, value: STYLES.map(([id, label]) => ({id, label, value: id}))} : st; },
      description: '{style: simpleFrameWhite|dropShadowRectangle|softEdgeOval|… | none (see picture.styles), ids?}',
      params: s.object({style: s.string({min: 1, max: 64}), ids: s.optional(s.array(s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]))),
        id: s.optional(s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]))}),
      run(ctx, p) {
        if (p.style !== 'none' && !look(p.style)) throw bad('picture.style', `unknown style \`${p.style}\`; see picture.styles`);
        return editShapes(ctx, p, 'picture.style', sh => { applyStyle(sh, p.style); });
      }},
    {id: 'picture.styles', label: 'Picture Style Gallery', risk: 'read', state: always, description: '{} → [{id, label}]',
      params: s.object({}), run: gallery},
  ],
});
