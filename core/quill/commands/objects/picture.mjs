// Picture Format: Adjust (Remove Background, Corrections, Color, Icon Color, Artistic Effects, Transparency,
// Compress, Change Picture, Reset Picture), Picture Styles (Styles, Border), Size (width, height, scale, original
// size, Crop and its offsets, aspect ratios) and Alt Text.
//
// Translated from wordcraft crates/engine/src/cmd/objects/picture.rs (`crop`, `size`, `fit_size`,
// `original_size`, `cropped_original_size`, `adjust`, `adjust_media`, `relook`, `reset`) and the `picture.*` and
// `object.altText` commands of objects/specs.rs, objects/select.rs (`alt_text`), at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Pixel edits (corrections, colour, effects, transparency, styles, border, compress, remove background) rewrite
// the picture's bitmap as a new PNG, as upstream does; `orig` on the picture names the bitmap Reset Picture
// returns to (upstream keeps that map in the session) and `look` the effect, style and border drawn on it, so a
// second style replaces the first. Not upstream (follows Word, not checked against upstream): Reset Picture &
// Size, No Outline and an exact border weight, the Aspect Ratio crops. Crop to Shape, Fill, Fit, Color Tone and Set Transparent Color
// are in picture-rest.mjs (U:quill/rest); Picture Layout stays hidden.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {UPSTREAM_COMMIT} from '../../lib/caret-session.mjs';
import * as P from '../../model/para.mjs';
import {parseRgb} from '../../model/props.mjs';
import {base64Decode, base64Encode, bytesOf, imageExt, probe} from '../../lib/insert-objects.mjs';
import {decodeImage, encodePng} from '../../lib/picture-host.mjs';
import * as X from '../../lib/picture-pixels.mjs';
import {stateFor, withObject, target, editAt, finish, open, selectedIn, isPicture, movable, sizeOf, disabled, NO_PICTURE, NO_OBJECT, FROZEN} from '../../lib/object-edit.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/objects/picture.rs', 'crates/engine/src/cmd/objects/specs.rs', 'crates/engine/src/cmd/objects/select.rs']};
const NONE = s.object({});
const MAX_SIDE = 4000, MIN_SIDE = 1;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

const picState = stateFor(o => (isPicture(o) ? null : NO_PICTURE), NO_PICTURE);
/** has_sizable: a picture, shape, text box or canvas, and a chart (a diagram is frozen). */
const sizableState = stateFor(o => movable(o), NO_OBJECT);
const objectState = stateFor(() => null, NO_OBJECT);

// ---- Size and Crop -----------------------------------------------------------------------------------

/** The picture's original size: its pixels at 96 pixels an inch (the size Insert › Pictures gives it), before any crop. */
export function originalSize(d, obj) {
  const key = obj.orig && d.c.media[obj.orig] ? obj.orig : obj.media;
  const b64 = d.c.media[key] ?? d.c.media[obj.media];
  if (typeof b64 !== 'string') return null;
  const got = probe(base64Decode(b64));
  if (!got?.width || !got?.height) return null;
  return {w: got.width * 0.75, h: got.height * 0.75, pixels: [got.width, got.height]};
}
/** What a picture's crop leaves of its original size: the size Reset gives back and a scale of the original counts from. */
export function croppedOriginalSize(d, obj) {
  if (!isPicture(obj)) return null;
  const orig = originalSize(d, obj);
  if (!orig) return null;
  const c = obj.crop ?? [0, 0, 0, 0], part = (lo, hi) => Math.max(1 - lo - hi, 0.05);
  return [orig.w * part(c[0], c[2]), orig.h * part(c[1], c[3])];
}

/** An object size within 1–4000 pt; with `keep` both sides scale by one factor so the proportions hold (fit_size). */
export function fitSize(w, h, keep) {
  const side = x => (Number.isNaN(x) ? 1 : clamp(x, MIN_SIDE, MAX_SIDE));
  if (keep && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    const lo = Math.max(1 / w, 1 / h), hi = Math.min(MAX_SIDE / w, MAX_SIDE / h);
    if (lo <= hi) {
      const k = lo > 1 ? lo : hi < 1 ? hi : 1;
      return [side(w * k), side(h * k)];
    }
  }
  return [side(w), side(h)];
}

