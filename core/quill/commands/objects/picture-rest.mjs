// Picture Format leftovers (U:quill/rest): Color Tone, Set Transparent Color, Crop to Shape, Fill and Fit.
//
// Not checked against upstream (wordcraft has no engine for them; each follows Word):
// - Color Tone: the eight temperature presets (4700 K … 11200 K, 6500 K the picture as it is) as a white balance of the bitmap;
//   absolute from the original, like Corrections and Color.
// - Set Transparent Color: every pixel close to the colour clicked on the picture (or given as `color`) becomes transparent. The
//   button turns the next click on a picture into that colour (the page view's crosshair); `picture.setTransparentColor` with `at`
//   (fractions of the picture shown) or `color` is the same edit.
// - Crop to Shape: what lies outside the shape is made transparent in the bitmap (the shape drawn over the part the crop shows);
//   Reset Picture brings the whole bitmap back. Word keeps the shape as the picture's geometry; here the file keeps a PNG.
// - Fill and Fit: the frame keeps its size and the picture fills it, cropped evenly (Fill); the whole picture shown in the largest
//   frame of its own shape inside the old one (Fit).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import * as P from '../../model/para.mjs';
import {base64Decode, probe} from '../../lib/insert-objects.mjs';
import {presetOfKind, presetSteps, isOpenPreset} from '../../lib/shape-presets.mjs';
import * as X from '../../lib/picture-pixels.mjs';
import {stateFor, target, editAt, finish, isPicture, sizeOf, NO_PICTURE} from '../../lib/object-edit.mjs';
import {pixelEdit, baseKey, isPictureOk, rgbOf, fitSize} from './picture.mjs';
import {viewOf} from '../../lib/view-layout.mjs';
import {ready} from '../../lib/table-session.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/objects/picture.rs']};
const picState = stateFor(o => (isPicture(o) ? null : NO_PICTURE), NO_PICTURE);
const fail = m => new CommandError('failed', m);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** The pixels of the picture's bitmap shown, [w, h], or null. */
function pixelsOf(S, obj) {
  const b64 = S.d.c.media[obj.media];
  const got = typeof b64 === 'string' ? probe(base64Decode(b64)) : null;
  return got?.width && got?.height ? [got.width, got.height] : null;
}

/** The part of the bitmap (as fractions) the crop shows: [x0, y0, x1, y1]. */
const shownPart = obj => { const c = obj.crop ?? [0, 0, 0, 0]; return [c[0], c[1], 1 - c[2], 1 - c[3]]; };

async function setTransparent(ctx, p) {
  const {obj} = target(ctx, isPictureOk, NO_PICTURE);
  let cleared = 0;
  const [x0, y0, x1, y1] = shownPart(obj);
  const wanted = p.color !== undefined ? rgbOf(p.color, 'color') : null;
  if (!wanted && !Array.isArray(p.at)) throw new CommandError('invalid_params', '`color` (RRGGBB) or `at` ([x, y] fractions of the picture) is required');
  const res = await pixelEdit(ctx, (S, o) => o.media, b => {
    const c = wanted ?? X.pixelAt(b, x0 + clamp(Number(p.at[0]), 0, 1) * (x1 - x0), y0 + clamp(Number(p.at[1]), 0, 1) * (y1 - y0));
    const out = X.transparentColor(b, c, p.tolerance ?? 12);
    cleared = out.cleared;
    return out;
  });
  ctx.setView({pickTransparent: false});
  return {...res, result: {...(res.result ?? {}), cleared}};
}

async function cropToShape(ctx, p) {
  const name = presetOfKind(p.shape ?? p.preset ?? 'rect');
  if (!name || isOpenPreset(name)) throw new CommandError('invalid_params', 'a closed shape (rectangle, oval, star, heart, ...) is required');
  const {obj} = target(ctx, isPictureOk, NO_PICTURE);
  const [fx0, fy0, fx1, fy1] = shownPart(obj);
  return pixelEdit(ctx, (S, o) => o.media, b => {
    const vw = (fx1 - fx0) * b.width, vh = (fy1 - fy0) * b.height;
    const steps = presetSteps(name, vw, vh);
    if (!steps) throw fail('that shape has no outline');
    return X.maskToShape(b, steps, {x0: fx0 * b.width, y0: fy0 * b.height, vw, vh});
  });
}

