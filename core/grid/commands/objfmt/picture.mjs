// Picture Format: Remove Background, Corrections, Color, Artistic Effects, Transparency, Compress Pictures, Change Picture,
// Reset Picture, Picture Styles, Picture Border, and Crop (a crop box, Crop to Shape, Aspect Ratio, Fill, Fit).
// Not in gridcraft (its pictures keep their bytes, an anchor and an alt text): built from what Excel does. The pixel edits
// (Remove Background, Artistic Effects, Compress) use Quill's bitmap functions (core/quill/lib/picture-pixels.mjs, translated from
// wordcraft picture.rs) on the picture's bytes and keep the original in `orig` for Reset Picture; corrections, colour,
// transparency, crop, the frame shape, border and effects are stored beside the bytes and drawn by the surface (objects.ts) and
// saved as DrawingML (xlsx-drawing.mjs). Not checked against upstream. U:grid/object-format.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {bad, failed} from '../../lib/data-common.mjs';
import {objectRect, anchorAt} from '../../lib/objects.mjs';
import {pick, put, needs, selectedOf} from '../../lib/object-edit.mjs';
import {imageSize, base64ToBytes, bytesToBase64, sniffMime} from '../../lib/image-info.mjs';
import {
  ADJUST_DEFAULT, ADJUST_KEYS, RECOLORS, BRIGHTNESS, CONTRAST, SATURATIONS, TONES, TONE_KELVIN, TRANSPARENCIES, PICTURE_STYLES, PIC_GEOMS, ASPECTS,
  adjustOf, isPlainAdjust, cssFilter, opacityOf, parsePreset, cropOf, normalizeCrop, centeredCrop, styleFx, sanitizedEffects, shapeEffectsIsEmpty,
} from '../../lib/object-fx.mjs';
import * as X from '../../../quill/lib/picture-pixels.mjs';
import {decodeImage, encodePng} from '../../../quill/lib/picture-host.mjs';

const UPSTREAM = {repo: 'office', commit: undefined, files: ['Excel for Windows > Picture Format (not in gridcraft)']};
const HEX = /^#?[0-9a-fA-F]{6}$/;
const MENU = s.optional(s.string({max: 40}));
const ID = s.optional(s.integer({min: 0}));
const upperHex = c => `#${String(c).replace(/^#/, '').toUpperCase()}`;
const pic = (ctx, p, cmd) => pick(ctx, p, cmd, ['image']);
const isPic = ctx => !!selectedOf(ctx, ['image']);
const NEEDS = needs(['image'], 'a picture');
const EFFECTS = X.ARTISTIC_EFFECTS.map(([id]) => id);

// ---- corrections, colour, transparency (stored, drawn with a filter) ------------------------------------------------------

function adjust(ctx, p) {
  const t = pic(ctx, p, 'picture.adjust');
  const patch = p.preset !== undefined ? parsePreset(p.preset) : {};
  if (patch === null) throw bad('picture.adjust', '`preset` is key=value pairs of brightness, contrast, saturation, tone, recolor or transparency');
  for (const k of ADJUST_KEYS) if (p[k] !== undefined) patch[k] = p[k];
  if (!Object.keys(patch).length) throw bad('picture.adjust', 'nothing to adjust');
  const a = {...adjustOf(t.object), ...patch};
  a.brightness = Math.max(-100, Math.min(100, a.brightness));
  a.contrast = Math.max(-100, Math.min(100, a.contrast));
  a.saturation = Math.max(0, Math.min(400, a.saturation));
  a.tone = Math.max(-100, Math.min(100, a.tone));
  a.transparency = Math.max(0, Math.min(100, a.transparency));
  const next = {...t.object};
  if (isPlainAdjust(a)) delete next.adjust; else next.adjust = a;
  put(ctx, t, next);
  return {adjust: a};
}

// ---- pixel edits ---------------------------------------------------------------------------------------------------------

