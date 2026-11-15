// Picture Format › Adjust: Recolor (grayscale, sepia, washout, black and white, a theme colour dark or
// light), Set Transparent Color by colour, Remove Background and Artistic Effects. Recolor only sets
// the picture's adjust (the slide draws it with an SVG filter and .pptx keeps it as a:grayscl,
// a:duotone, a:biLevel and a:lum); Remove Background and the artistic effects work on the pixels and
// the result becomes the picture, the original kept (`fill.artistic`) so an effect can be changed or
// removed.
// Translated from deckcraft crates/engine/src/cmd/recolor.rs, background.rs and artistic.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasSelection, targets, currentSlide, editShapes, addMedia, base64Decode, colorRgb, colorScheme, pictureAdjustDefault} from '../lib/shape-common.mjs';
import {fromHex, hex as hexOf} from '../model/color.mjs';
import {findShape, mediaById} from '../model/presentation.mjs';
import {ctxForSlide, ctxColor} from '../model/resolve.mjs';
import {decodeImage, encodePng, matte, applyEffect, fitWithin, EFFECTS, MAX_PIXELS, MAX_SIDE} from '../lib/raster.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/recolor.rs', 'crates/engine/src/cmd/background.rs', 'crates/engine/src/cmd/artistic.rs']};
const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})], {description: 'shape id'});
const ids = s.optional(s.array(ID, {max: 5000, description: 'pictures (default: the selection)'}));
const id = s.optional(ID);

// ---------------------------------------------------------------------------------------------
// Recolor (recolor.rs)

const ACCENTS = Object.freeze([['tx2', 'Text color 2', 'dk2'], ['accent1', 'Accent color 1', 'accent1'], ['accent2', 'Accent color 2', 'accent2'], ['accent3', 'Accent color 3', 'accent3'],
  ['accent4', 'Accent color 4', 'accent4'], ['accent5', 'Accent color 5', 'accent5'], ['accent6', 'Accent color 6', 'accent6']]);

/** [id, label], in PowerPoint's gallery order: colour modes, then dark and light variations. */
export function recolorPresets() {
  return [['none', 'No Recolor'], ['grayscale', 'Grayscale'], ['sepia', 'Sepia'], ['washout', 'Washout'], ['bw25', 'Black and White: 25%'], ['bw50', 'Black and White: 50%'],
    ['bw75', 'Black and White: 75%'], ...ACCENTS.map(([k, l]) => [`${k}Dark`, `${l} Dark`]), ...ACCENTS.map(([k, l]) => [`${k}Light`, `${l} Light`])];
}
const rgbRef = (r, g, b) => colorRgb({r, g, b, a: 255});

/** Set `a`'s recolour to `preset`, clearing any earlier one. False for an unknown preset. */
export function applyRecolor(a, preset) {
  const washed = a.brightness === 0.7 && a.contrast === -0.7;
  const n = {...a, grayscale: false, duotone: null, bilevel: null};
  delete n.bilevel;
  if (washed) { n.brightness = 0; n.contrast = 0; }
  switch (preset) {
    case 'none': break;
    case 'grayscale': n.grayscale = true; break;
    // PowerPoint's sepia is a duotone from dark brown to light cream.
    case 'sepia': n.duotone = [rgbRef(0x40, 0x2a, 0x10), rgbRef(0xf2, 0xe3, 0xc6)]; break;
    // Washout is PowerPoint's +70% brightness, -70% contrast.
    case 'washout': n.brightness = 0.7; n.contrast = -0.7; break;
    case 'bw25': n.bilevel = 0.25; break;
    case 'bw50': n.bilevel = 0.5; break;
    case 'bw75': n.bilevel = 0.75; break;
    default: {
      const hit = ACCENTS.find(([k]) => preset === `${k}Dark` || preset === `${k}Light`);
      if (!hit) return false;
      const c = colorScheme(hit[2]);
      n.duotone = preset.endsWith('Dark') ? [rgbRef(0, 0, 0), c] : [c, rgbRef(255, 255, 255)];
    }
  }
  for (const k of Object.keys(a)) delete a[k];
  Object.assign(a, n);
  return true;
}