/** Fill: the frame keeps its size; the sides of the bitmap that do not fit its shape are cropped evenly. */
function fill(ctx) {
  const {S, pos, obj} = target(ctx, isPictureOk, NO_PICTURE);
  const px = pixelsOf(S, obj);
  if (!px) throw fail('the picture cannot be read');
  const [w, h] = sizeOf(obj);
  const ratio = w / Math.max(h, 1e-6);
  const c = [0, 0, 0, 0];
  if (px[0] / px[1] > ratio) { const keep = (px[1] * ratio) / px[0]; c[0] = c[2] = (1 - keep) / 2; } else { const keep = px[0] / ratio / px[1]; c[1] = c[3] = (1 - keep) / 2; }
  const next = editAt(S, pos, o => ({...o, crop: c}));
  return finish(ctx, S, {edit: true, result: {object: next}});
}

/** Fit: no crop, and the frame the shape of the whole picture, as large as fits in the old frame. */
function fit(ctx) {
  const {S, pos, obj} = target(ctx, isPictureOk, NO_PICTURE);
  const px = pixelsOf(S, obj);
  if (!px) throw fail('the picture cannot be read');
  const [w, h] = sizeOf(obj);
  const k = Math.min(w / px[0], h / px[1]);
  const [fw, fh] = fitSize(px[0] * k, px[1] * k, true);
  const next = editAt(S, pos, o => ({...P.setObjectSize(o, fw, fh), crop: [0, 0, 0, 0]}));
  return finish(ctx, S, {edit: true, result: {object: next}});
}

export default defineCommands({
  family: 'objects/picture-rest',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'picture.colorTone', label: 'Color Tone', risk: 'edit',
      state: ctx => { const st = picState(ctx); return st.enabled ? {...st, value: X.TEMPERATURES.map(k => ({id: String(k), label: `Temperature: ${k} K`, value: k}))} : st; },
      description: 'Color Tone (Picture Format › Adjust › Color): the picture as lit at `temperature` kelvin (4700 … 11200, 6500 is the original; lower is cooler, higher warmer), absolute from the original bitmap. Not checked against upstream.',
      params: s.object({temperature: s.optional(s.number({min: 1500, max: 15000}))}),
      run: (ctx, p) => pixelEdit(ctx, baseKey, b => X.temperature(b, p.temperature ?? 6500))},
    {id: 'picture.setTransparentColor', label: 'Set Transparent Color', risk: 'edit', state: picState,
      description: 'Set Transparent Color (Picture Format › Adjust › Color): the pixels close to a colour become transparent: `color` (RRGGBB) or `at` [x, y] (fractions of the picture shown, the colour under that point); `tolerance` 0..255 per channel (default 12). Not checked against upstream.',
      params: s.object({color: s.optional(s.string({min: 1, max: 16})), at: s.optional(s.array(s.number(), {min: 2, max: 2})), tolerance: s.optional(s.number({min: 0, max: 255}))}),
      run: setTransparent},
    {id: 'picture.pickTransparent', label: 'Set Transparent Color', risk: 'read', effect: 'view',
      state: (ctx, p) => { const st = p?.value === false ? ready(ctx) : picState(ctx); return st.enabled ? {...st, checked: !!viewOf(ctx.view).pickTransparent} : st; },
      description: 'Set Transparent Color (Picture Format › Adjust › Color): the next click on a picture picks the colour that becomes transparent (the pointer is a crosshair until then); `value` false cancels. Not checked against upstream.',
      params: s.object({value: s.optional(s.boolean())}),
      run(ctx, p) { const on = typeof p.value === 'boolean' ? p.value : !viewOf(ctx.view).pickTransparent; ctx.setView({pickTransparent: on}); return {value: on}; }},
    {id: 'picture.cropToShape', label: 'Crop to Shape', risk: 'edit', state: picState,
      description: 'Crop to Shape (Picture Format › Size › Crop): what lies outside the shape `preset` (a closed shape of the Shapes gallery) becomes transparent; the shape is drawn over the part the crop shows. Reset Picture brings the whole bitmap back. Not checked against upstream.',
      params: s.object({preset: s.optional(s.string({min: 1, max: 64})), shape: s.optional(s.string({min: 1, max: 64}))}),
      run: cropToShape},
    {id: 'picture.fill', label: 'Fill', risk: 'edit', state: picState,
      description: 'Fill (Picture Format › Size › Crop): the picture fills its frame at the frame\'s own shape; the sides that do not fit are cropped evenly. Not checked against upstream.',
      params: s.object({}), run: fill},
    {id: 'picture.fit', label: 'Fit', risk: 'edit', state: picState,
      description: 'Fit (Picture Format › Size › Crop): the whole picture is shown, uncropped, in the largest frame of its own shape inside the old frame. Not checked against upstream.',
      params: s.object({}), run: fit},
  ],
});