/** Run `op(bitmap)` on the picture's bytes (or its original, `fromOrig`) and make the result its bytes, keeping the original for Reset. */
async function pixelEdit(ctx, p, cmd, op, {fromOrig = false, look} = {}) {
  const t = pic(ctx, p, cmd);
  const source = fromOrig && t.object.orig ? t.object.orig : t.object.data;
  let out;
  try {
    const bmp = await decodeImage(ctx.host, base64ToBytes(source));
    out = await encodePng(ctx.host, op(bmp));
  } catch (e) {
    throw failed(e?.message === 'picture is too large to edit' ? e.message : `can't decode the picture: ${e?.message ?? e}`);
  }
  // The document may have moved on while the picture decoded.
  const t2 = pic(ctx, p, cmd);
  const next = {...t2.object, data: bytesToBase64(out), mime: 'image/png'};
  if (!t2.object.orig) { next.orig = t2.object.data; next.origMime = t2.object.mime; }
  if (look !== undefined) { if (look === null) delete next.look; else next.look = look; }
  put(ctx, t2, next);
  return {pixels: imageSize(out) ?? null};
}

async function artistic(ctx, p) {
  const effect = p.effect ?? 'none';
  if (effect !== 'none' && !EFFECTS.includes(effect)) throw bad('picture.effects', `\`effect\` is none, ${EFFECTS.join(', ')}`);
  if (effect === 'none') {
    const t = pic(ctx, p, 'picture.effects');
    if (!t.object.orig) return {effect: 'none'};
    const next = {...t.object, data: t.object.orig, mime: t.object.origMime ?? t.object.mime};
    delete next.orig; delete next.origMime; delete next.look;
    put(ctx, t, next);
    return {effect: 'none'};
  }
  await pixelEdit(ctx, p, 'picture.effects', b => X.artisticEffect(b, effect), {fromOrig: true, look: {effect}});
  return {effect};
}
const removeBackground = (ctx, p) => pixelEdit(ctx, p, 'picture.removeBackground', b => X.removeBackground(b, p.tolerance ?? 30));
const compress = (ctx, p) => pixelEdit(ctx, p, 'picture.compress', b => X.compress(b, p.maxPixels ?? 1600));

// ---- border, styles ------------------------------------------------------------------------------------------------------

function border(ctx, p) {
  const t = pic(ctx, p, 'picture.border');
  const next = {...t.object};
  if (p.color === 'none' || p.color === 'auto') delete next.border;
  else if (HEX.test(String(p.color ?? ''))) next.border = {color: upperHex(p.color), width: Number.isFinite(p.width) ? p.width : next.border?.width ?? 2.25};
  else if (Number.isFinite(p.width) && next.border) next.border = {...next.border, width: p.width};
  else if (Number.isFinite(p.width)) next.border = {color: '#000000', width: p.width};
  else throw bad('picture.border', '`color` is #RRGGBB or none');
  delete next.pstyle;
  put(ctx, t, next);
  return {border: next.border ?? null};
}

function pictureStyle(ctx, p) {
  const t = pic(ctx, p, 'picture.style');
  const next = {...t.object};
  if (p.style === 'none') { for (const k of ['border', 'geom', 'fx', 'pstyle']) delete next[k]; } else {
    const st = PICTURE_STYLES.find(x => x.id === p.style);
    if (!st) throw bad('picture.style', `no style ${p.style}`);
    if (st.border) next.border = {...st.border}; else delete next.border;
    if (st.geom === 'rect') delete next.geom; else next.geom = st.geom;
    const fx = styleFx(st.fx);
    if (fx) next.fx = sanitizedEffects(fx); else delete next.fx;
    next.pstyle = st.id;
  }
  put(ctx, t, next);
  return {style: p.style};
}

// ---- crop ----------------------------------------------------------------------------------------------------------------

const naturalSize = img => { const b = base64ToBytes(img.data ?? ''); return b ? imageSize(b) : null; };

/** The anchor after the crop changes from `c0` to `c1` (the picture keeps its scale, the frame follows the cut). */
function recropAnchor(sheet, anchor, c0, c1) {
  const sx = anchor.width / Math.max(0.05, 1 - c0.l - c0.r), sy = anchor.height / Math.max(0.05, 1 - c0.t - c0.b);
  const r = objectRect(sheet, anchor);
  const w = sx * (1 - c1.l - c1.r), h = sy * (1 - c1.t - c1.b);
  return anchorAt(sheet, Math.max(0, r.x + sx * (c1.l - c0.l)), Math.max(0, r.y + sy * (c1.t - c0.t)), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), anchor.mode);
}
const merged = (c0, extra) => { const w = 1 - c0.l - c0.r, h = 1 - c0.t - c0.b; return normalizeCrop({l: c0.l + extra.l * w, r: c0.r + extra.r * w, t: c0.t + extra.t * h, b: c0.b + extra.b * h}); };