/** picture.size: scale of the current size (or, with `original`, of the cropped original), then width and height. */
function size(ctx, p) {
  const {S, pos, obj} = target(ctx, movable, NO_OBJECT);
  const lock = p.lockAspect ?? true;
  let [w, h] = sizeOf(obj);
  if (p.original) {
    const got = croppedOriginalSize(S.d, obj);
    if (!got) throw disabled('only a picture whose image can be read has an original size');
    const k = (p.scale ?? 100) / 100;
    [w, h] = [got[0] * k, got[1] * k];
  } else if (p.scale !== undefined) { w *= p.scale / 100; h *= p.scale / 100; }
  const [nw, nh] = [p.width, p.height];
  if (nw !== undefined && nh !== undefined) { w = nw; h = nh; }
  else if (nw !== undefined) { if (lock && w > 0) h *= nw / w; w = nw; }
  else if (nh !== undefined) { if (lock && h > 0) w *= nh / h; h = nh; }
  const keep = nw !== undefined && nh !== undefined ? false : nw === undefined && nh === undefined ? true : lock;
  const [fw, fh] = fitSize(w, h, keep);
  const next = editAt(S, pos, o => P.setObjectSize(o, fw, fh));
  return finish(ctx, S, {edit: true, result: {object: next, width: fw, height: fh}});
}

/** picture.crop: the crop as fractions of the source (and optionally the new display size) as one edit. */
function crop(ctx, p) {
  const {S, pos} = target(ctx, isPictureOk, NO_PICTURE);
  const c = [p.left, p.top, p.right, p.bottom].map(x => clamp(fin(x), 0, 0.95));
  // The two sides of an axis keep at least 5% of the source between them.
  c[2] = Math.min(c[2], 0.95 - c[0]);
  c[3] = Math.min(c[3], 0.95 - c[1]);
  const next = editAt(S, pos, o => {
    const out = {...o, float: {...(o.float ?? P.defaultFloat())}};
    const f = out.float, old = o.crop ?? [0, 0, 0, 0];
    const full = (len, lo, hi) => len / Math.max(1 - lo - hi, 0.05);
    const left = f.flipH ? 2 : 0, top = f.flipV ? 3 : 1;
    if (p.width !== undefined) {
      const nw = clamp(p.width, 1, MAX_SIDE);
      if ((f.wrap ?? 'inline') !== 'inline' && f.hAlign === undefined) f.x = fin(f.x) + (c[left] - old[left]) * full(nw, c[0], c[2]);
      out.w = nw;
    }
    if (p.height !== undefined) {
      const nh = clamp(p.height, 1, MAX_SIDE);
      if ((f.wrap ?? 'inline') !== 'inline' && f.vAlign === undefined) f.y = fin(f.y) + (c[top] - old[top]) * full(nh, c[1], c[3]);
      out.h = nh;
    }
    out.crop = c;
    return out;
  });
  return finish(ctx, S, {edit: true, result: {object: next}});
}
export const isPictureOk = o => (isPicture(o) ? null : NO_PICTURE);

/** The Aspect Ratio crops (width:height): the sides cropped evenly so the visible part has that shape. */
export const ASPECTS = Object.freeze({
  square: [1, 1], portrait2x3: [2, 3], portrait3x4: [3, 4], portrait3x5: [3, 5], portrait4x5: [4, 5],
  landscape3x2: [3, 2], landscape4x3: [4, 3], landscape5x3: [5, 3], landscape5x4: [5, 4], landscape16x9: [16, 9], landscape16x10: [16, 10],
});
function aspect(ctx, p) {
  const {S, pos, obj} = target(ctx, isPictureOk, NO_PICTURE);
  const shown = (() => { const b64 = S.d.c.media[obj.media]; const got = typeof b64 === 'string' ? probe(base64Decode(b64)) : null; return got?.width && got?.height ? [got.width, got.height] : null; })();
  const ratio = p.ratio ? p.ratio[0] / p.ratio[1] : ASPECTS[p.aspect][0] / ASPECTS[p.aspect][1];
  // The source's own shape: the pixels of the bitmap shown (a frame drawn on it is part of it), or the frame when it can't be read.
  const [sw, sh] = shown ?? sizeOf(obj);
  const c = [0, 0, 0, 0];
  if (sw / sh > ratio) { const keep = (sh * ratio) / sw; c[0] = c[2] = (1 - keep) / 2; } else { const keep = sw / ratio / sh; c[1] = c[3] = (1 - keep) / 2; }
  const full = sizeOf(obj);
  const area = full[0] * full[1];
  const old = obj.crop ?? [0, 0, 0, 0];
  const oldVisible = Math.max(1 - old[0] - old[2], 0.05) * Math.max(1 - old[1] - old[3], 0.05);
  // The visible part keeps its area: the frame takes the new shape.
  const k = Math.sqrt((area / oldVisible) * (Math.max(1 - c[0] - c[2], 0.05) * Math.max(1 - c[1] - c[3], 0.05)));
  const [fw, fh] = fitSize(k * Math.sqrt(ratio), k / Math.sqrt(ratio), true);
  const next = editAt(S, pos, o => ({...P.setObjectSize(o, fw, fh), crop: c}));
  return finish(ctx, S, {edit: true, result: {object: next}});
}