/** The two colours a preset draws with, for its gallery tile (resolved hex). */
function tileColors(ctx, preset) {
  const hexIn = c => `#${hexOf(ctx ? ctxColor(ctx, c, null) : {r: 0, g: 0, b: 0})}`.toLowerCase();
  const a = pictureAdjustDefault();
  applyRecolor(a, preset);
  if (a.duotone) return a.duotone.map(hexIn);
  if (a.bilevel !== undefined && a.bilevel !== null) return ['#000000', '#ffffff'];
  if (a.grayscale) return ['#3a3a3a', '#d8d8d8'];
  if (a.brightness === 0.7) return ['#c8c8c8', '#f4f4f4'];
  return ['#2e6fb5', '#e8a33d'];
}

function recolor(ctx, p) {
  const preset = p.preset ?? p.value;
  if (typeof preset !== 'string') throw bad('picture.recolor', 'missing `preset`');
  if (!recolorPresets().some(([k]) => k === preset)) throw bad('picture.recolor', `unknown preset \`${preset}\`; see picture.recolors`);
  return editShapes(ctx, p, 'picture.recolor', sh => { if (sh.kind?.type === 'picture') applyRecolor(sh.kind.fill.adjust ??= pictureAdjustDefault(), preset); });
}

function transparentColor(ctx, p) {
  let c = null;
  if (p.none !== true) {
    if (typeof p.color !== 'string') throw bad('picture.transparentColor', 'give `color` (#RRGGBB) or `none: true`');
    const rgb = /^#?[0-9a-fA-F]{6}$/.test(p.color) ? fromHex(p.color) : null;
    if (!rgb) throw bad('picture.transparentColor', `bad colour \`${p.color}\``);
    c = {r: rgb.r, g: rgb.g, b: rgb.b, a: 255};
  }
  return editShapes(ctx, p, 'picture.transparentColor', sh => { if (sh.kind?.type === 'picture') (sh.kind.fill.adjust ??= pictureAdjustDefault()).clearColor = c; });
}

// ---------------------------------------------------------------------------------------------
// Pixel work: Remove Background, Artistic Effects

const stemOf = name => String(name || 'picture').replace(/\.[^.]+$/, '');

/** The selected (or given) pictures with their media item. */
function pictures(ctx, p, cmd) {
  const sl = currentSlide(ctx, cmd);
  const out = [];
  for (const sid of targets(ctx, p, cmd)) {
    const sh = findShape(sl.shapes, sid);
    if (sh?.kind?.type !== 'picture') continue;
    out.push({id: sid, fill: sh.kind.fill});
  }
  if (!out.length) throw bad(cmd, 'select a picture');
  return out;
}
async function pixelsOf(ctx, mediaId, cmd) {
  const m = mediaById(ctx.doc, mediaId);
  if (!m?.data) throw bad(cmd, "the picture's data is missing");
  const bytes = base64Decode(m.data);
  if (!bytes) throw bad(cmd, "the picture's data can't be read");
  const img = await decodeImage(bytes, ctx.host);
  if (!img) throw new CommandError('failed', `${cmd}: this picture's format can't be processed`);
  return {m, img};
}

async function removeBackground(ctx, p) {
  const cmd = 'picture.removeBackground';
  const tolerance = typeof p.tolerance === 'number' && Number.isFinite(p.tolerance) ? p.tolerance : 20;
  const done = [];
  for (const {id: sid, fill} of pictures(ctx, p, cmd)) {
    const {m, img} = await pixelsOf(ctx, fill.media, cmd);
    if (img.width * img.height > MAX_PIXELS) throw bad(cmd, `${img.width}×${img.height} pixels is too large; compress the picture first`);
    if (matte(img, tolerance) === 0) continue;
    done.push({id: sid, name: `${stemOf(m.name)}-no-background.png`, png: await encodePng(img)});
  }
  if (!done.length) throw bad(cmd, 'no background found: select a picture whose edges show its background');
  for (const d of done) {
    const media = addMedia(ctx, cmd, d.name, 'image/png', d.png);
    editShapes(ctx, {ids: [d.id]}, cmd, sh => { sh.kind.fill.media = media; });
  }
  return {pictures: done.length};
}