function crop(ctx, p) {
  const t = pic(ctx, p, 'picture.crop');
  const c0 = cropOf(t.object);
  const next = {...t.object};
  let c1 = c0, anchor = next.anchor;
  const frame = {w: anchor.width, h: anchor.height};
  if (p.aspect !== undefined) {
    const ratio = ASPECTS[p.aspect];
    if (!ratio) throw bad('picture.crop', `\`aspect\` is one of ${Object.keys(ASPECTS).join(', ')}`);
    c1 = merged(c0, centeredCrop(frame.w, frame.h, ratio[0], ratio[1]));
    anchor = recropAnchor(t.sheet, anchor, c0, c1);
  } else if (p.mode === 'fill') {
    // Fill: the picture covers the frame, the surplus is cropped (the frame stays).
    const nat = naturalSize(t.object);
    if (!nat) throw failed('the picture has no size to fill from');
    c1 = merged(c0, centeredCrop(nat[0] * (1 - c0.l - c0.r), nat[1] * (1 - c0.t - c0.b), frame.w, frame.h));
  } else if (p.mode === 'fit') {
    // Fit: the whole picture inside the frame's width, with no crop.
    const nat = naturalSize(t.object);
    c1 = {l: 0, t: 0, r: 0, b: 0};
    if (nat) { const r = objectRect(t.sheet, anchor); anchor = anchorAt(t.sheet, r.x, r.y, anchor.width, Math.max(1, Math.round(anchor.width * nat[1] / nat[0])), anchor.mode); }
  } else if (p.shape !== undefined) {
    if (!PIC_GEOMS.includes(p.shape)) throw bad('picture.crop', `\`shape\` is one of ${PIC_GEOMS.join(', ')}`);
    if (p.shape === 'rect') delete next.geom; else next.geom = p.shape;
  } else {
    c1 = normalizeCrop({l: p.left ?? c0.l, t: p.top ?? c0.t, r: p.right ?? c0.r, b: p.bottom ?? c0.b});
    anchor = recropAnchor(t.sheet, anchor, c0, c1);
  }
  next.anchor = anchor;
  if (c1.l || c1.t || c1.r || c1.b) next.crop = c1; else delete next.crop;
  delete next.pstyle;
  put(ctx, t, next);
  return {crop: next.crop ?? null, width: anchor.width, height: anchor.height};
}

function cropMode(ctx, p) {
  const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.cropMode;
  ctx.setView({cropMode: on});
  return {on};
}

// ---- reset, change -------------------------------------------------------------------------------------------------------

function reset(ctx, p) {
  const t = pic(ctx, p, 'picture.reset');
  const next = {...t.object};
  if (next.orig) { next.data = next.orig; next.mime = next.origMime ?? next.mime; }
  for (const k of ['adjust', 'crop', 'border', 'geom', 'fx', 'orig', 'origMime', 'look', 'pstyle']) delete next[k];
  if (p.size === true) {
    const nat = naturalSize(next);
    if (nat) { const r = objectRect(t.sheet, t.object.anchor); next.anchor = anchorAt(t.sheet, r.x, r.y, nat[0], nat[1], t.object.anchor.mode); }
  } else if (t.object.crop) next.anchor = recropAnchor(t.sheet, t.object.anchor, cropOf(t.object), {l: 0, t: 0, r: 0, b: 0});
  put(ctx, t, next);
  return {reset: true, size: p.size === true};
}

function changePicture(ctx, p) {
  const t = pic(ctx, p, 'picture.change');
  const text = p.base64 ?? p.dataUrl;
  if (typeof text !== 'string' || !text) {
    ctx.setView({dialogRequest: {seq: (ctx.view?.dialogRequest?.seq ?? 0) + 1, id: 'dialog.changePicture', init: {}}});
    return null;
  }
  const bytes = base64ToBytes(text);
  if (!bytes || !bytes.length) throw bad('picture.change', 'invalid base64');
  if (bytes.length > 64 * 1024 * 1024) throw bad('picture.change', 'image larger than 64 MB');
  const mime = typeof p.mime === 'string' && p.mime ? p.mime : sniffMime(bytes) ?? 'image/png';
  const next = {...t.object, data: text.replace(/^data:[^,]*,/, '').replace(/\s+/g, ''), mime};
  for (const k of ['orig', 'origMime', 'look']) delete next[k];
  put(ctx, t, next);
  return {changed: t.object.id};
}