// ---- pixel edits ------------------------------------------------------------------------------------

/** The media key of the bitmap an absolute edit starts from: the picture's original, or the current bitmap. */
export const baseKey = (S, obj) => (obj.orig && S.d.c.media[obj.orig] ? obj.orig : obj.media);

/**
 * Apply `op(bitmap)` to the bitmap `keyOf(S, obj)` names and make the result the picture's bitmap (adjust_media):
 * a new PNG, `orig` chained onto the ultimate original, and `look` as `lookOf(obj)` says.
 */
export async function pixelEdit(ctx, keyOf, op, lookOf = () => undefined) {
  const first = target(ctx, isPictureOk, NO_PICTURE);
  const key = keyOf(first.S, first.obj);
  const b64 = first.S.d.c.media[key];
  if (typeof b64 !== 'string') throw new CommandError('failed', 'picture data missing');
  let out;
  try {
    const bmp = await decodeImage(ctx.host, base64Decode(b64));
    out = await encodePng(ctx.host, op(bmp));
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError('failed', e?.message === 'picture is too large to edit' ? e.message : `can't decode the picture: ${e?.message ?? e}`);
  }
  // The document may have moved on while the picture decoded: find the object again.
  const {S, pos, obj} = target(ctx, isPictureOk, NO_PICTURE);
  const media = S.d.addMedia(base64Encode(out), 'png');
  const orig = obj.orig && S.d.c.media[obj.orig] ? obj.orig : key === obj.media ? obj.media : key;
  const next = editAt(S, pos, o => {
    const n = {...o, media, orig};
    const look = lookOf(o, media, key);
    if (look === undefined) delete n.look; else if (look === null) delete n.look; else n.look = look;
    return n;
  });
  return finish(ctx, S, {edit: true, result: {object: next}});
}

/** relook: change the effect, style or border and draw again from the bitmap under them. */
async function relook(ctx, change) {
  const {S, obj} = target(ctx, isPictureOk, NO_PICTURE);
  const cur = obj.look && obj.look.drawn === obj.media && S.d.c.media[obj.look.base] ? obj.look : {base: obj.media};
  const look = {base: cur.base, effect: cur.effect ?? null, style: cur.style ?? null, border: cur.border ?? null};
  change(look);
  if (!look.effect && !look.style && !look.border) {
    // Nothing left on it: the bitmap as it was.
    const {S: S2, pos} = target(ctx, isPictureOk, NO_PICTURE);
    const next = editAt(S2, pos, o => { const n = {...o, media: look.base}; delete n.look; return n; });
    return finish(ctx, S2, {edit: true, result: {object: next}});
  }
  // `pad`: how wide the frame the style or border drew round the bitmap is, so a crop cuts the picture and never the frame.
  let pad = 0;
  return pixelEdit(ctx, () => look.base, b => { const out = X.relookBitmap(b, look); pad = Math.max(0, Math.round((out.width - b.width) / 2)); return out; }, (o, media) => ({...look, drawn: media, pad}));
}

const COLOR = s.string({min: 1, max: 16});
/** A colour from RRGGBB, #RRGGBB, or the palette's Automatic (black). */
export const rgbOf = (v, what) => { const c = /^auto(matic)?$/i.test(String(v)) ? [0, 0, 0] : parseRgb(v); if (!c) throw new CommandError('invalid_params', `${what} is RRGGBB`); return c; };

// ---- Change and Reset ---------------------------------------------------------------------------------