async function artisticEffect(ctx, p) {
  const cmd = 'picture.artisticEffect';
  const effect = p.effect === 'none' ? null : EFFECTS.some(([k]) => k === (p.effect ?? p.value)) ? (p.effect ?? p.value) : undefined;
  if (effect === undefined) throw bad(cmd, '`effect` is none or one of artisticBlur, artisticPencilGrayscale, …');
  const work = [];
  for (const {id: sid, fill} of pictures(ctx, p, cmd)) {
    const original = fill.artistic?.original ?? fill.media;
    if (effect === null) { work.push({id: sid, original, png: null}); continue; }
    const {m, img} = await pixelsOf(ctx, original, cmd);
    const out = applyEffect(effect, fitWithin(img, MAX_SIDE));
    work.push({id: sid, original, name: `${stemOf(m.name)}-${effect}.png`, png: await encodePng(out)});
  }
  for (const w of work) {
    const media = w.png ? addMedia(ctx, cmd, w.name, 'image/png', w.png) : null;
    editShapes(ctx, {ids: [w.id]}, cmd, sh => {
      const f = sh.kind.fill;
      if (media !== null) { f.media = media; f.artistic = {effect, original: w.original}; } else { f.media = w.original; delete f.artistic; }
    });
  }
  return {effect};
}

export default defineCommands({
  family: 'picture_pixels',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'picture.recolor', label: 'Recolor', risk: 'edit',
      description: '{preset: none|grayscale|sepia|washout|bw25|bw50|bw75|accent1Dark…accent6Dark|accent1Light…accent6Light|tx2Dark|tx2Light (see picture.recolors), ids?}',
      params: s.object({preset: s.optional(s.string({max: 32})), value: s.optional(s.string({max: 32})), ids, id}),
      state(ctx) {
        const st = hasSelection(ctx);
        if (!st.enabled) return st;
        let rctx = null;
        try { rctx = ctxForSlide(ctx.doc, currentSlide(ctx, 'picture.recolor')); } catch { /* tiles without theme colours */ }
        return {enabled: true, value: recolorPresets().map(([k, label]) => ({id: k, label, value: k, art: {kind: 'colors', colors: tileColors(rctx, k)}}))};
      },
      run: recolor},
    {id: 'picture.recolors', label: 'Recolor Gallery', risk: 'read', state: () => ({enabled: true}), description: '{} → [{id, label}]', params: s.object({}),
      run: () => recolorPresets().map(([k, label]) => ({id: k, label}))},
    {id: 'picture.transparentColor', label: 'Set Transparent Color', risk: 'edit', state: hasSelection,
      description: '{color: #RRGGBB | none: true, ids?} (pixels of that colour become transparent)',
      params: s.object({color: s.optional(s.string({max: 16})), none: s.optional(s.boolean()), ids, id}), run: transparentColor},
    {id: 'picture.removeBackground', label: 'Remove Background', risk: 'edit', state: hasSelection,
      description: '{tolerance?: 0..100 (how different a colour may be from the edge\'s, default 20), ids?} → {pictures}',
      params: s.object({tolerance: s.optional(s.number()), ids, id}), run: removeBackground},
    {id: 'picture.artisticEffect', label: 'Artistic Effects', risk: 'edit',
      state(ctx) { const st = hasSelection(ctx); return st.enabled ? {enabled: true, value: [{id: 'none', label: 'None', value: 'none'}, ...EFFECTS.map(([k, label]) => ({id: k, label, value: k, art: {kind: 'artistic', effect: k}}))]} : st; },
      description: '{effect: none|artisticBlur|artisticPencilGrayscale|artisticLineDrawing|artisticFilmGrain|artisticCutout|artisticGlowEdges|artisticPhotocopy, ids?}',
      params: s.object({effect: s.optional(s.string({max: 40})), value: s.optional(s.string({max: 40})), ids, id}), run: artisticEffect},
  ],
});