// ---- gallery tiles -------------------------------------------------------------------------------------------------------

const tile = (id, label, value, art, group, selected) => ({id, label, value, art, group, selected: !!selected, iconOnly: true});
const sign = n => (n > 0 ? `+${n}` : String(n));

function adjustTiles(ctx, menu) {
  const cur = adjustOf(selectedOf(ctx, ['image'])?.object);
  const photo = a => ({kind: 'objPhoto', filter: cssFilter(a), opacity: opacityOf(a)});
  const out = [];
  if (menu === 'corrections') {
    for (const b of BRIGHTNESS) for (const c of CONTRAST) {
      out.push(tile(`bc${b}_${c}`, `Brightness: ${sign(b)}% Contrast: ${sign(c)}%`, `brightness=${b},contrast=${c}`, photo({...ADJUST_DEFAULT, brightness: b, contrast: c}), 'Brightness/Contrast', cur.brightness === b && cur.contrast === c));
    }
  } else if (menu === 'color') {
    for (const v of SATURATIONS) out.push(tile(`sat${v}`, `Saturation: ${v}%`, `saturation=${v}`, photo({...ADJUST_DEFAULT, saturation: v}), 'Color Saturation', cur.saturation === v));
    for (const v of TONES) out.push(tile(`tone${v}`, `Temperature: ${TONE_KELVIN[v]} K`, `tone=${v}`, photo({...ADJUST_DEFAULT, tone: v}), 'Color Tone', cur.tone === v));
    for (const [id, label] of RECOLORS) out.push(tile(`rc${id || 'none'}`, label, `recolor=${id}`, photo({...ADJUST_DEFAULT, recolor: id}), 'Recolor', cur.recolor === id));
  } else if (menu === 'transparency') {
    for (const v of TRANSPARENCIES) out.push(tile(`tr${v}`, `Transparency: ${v}%`, `transparency=${v}`, photo({...ADJUST_DEFAULT, transparency: v}), 'Picture Transparency', cur.transparency === v));
  }
  return out;
}

const styleTiles = ctx => {
  const img = selectedOf(ctx, ['image'])?.object;
  return PICTURE_STYLES.map(st => tile(st.id, st.label, st.id, {kind: 'objPhoto', border: st.border?.color ?? null, borderWidth: st.border ? Math.min(5, st.border.width / 3) : 0, shape: st.geom, shadow: st.fx === 'shadow' || st.fx === 'center' || st.fx === 'reflection'}, undefined, img?.pstyle === st.id));
};
const EFFECT_FILTER = {blur: 'blur(1.2px)', sharpen: 'contrast(1.35) saturate(1.15)', invert: 'invert(1)', posterize: 'contrast(1.9) saturate(1.6)', pixelate: 'contrast(1.2) saturate(0.9)'};
const artisticTiles = ctx => {
  const cur = selectedOf(ctx, ['image'])?.object?.look?.effect ?? 'none';
  return [{id: 'none', label: 'None', value: 'none', selected: cur === 'none', iconOnly: true, art: {kind: 'objPhoto'}},
    ...X.ARTISTIC_EFFECTS.map(([id, label]) => ({id, label, value: id, selected: cur === id, iconOnly: true, art: {kind: 'objPhoto', filter: EFFECT_FILTER[id]}}))];
};