function change(ctx, p) {
  let bytes;
  if (typeof p.data === 'string') { bytes = bytesOf(p.data); if (!bytes) throw new CommandError('invalid_params', 'bad base64 data'); }
  else throw new CommandError('invalid_params', '`data` (base64) is required: Change Picture picks the file in the window');
  const got = probe(bytes);
  if (got.notPicture) throw new CommandError('failed', 'not a supported image');
  if (got.refused) throw new CommandError('failed', got.refused);
  const {S, pos} = target(ctx, isPictureOk, NO_PICTURE);
  const media = S.d.addMedia(base64Encode(bytes), imageExt(bytes));
  const next = editAt(S, pos, o => { const n = {...o, media}; delete n.orig; delete n.look; return n; });
  return finish(ctx, S, {edit: true, result: {object: next, media}});
}

function reset(ctx, p) {
  const {S, pos, obj} = target(ctx, isPictureOk, NO_PICTURE);
  const orig = obj.orig && S.d.c.media[obj.orig] ? obj.orig : obj.media;
  const next = editAt(S, pos, o => {
    const n = {...o, media: orig, crop: [0, 0, 0, 0]};
    delete n.orig; delete n.look;
    if (p.size) {
      const got = croppedOriginalSize(S.d, {...n});
      if (got) { const [w, h] = fitSize(got[0], got[1], true); n.w = w; n.h = h; }
    }
    return n;
  });
  return finish(ctx, S, {edit: true, result: {object: next}});
}

// ---- alt text -----------------------------------------------------------------------------------------

/** object.altText / picture.altText: the description, title and decorative mark of the selected drawing, one undo step. */
function altText(ctx, p, needPicture) {
  if (p.text === undefined && p.title === undefined && p.decorative === undefined) throw new CommandError('invalid_params', '`text`, `title` or `decorative` is required');
  return withObject(ctx, needPicture ? isPictureOk : () => null, needPicture ? NO_PICTURE : NO_OBJECT, o => {
    let n = o;
    if (p.text !== undefined) n = P.withAltText(n, p.text) ?? n;
    if (p.title !== undefined || p.decorative !== undefined) {
      const f = {...(n.float ?? P.defaultFloat())};
      f.alt = {...(f.alt ?? {})};
      if (p.title !== undefined) f.alt.title = P.capAlt(p.title);
      if (p.decorative !== undefined) f.alt.decorative = !!p.decorative;
      n = {...n, float: f};
    }
    return n;
  });
}

const styleItems = () => X.PICTURE_STYLES.map(([id, label]) => ({id, label, value: id, art: {kind: 'pictureStyle', style: id}, iconOnly: false}));