export default defineCommands({
  family: 'objfmt/picture',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'picture.adjust', label: 'Picture Corrections', risk: 'edit',
      description: 'Corrections of the selected picture: `preset` ("brightness=20,contrast=-20") or `brightness`, `contrast` (-100 to 100), `saturation` (0 to 400), `tone` (-100 to 100), `recolor` (grayscale, sepia, washout, blackWhite or empty), `transparency` (0 to 100).',
      params: s.object({preset: s.optional(s.string({max: 200})), brightness: s.optional(s.number()), contrast: s.optional(s.number()), saturation: s.optional(s.number()), tone: s.optional(s.number()),
        recolor: s.optional(s.string({max: 20})), transparency: s.optional(s.number()), id: ID, menu: MENU}),
      state: (ctx, p) => ({...NEEDS(ctx), value: adjustTiles(ctx, p?.menu)}), run: adjust},
    {id: 'picture.effects', label: 'Artistic Effects', risk: 'edit',
      description: `An artistic effect on the selected picture's pixels (\`effect\`: none, ${EFFECTS.join(', ')}); one at a time, a second replaces the first, none takes it off.`,
      params: s.object({effect: s.optional(s.string({max: 20})), id: ID}), state: ctx => ({...NEEDS(ctx), value: artisticTiles(ctx)}), run: artistic},
    {id: 'picture.removeBackground', label: 'Remove Background', risk: 'edit',
      description: 'Remove Background: the area connected to the picture\'s edge that is close to its corner colour (`tolerance` 0 to 255, default 30) becomes transparent.',
      params: s.object({tolerance: s.optional(s.number({min: 0, max: 255})), id: ID}), state: NEEDS, run: removeBackground},
    {id: 'picture.compress', label: 'Compress Pictures', risk: 'edit',
      description: 'Compress Pictures: the picture resampled so its longer side is at most `maxPixels` (default 1600).',
      params: s.object({maxPixels: s.optional(s.integer({min: 32, max: 20000})), id: ID}), state: NEEDS, run: compress},
    {id: 'picture.border', label: 'Picture Border', risk: 'edit',
      description: 'The border of the selected picture: `color` #RRGGBB or none, `width` in pixels (a width alone keeps the colour).',
      params: s.object({color: s.optional(s.string({max: 20})), width: s.optional(s.number({min: 0.25, max: 100})), id: ID}), state: NEEDS, run: border},
    {id: 'picture.style', label: 'Picture Styles', risk: 'edit',
      description: `A picture style (a border, a frame shape and an effect): ${PICTURE_STYLES.map(x => x.id).join(', ')}, or none.`,
      params: s.object({style: s.string({max: 40}), id: ID, menu: MENU}), state: ctx => ({...NEEDS(ctx), value: styleTiles(ctx)}), run: pictureStyle},
    {id: 'picture.crop', label: 'Crop', risk: 'edit',
      description: 'Crop the selected picture: `left`, `top`, `right`, `bottom` (fractions of the picture, 0 to 0.95), or `aspect` (1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 16:10: cut from the middle), `mode` fill or fit, or `shape` to crop to a shape.',
      params: s.object({left: s.optional(s.number()), top: s.optional(s.number()), right: s.optional(s.number()), bottom: s.optional(s.number()), aspect: s.optional(s.string({max: 8})),
        mode: s.optional(s.enum(['fill', 'fit'])), shape: s.optional(s.string({max: 20})), id: ID}), state: NEEDS, run: crop},
    {id: 'picture.cropMode', label: 'Crop', risk: 'read', effect: 'view',
      description: 'Turn crop handles on or off for the selected picture: dragging a handle cuts that side.',
      params: s.object({on: s.optional(s.boolean())}), state: ctx => ({...NEEDS(ctx), checked: !!ctx.view?.cropMode && isPic(ctx)}), run: cropMode},
    {id: 'picture.reset', label: 'Reset Picture', risk: 'edit',
      description: 'Undo a picture\'s pixel edits, corrections, colour, crop, border, style, effects (`size` true: and its size).',
      params: s.object({size: s.optional(s.boolean()), id: ID}), state: NEEDS, run: reset},
    {id: 'picture.change', label: 'Change Picture', risk: 'edit', dialog: 'dialog.changePicture',
      description: 'Put another picture (PNG or JPEG bytes as `base64`) in the selected picture\'s place; its size and formatting stay. With no picture it opens the Change Picture dialog.',
      params: s.object({base64: s.optional(s.string({max: 90_000_000})), dataUrl: s.optional(s.string({max: 90_000_000})), mime: s.optional(s.string({max: 60})), id: ID}), state: NEEDS, run: changePicture},
  ],
});

export {sanitizedEffects, shapeEffectsIsEmpty};