export default defineCommands({
  family: 'objects/picture',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'picture.size', label: 'Size', risk: 'edit', state: sizableState,
      description: 'Size (Picture Format › Size): `width` and/or `height` in points (one alone keeps the proportions unless `lockAspect` is false; 1–4000 pt), `scale` percent of the current size, or with `original` of the picture\'s original size (its pixels at 96 ppi less what is cropped; `original` alone restores it).',
      params: s.object({width: s.optional(s.number()), height: s.optional(s.number()), lockAspect: s.optional(s.boolean()), scale: s.optional(s.number({min: 0})), original: s.optional(s.boolean())}),
      run: size},
    {id: 'picture.width', label: 'Width', risk: 'edit', state: stateFor(movable, NO_OBJECT, o => ({value: Math.round(o.w * 100) / 100})),
      description: 'Width (Picture Format and Shape Format › Size): the width in points; the height follows unless `lockAspect` is false.',
      params: s.object({width: s.number(), lockAspect: s.optional(s.boolean())}), run: (ctx, p) => size(ctx, p)},
    {id: 'picture.height', label: 'Height', risk: 'edit', state: stateFor(movable, NO_OBJECT, o => ({value: Math.round(o.h * 100) / 100})),
      description: 'Height (Picture Format and Shape Format › Size): the height in points; the width follows unless `lockAspect` is false.',
      params: s.object({height: s.number(), lockAspect: s.optional(s.boolean())}), run: (ctx, p) => size(ctx, p)},
    {id: 'picture.crop', label: 'Crop', risk: 'edit', state: picState,
      description: 'Crop (Picture Format › Size): `left`, `top`, `right`, `bottom` as fractions of the source 0–0.95 (the two sides of an axis keep 5% between them; a side left out is uncropped); `width` and `height` set the new display size in the same undo step, and a floating picture moves by what a left/top crop trims.',
      params: s.object({left: s.optional(s.number()), top: s.optional(s.number()), right: s.optional(s.number()), bottom: s.optional(s.number()), width: s.optional(s.number()), height: s.optional(s.number())}),
      run: crop},
    {id: 'picture.cropAspect', label: 'Aspect Ratio', risk: 'edit',
      state: ctx => { const st = picState(ctx); return st.enabled ? {...st, value: Object.keys(ASPECTS)} : st; },
      description: 'Aspect Ratio (Picture Format › Size › Crop): crop the sides evenly so the visible part has the shape `aspect` (square, portrait2x3 … landscape16x9) or `ratio` [width, height]; the frame takes that shape at the same area. Not in wordcraft (follows Word).',
      params: s.object({aspect: s.optional(s.enum(Object.keys(ASPECTS))), ratio: s.optional(s.array(s.number({min: 1, max: 1000}), {min: 2, max: 2}))}),
      run(ctx, p) { if (!p.aspect && !p.ratio) throw new CommandError('invalid_params', '`aspect` or `ratio` is required'); return aspect(ctx, p); }},
    {id: 'picture.altText', label: 'Alt Text', risk: 'edit', state: stateFor(o => (isPicture(o) ? null : NO_PICTURE), NO_PICTURE, o => ({value: P.altTextOf(o)})),
      description: 'Alt Text (Picture Format › Accessibility): the selected picture\'s `text`, `title` and `decorative` mark, one undo step.',
      params: s.object({text: s.string({max: 10000}), title: s.optional(s.string({max: 10000})), decorative: s.optional(s.boolean())}),
      run: (ctx, p) => altText(ctx, p, true)},
    {id: 'object.altText', label: 'Alt Text', risk: 'edit', state: objectState,
      description: 'Alt Text (Shape Format › Accessibility): the selected picture, shape, text box, group or chart\'s `text`, `title` and `decorative` mark.',
      params: s.object({text: s.optional(s.string({max: 10000})), title: s.optional(s.string({max: 10000})), decorative: s.optional(s.boolean())}),
      run: (ctx, p) => altText(ctx, p, false)},
    {id: 'picture.corrections', label: 'Corrections', risk: 'edit', state: picState,
      description: 'Corrections (Picture Format › Adjust): `brightness`, `contrast` and `sharpen` (−100..100; negative sharpen softens), absolute from the original bitmap: all three at 0 restores it.',
      params: s.object({brightness: s.optional(s.number({min: -100, max: 100})), contrast: s.optional(s.number({min: -100, max: 100})), sharpen: s.optional(s.number({min: -100, max: 100}))}),
      run: (ctx, p) => pixelEdit(ctx, baseKey, b => X.correct(b, {brightness: p.brightness ?? 0, contrast: p.contrast ?? 0, sharpen: p.sharpen ?? 0}))},
    {id: 'picture.color', label: 'Color', risk: 'edit', state: picState,
      description: 'Color (Picture Format › Adjust): `mode` grayscale, sepia, washout, blackAndWhite, tint, or saturation (0..400 %, `saturation` 100 restores the original), absolute from the original bitmap.',
      params: s.object({mode: s.optional(s.enum(['grayscale', 'sepia', 'washout', 'blackAndWhite', 'saturation', 'tint'])), saturation: s.optional(s.number({min: 0, max: 400}))}),
      run: (ctx, p) => pixelEdit(ctx, baseKey, b => X.recolor(b, p.mode ?? 'grayscale', p.saturation ?? 100))},
    {id: 'picture.iconColor', label: 'Icon Color', risk: 'edit', state: picState,
      description: 'Icon Color (Picture Format › Adjust): `color` (RRGGBB) everywhere, transparency kept: recolours an icon or other one-colour line art.',
      params: s.object({color: COLOR}),
      run: (ctx, p) => { const c = rgbOf(p.color, 'color'); return pixelEdit(ctx, (S, o) => o.media, b => X.iconColor(b, c)); }},
    {id: 'picture.effects', label: 'Artistic Effects', risk: 'edit',
      state: ctx => { const st = picState(ctx); return st.enabled ? {...st, value: [{id: 'none', label: 'None', value: 'none'}, ...X.ARTISTIC_EFFECTS.map(([id, label]) => ({id, label, value: id}))]} : st; },
      description: 'Artistic Effects (Picture Format › Adjust): `effect` blur, sharpen, invert, posterize, pixelate, or none; one at a time, a second replaces the first.',
      params: s.object({effect: s.optional(s.enum(['blur', 'sharpen', 'invert', 'posterize', 'pixelate', 'none']))}),
      run: (ctx, p) => relook(ctx, l => { l.effect = (p.effect ?? 'blur') === 'none' ? null : p.effect ?? 'blur'; })},
    {id: 'picture.transparency', label: 'Transparency', risk: 'edit', state: picState,
      description: 'Transparency (Picture Format › Adjust): `percent` 0..100, absolute from the original bitmap (0 is fully opaque).',
      params: s.object({percent: s.optional(s.number({min: 0, max: 100}))}),
      run: (ctx, p) => pixelEdit(ctx, baseKey, b => X.transparency(b, p.percent ?? 50))},
    {id: 'picture.removeBackground', label: 'Remove Background', risk: 'edit', state: picState,
      description: 'Remove Background (Picture Format › Adjust): the border-connected area close to the corner colour (`tolerance` 0..255, default 30) becomes transparent.',
      params: s.object({tolerance: s.optional(s.number({min: 0, max: 255}))}),
      run: (ctx, p) => pixelEdit(ctx, (S, o) => o.media, b => X.removeBackground(b, p.tolerance ?? 30))},
    {id: 'picture.compress', label: 'Compress Pictures', risk: 'edit', state: picState,
      description: 'Compress Pictures (Picture Format › Adjust): the picture resampled so its longer side is at most `maxPixels` (default 1600).',
      params: s.object({maxPixels: s.optional(s.integer({min: 32, max: 20000}))}),
      run: (ctx, p) => pixelEdit(ctx, (S, o) => o.media, b => X.compress(b, p.maxPixels ?? 1600))},
    {id: 'picture.reset', label: 'Reset Picture', risk: 'edit', state: picState,
      description: 'Reset Picture (Picture Format › Adjust): the original bitmap and no crop; with `size`, the size of what the crop leaves of the original (Reset Picture & Size).',
      params: s.object({size: s.optional(s.boolean())}),
      run: reset},
    {id: 'picture.change', label: 'Change Picture', risk: 'edit', state: picState,
      description: 'Change Picture (Picture Format › Adjust): another picture (`data`, base64 or a data URL) in the same frame; the size, crop and wrapping stay.',
      params: s.object({data: s.optional(s.string({max: 300_000_000})), path: s.optional(s.string({max: 4096}))}),
      async run(ctx, p) {
        if (typeof p.data !== 'string' && typeof p.path === 'string') {
          if (typeof ctx.host?.readFile !== 'function') throw new CommandError('unavailable', 'reading a picture by path is not available here; pass `data` (base64)');
          const got = await ctx.host.readFile(p.path);
          return change(ctx, {data: typeof got === 'string' ? got : base64Encode(new Uint8Array(got))});
        }
        return change(ctx, p);
      }},
    {id: 'picture.style', label: 'Picture Styles', risk: 'edit',
      state: ctx => {
        const st = picState(ctx);
        if (!st.enabled) return st;
        let current = null;
        try { const S = open(ctx); const o = selectedIn(S.d, S.sel)?.obj; current = o?.look?.drawn === o?.media ? o.look.style ?? null : null; } catch { /* none */ }
        return {...st, value: styleItems().map(it => ({...it, selected: it.id === current}))};
      },
      description: 'Picture Styles (Picture Format › Picture Styles): `style` simpleFrame, thickFrame, rounded, softEdge or shadow; it replaces the picture\'s style and border.',
      params: s.object({style: s.optional(s.enum(X.PICTURE_STYLES.map(x => x[0])))}),
      run: (ctx, p) => relook(ctx, l => { l.style = p.style ?? 'simpleFrame'; l.border = null; })},
    {id: 'picture.border', label: 'Picture Border', risk: 'edit', state: picState,
      description: 'Picture Border (Picture Format › Picture Styles): a frame `width` pixels wide (1–200, default 4) in `color` (default black) round the picture, keeping its style; `none` takes it off.',
      params: s.object({color: s.optional(COLOR), width: s.optional(s.number({min: 1, max: 200})), none: s.optional(s.boolean())}),
      run: (ctx, p) => {
        const c = p.color === undefined ? [0, 0, 0] : rgbOf(p.color, 'color');
        const w = clamp(Math.trunc(p.width ?? 4), 1, 200);
        return relook(ctx, l => { l.border = p.none ? null : [c[0], c[1], c[2], w]; });
      }},
  ],
});
