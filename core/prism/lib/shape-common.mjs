// What the Shape Format, Insert, Arrange and Picture families share: the engine's parameter
// helpers (`color_value`, `rect_param`, `gradient_param`), editing the targeted shapes in one
// transaction (`edit_shapes`, `edit_geometry`), adding a shape to the current slide (`add_shape`,
// `auto_name_base`, `first_free_name`, `default_rect`), media (`media_bytes`, `content_type`,
// `add_media`, the natural size of a picture) and the theme quick styles (`quick_style_for`).
// Translated from deckcraft crates/engine/src/cmd.rs (`color_value`, `rect_param`, `edit_shapes`,
// `edit_geometry`, `current_shapes`, `current_names`, `base64_decode`), cmd/insert.rs
// (`default_rect`, `auto_name_base`, `first_free_name`, `add_shape`), cmd/insert/picture.rs
// (`media_bytes`, `content_type`, `fitted`), cmd/shape/appearance.rs (`gradient_param`,
// `quick_style_for`), cmd/shape/size.rs (`clamp_side`, `clamp_pos`), and crates/model/src/lib.rs
// (`add_media`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:prism/shape owns this file; the
// insert, arrange, picture_style and format families import it. No DOM, no Node built-ins.

import {bad, targets as selTargets, idOf} from './text-session.mjs';
import {SLOTS, fromHex, preset as presetColor, isPresetName, isSystemName, transformFromXml} from '../model/color.mjs';
import {colorRgb, colorScheme, colorWith, accentStyle, fillNone, fillSolid} from '../model/style.mjs';
import {findShape, allocId, isGroup, presetName} from '../model/presentation.mjs';
import {info as presetInfo} from '../model/geom/preset/catalog.mjs';
import {cleanXfrm} from '../model/geom/index.mjs';
import {formatAll} from '../model/edit.mjs';
import {isSchema2, currentSlideId, selectedShapeIds, textSelection, slideById, shapeJsonPath, slidePath, xfrmOf, selectShapes, shapeChain} from '../model/doc.mjs';

export {bad};
export const UPSTREAM_COMMIT = 'f893f6af7d36a5409fd804e81a34fd895cfefedf';
/** deckcraft `cmd::NO_ID_SPACE`. */
export const NO_ID_SPACE = 'the presentation has used every object id and can hold no more';
export const NOTHING_SELECTED = 'nothing selected';
export const SELECT_TWO = 'select two or more objects';
export const NO_TEXT_POINT = 'no text insertion point';
export const SELECT_TEXT_OR_SHAPE = 'select text or a shape';

// ---------------------------------------------------------------------------------------------
// Enabled predicates (deckcraft `has_doc`, `has_slide`, `has_selection`, `has_two`, `has_text_or_shapes`)

const noDoc = {enabled: false, reason: 'no presentation open'};
export const always = () => ({enabled: true});
export const hasDoc = ctx => (isSchema2(ctx.doc) ? {enabled: true} : noDoc);
export const hasSlide = ctx => (!isSchema2(ctx.doc) ? noDoc : ctx.doc.slides.length ? {enabled: true} : {enabled: false, reason: 'no slides'});
export const hasSelection = ctx => (!isSchema2(ctx.doc) ? noDoc
  : selectedShapeIds(ctx.doc, ctx.selection).length ? {enabled: true} : {enabled: false, reason: NOTHING_SELECTED});
export const hasTwo = ctx => (!isSchema2(ctx.doc) ? noDoc
  : selectedShapeIds(ctx.doc, ctx.selection).length >= 2 ? {enabled: true} : {enabled: false, reason: SELECT_TWO});
export const hasTextOrShapes = ctx => (!isSchema2(ctx.doc) ? noDoc
  : textSelection(ctx.doc, ctx.selection) || selectedShapeIds(ctx.doc, ctx.selection).length ? {enabled: true} : {enabled: false, reason: SELECT_TEXT_OR_SHAPE});
export const hasText = ctx => (!isSchema2(ctx.doc) ? noDoc : textSelection(ctx.doc, ctx.selection) ? {enabled: true} : {enabled: false, reason: NO_TEXT_POINT});

// ---------------------------------------------------------------------------------------------
// Parameters

export const num = (p, k) => (typeof p?.[k] === 'number' && Number.isFinite(p[k]) ? p[k] : undefined);
export const bool = (p, k) => (typeof p?.[k] === 'boolean' ? p[k] : undefined);
export const str = (p, k) => (typeof p?.[k] === 'string' ? p[k] : undefined);
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
/** `usize_param`: a non-negative integer, else undefined. */
export const usize = (p, k) => (Number.isSafeInteger(p?.[k]) && p[k] >= 0 ? p[k] : undefined);

/** `rect_param`: `[x, y, w, h]` in points (negative sizes are made positive). */
export function rectParam(p, key) {
  const a = p?.[key];
  if (!Array.isArray(a)) return undefined;
  const f = i => (typeof a[i] === 'number' && Number.isFinite(a[i]) ? a[i] : undefined);
  if ([0, 1, 2, 3].some(i => f(i) === undefined)) return undefined;
  return {x: f(0), y: f(1), w: Math.abs(f(2)), h: Math.abs(f(3))};
}

/** `targets`: `ids` / `id`, else the selected shapes (ids as strings). */
export const targets = (ctx, p, cmd = 'shape') => selTargets(ctx, p, cmd);
export {idOf};

/**
 * `color_value`: `"#RRGGBB"`, `"accent1"`…, a preset name (`"red"`), or
 * `{scheme | preset | system+last | rgb, <transform>: value…}`. Transforms are read in key order
 * as serde_json's map gives them (sorted), so `{scheme, lumMod, lumOff}` reads lumMod then lumOff.
 * Returns a ColorRef or null.
 */
export function colorValue(v) {
  if (typeof v === 'string') {
    if (SLOTS.includes(v)) return colorScheme(v);
    const c = fromHex(v);
    if (c) return colorRgb(c);
    const pc = presetColor(v);
    return pc ? colorRgb(pc) : null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let c;
  if (typeof v.scheme === 'string') {
    if (!SLOTS.includes(v.scheme)) return null;
    c = colorScheme(v.scheme);
  } else if (typeof v.preset === 'string') {
    if (!isPresetName(v.preset)) return null;
    c = {base: {kind: 'preset', name: v.preset}};
  } else if (typeof v.system === 'string') {
    if (!isSystemName(v.system)) return null;
    const last = typeof v.last === 'string' ? fromHex(v.last) : null;
    if (!last) return null;
    c = {base: {kind: 'system', name: v.system, last}};
  } else {
    const rgb = typeof v.rgb === 'string' ? fromHex(v.rgb) : null;
    if (!rgb) return null;
    c = colorRgb(rgb);
  }
  for (const k of Object.keys(v).sort()) {
    const val = v[k];
    const n = typeof val === 'number' && Number.isInteger(val) && Math.abs(val) <= 2147483647 ? val : undefined;
    const t = transformFromXml(k, n ?? 0);
    if (t) c = colorWith(c, t);
  }
  return c;
}
export const colorParam = (p, key) => (p?.[key] === undefined ? null : colorValue(p[key]));

/** A ColorRef's alpha (0–1) from its alpha transform. */
export const colorAlphaOf = c => (c?.mods ?? []).reduce((a, m) => (m.op === 'alpha' ? m.val / 100000 : a), 1);
/** `with_alpha`: `c` with its alpha set to `a` (0–1); fully opaque drops the transform. */
export function withAlpha(c, a) {
  const mods = (c.mods ?? []).filter(m => m.op !== 'alpha');
  if (a < 1) mods.push({op: 'alpha', val: Math.round(clamp(a, 0, 1) * 100000)});
  const out = {...c, mods};
  if (!mods.length) delete out.mods;
  return out;
}

/**
 * `gradient_param`: `{stops: [[pos 0–1, color], …], kind?: linear|radial|rectangular|path,
 * angle?: deg, focus?: [l, t, r, b], rotateWithShape?}` → a gradient fill body, or null.
 */
export function gradientParam(v) {
  if (!v || !Array.isArray(v.stops)) return null;
  const stops = [];
  for (const st of v.stops) {
    if (!Array.isArray(st) || typeof st[0] !== 'number' || !Number.isFinite(st[0])) continue;
    const color = colorValue(st[1]);
    if (!color) continue;
    stops.push({pos: clamp(st[0], 0, 1), color});
  }
  if (stops.length < 2) return null;
  let focus = [0.5, 0.5, 0.5, 0.5];
  if (Array.isArray(v.focus)) {
    const f = v.focus.slice(0, 4).map(x => (typeof x === 'number' && Number.isFinite(x) ? clamp(x, 0, 1) : null));
    if (f.length === 4 && f.every(x => x !== null)) focus = f;
  }
  stops.sort((a, b) => a.pos - b.pos);
  const path = name => ({kind: 'path', path: name, focus});
  let shape;
  switch (v.kind) {
    case 'radial': case 'circle': shape = path('circle'); break;
    case 'rectangular': case 'rect': shape = path('rect'); break;
    case 'path': case 'shape': shape = path('shape'); break;
    default: {
      const a = typeof v.angle === 'number' && Number.isFinite(v.angle) ? v.angle : 90;
      shape = {kind: 'linear', angle: ((a % 360) + 360) % 360, scaled: false};
    }
  }
  return {stops, shape, rotateWithShape: typeof v.rotateWithShape === 'boolean' ? v.rotateWithShape : true};
}

// ---------------------------------------------------------------------------------------------
// Sizes (deckcraft cmd/shape/size.rs)

export const MIN_PT = 0.01;
export const MAX_PT = 15840;
export const POS_LIMIT = 100000;
/** `clamp_side`: a side length in 0..=MAX_PT (NaN → 0). */
export const clampSide = v => (Number.isNaN(v) ? 0 : clamp(v, 0, MAX_PT));
/** `clamp_pos`: a coordinate within ±POS_LIMIT (NaN → 0). */
export const clampPos = v => (Number.isNaN(v) ? 0 : clamp(v, -POS_LIMIT, POS_LIMIT));

// ---------------------------------------------------------------------------------------------
// The current slide and its shapes (deckcraft `current_shapes`, `shapes_mut`)

/** The current slide (deckcraft `selection.slide` with Target::Slides). Throws `no slide` for `cmd`. */
export function currentSlide(ctx, cmd) {
  const id = currentSlideId(ctx.doc, ctx.selection);
  const sl = id ? slideById(ctx.doc, id) : null;
  if (!sl) throw bad(cmd, 'no slide');
  return sl;
}
export const shapeById = (ctx, sl, id) => findShape(sl?.shapes, id);
/** `current_names`: names of the top-level shapes on the current slide. */
export const currentNames = sl => new Set((sl?.shapes ?? []).map(s => s.name ?? ''));

/** Write a (possibly group-nested) shape back by id. */
export function writeShape(ctx, slideId, sh) {
  const path = shapeJsonPath(ctx.doc, slideId, sh.id);
  if (!path) throw bad('shape', `no shape ${sh.id}`);
  ctx.change.set(path, sh);
}
/** Replace the current slide's top-level shape list. */
export function writeShapes(ctx, slideId, list) {
  const sp = slidePath(ctx.doc, slideId);
  if (!sp) throw bad('shape', 'no slide');
  ctx.change.set([...sp, 'shapes'], list);
}

/** Select shapes on a slide (deckcraft `sel.shapes = ids; sel.text = None`). */
export function selectIds(ctx, slideId, ids) {
  const sl = slideById(ctx.doc, slideId);
  const chains = ids.map(id => shapeChain(sl, id)).filter(Boolean);
  ctx.setSelection(selectShapes(slideId, chains));
}

/**
 * `edit_shapes`: run `f(shape)` on each target (a deep copy, written back whole), materialising an
 * inherited box first. Returns the count; throws `no shapes selected` / `no such shape`.
 */
export function editShapes(ctx, p, cmd, f, ids = targets(ctx, p, cmd)) {
  if (!ids.length) throw bad(cmd, 'no shapes selected');
  const sl = currentSlide(ctx, cmd);
  let n = 0;
  for (const id of ids) {
    const cur = findShape(slideById(ctx.doc, sl.id).shapes, id);
    if (!cur) continue;
    const sh = structuredClone(cur);
    if (!sh.xfrm) sh.xfrm = xfrmOf(ctx.doc, sl.id, cur);
    f(sh);
    if (sh.xfrm) sh.xfrm = cleanXfrm(sh.xfrm);
    writeShape(ctx, sl.id, sh);
    n++;
  }
  if (n === 0) throw bad(cmd, 'no such shape');
  return n;
}

/** `edit_geometry`: `edit_shapes` leaving locked objects out; all locked → `the object is locked`. */
export function editGeometry(ctx, p, cmd, f) {
  const ids = targets(ctx, p, cmd);
  const sl = currentSlide(ctx, cmd);
  const free = ids.filter(id => !findShape(sl.shapes, id)?.locked);
  if (ids.length && !free.length) throw bad(cmd, 'the object is locked');
  return editShapes(ctx, {...p, ids: free}, cmd, f, free.length ? free : targets(ctx, {...p, ids: []}, cmd));
}

/** Apply `f` to a shape and everything in it (Fill and Outline reach a group's members). */
export function applyDeep(sh, f, depth = 0) {
  if (depth > 64) return;
  f(sh);
  if (isGroup(sh)) for (const c of sh.kind.children ?? []) applyDeep(c, f, depth + 1);
}

// ---------------------------------------------------------------------------------------------
// Adding shapes (deckcraft cmd/insert.rs)

/** `default_rect`: a `w`×`h` box centred on the slide. */
export function defaultRect(ctx, w, h) {
  const size = ctx.doc?.slideSize ?? {width: 960, height: 540};
  return {x: (size.width - w) / 2, y: (size.height - h) / 2, w, h};
}

/** `auto_name_base`: the word an automatic shape name starts with ("Rectangle" in "Rectangle 3"). */
export function autoNameBase(sh) {
  const k = sh?.kind?.type;
  if (k === 'picture') return 'Picture';
  if (k === 'table') return 'Table';
  if (k === 'chart') return 'Chart';
  if (k === 'media') return sh.kind.video ? 'Video' : 'Audio';
  if (k === 'model3d') return '3D Model';
  if (sh.textBox) return 'TextBox';
  const name = sh.geom?.kind === 'custom' ? null : presetName(sh.geom);
  const i = name ? presetInfo(name) : null;
  return i ? i.label.split(':')[0].trim() : 'Shape';
}
/** `first_free_name`: "{base} n" with the first n from the shape count + 1 not already used. */
export function firstFreeName(base, taken) {
  for (let n = taken.size + 1; ; n++) {
    const c = `${base} ${n}`;
    if (!taken.has(c)) return c;
  }
}

/** A fresh id (deckcraft `alloc_id`), written to `nextId`. */
export function newId(ctx, cmd) {
  const a = allocId(ctx.doc);
  if (!a) throw bad(cmd, NO_ID_SPACE);
  ctx.change.set(['nextId'], a[1]);
  return a[0];
}

/** `add_shape`: give `shape` an id and a free automatic name, append it to the current slide and (when `select`) select it. */
export function addShape(ctx, cmd, shape, select) {
  const sl = currentSlide(ctx, 'insert');
  const sh = {...shape, id: newId(ctx, cmd)};
  if (!sh.name) sh.name = firstFreeName(autoNameBase(sh), currentNames(slideById(ctx.doc, sl.id)));
  if (sh.xfrm) sh.xfrm = cleanXfrm(sh.xfrm);
  const sp = slidePath(ctx.doc, sl.id);
  ctx.change.splice([...sp, 'shapes'], slideById(ctx.doc, sl.id).shapes.length, 0, sh);
  if (select) selectIds(ctx, sl.id, [sh.id]);
  return sh.id;
}

// ---------------------------------------------------------------------------------------------
// Media (deckcraft cmd/insert/picture.rs, crates/model `add_media`)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; t[45] = 62; t[95] = 63; return t; })();
/** `base64_decode` (standard or URL alphabet, padding optional, whitespace ignored): bytes or null. */
export function base64Decode(sIn) {
  const s = String(sIn).replace(/[\s=]/g, '');
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INV[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}
export function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

/**
 * `media_bytes`: `{data: base64, name?}` or `{path}`. A path is read through the host
 * (`host.readFile`, the main process's file service) when it offers one; otherwise the UI sends
 * the bytes it read from the system Open dialog.
 */
export async function mediaBytes(ctx, p, cmd) {
  if (typeof p.data === 'string') {
    const raw = p.data.replace(/^data:[^;,]*;base64,/, '');
    const bytes = base64Decode(raw);
    if (!bytes) throw bad(cmd, 'invalid base64 `data`');
    return {name: typeof p.name === 'string' && p.name ? p.name : 'media', bytes};
  }
  if (typeof p.path === 'string') {
    const read = ctx.host?.readFile ?? ctx.host?.files?.readFile;
    if (typeof read !== 'function') throw new (await import('../../kernel/errors.mjs')).CommandError('unavailable', `${cmd}: reading files is not available here; send \`data\``);
    const data = await read(p.path);
    const bytes = typeof data === 'string' ? base64Decode(data) : data instanceof Uint8Array ? data : data ? new Uint8Array(data) : null;
    if (!bytes) throw bad(cmd, `could not read ${p.path}`);
    const name = String(p.path).split(/[\\/]/).pop() || 'media';
    return {name, bytes};
  }
  throw bad(cmd, 'missing `path` or `data`');
}

const starts = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === (typeof v === 'string' ? v.charCodeAt(0) : v));
const ascii = s => [...s];
/** `content_type`: the media type from the bytes' signature (and the name). */
export function contentType(name, b) {
  const l = String(name).toLowerCase();
  if (starts(b, [0x89, 'P', 'N', 'G'])) return 'image/png';
  if (starts(b, [0xff, 0xd8])) return 'image/jpeg';
  if (starts(b, ascii('GIF8'))) return 'image/gif';
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8)) return 'image/webp';
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WAVE'), 8)) return 'audio/wav';
  if (starts(b, ascii('BM'))) return 'image/bmp';
  if (starts(b, ['I', 'I', '*', 0]) || starts(b, ['M', 'M', 0, '*'])) return 'image/tiff';
  if (starts(b, ascii('fLaC'))) return 'audio/flac';
  if (starts(b, ascii('OggS'))) return l.endsWith('.ogv') ? 'video/ogg' : 'audio/ogg';
  if (b.length > 1 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (starts(b, ascii('ID3')) || (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && !l.endsWith('.aac'))) return 'audio/mpeg';
  if (starts(b, ascii('FORM'))) return 'audio/aiff';
  if (starts(b, ascii('ftyp'), 4)) {
    if (l.endsWith('.m4a') || l.endsWith('.m4b') || starts(b, ascii('M4A'), 8)) return 'audio/mp4';
    if (l.endsWith('.mov') || starts(b, ascii('qt  '), 8)) return 'video/quicktime';
    return 'video/mp4';
  }
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (l.endsWith('.mka') || l.endsWith('.weba')) return 'audio/webm';
    if (l.endsWith('.mkv')) return 'video/x-matroska';
    return 'video/webm';
  }
  if (starts(b, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return l.endsWith('.wmv') || l.endsWith('.asf') ? 'video/x-ms-wmv' : 'audio/x-ms-wma';
  if (starts(b, ascii('caff'))) return 'audio/x-caf';
  if (l.endsWith('.svg') || hasSvgTag(b)) return 'image/svg+xml';
  if (l.endsWith('.aac')) return 'audio/aac';
  return 'application/octet-stream';
}
function hasSvgTag(b) {
  const n = Math.min(b.length - 3, 512);
  for (let i = 0; i < n; i++) if (b[i] === 0x3c && b[i + 1] === 0x73 && b[i + 2] === 0x76 && b[i + 3] === 0x67) return true;
  return false;
}

/** Pixel size from an image's header (PNG, JPEG, GIF, BMP, WebP, SVG width/height); null when unreadable. */
export function imageDimensions(b) {
  const u32be = i => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u16be = i => (b[i] << 8) | b[i + 1];
  const u16le = i => b[i] | (b[i + 1] << 8);
  const i32le = i => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  if (starts(b, [0x89, 'P', 'N', 'G']) && b.length >= 24) return {w: u32be(16), h: u32be(20)};
  if (starts(b, ascii('GIF8')) && b.length >= 10) return {w: u16le(6), h: u16le(8)};
  if (starts(b, ascii('BM')) && b.length >= 26) return {w: Math.abs(i32le(18)), h: Math.abs(i32le(22))};
  if (starts(b, [0xff, 0xd8])) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = u16be(i + 2);
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return {w: u16be(i + 7), h: u16be(i + 5)};
      i += 2 + len;
    }
    return null;
  }
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8) && b.length >= 30) {
    if (starts(b, ascii('VP8X'), 12)) return {w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16))};
    if (starts(b, ascii('VP8 '), 12)) return {w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff};
    if (starts(b, ascii('VP8L'), 12)) { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return {w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1}; }
  }
  return null;
}

/** `fitted`: an image's natural size in points (96 dpi), fitted inside 90% of the slide. */
export function fittedSize(ctx, bytes) {
  const d = imageDimensions(bytes);
  const [w, h] = d && d.w > 0 && d.h > 0 ? [d.w * 0.75, d.h * 0.75] : [288, 216];
  const size = ctx.doc?.slideSize ?? {width: 960, height: 540};
  const k = Math.min(size.width * 0.9 / Math.max(w, 1), size.height * 0.9 / Math.max(h, 1), 1);
  return [w * k, h * k];
}

/** `Presentation::add_media`: the same bytes reuse their media item; else a new one (base64 data). */
export function addMedia(ctx, cmd, name, ct, bytes) {
  const data = base64Encode(bytes);
  const hit = (ctx.doc.media ?? []).find(m => m.data === data);
  if (hit) return hit.id;
  const id = newId(ctx, cmd);
  const list = ctx.doc.media ?? [];
  if (!ctx.doc.media) ctx.change.set(['media'], []);
  ctx.change.splice(['media'], list.length, 0, {id, name, contentType: ct, data, link: null});
  return id;
}

/** deckcraft `PictureAdjust::default()`. */
export const pictureAdjustDefault = () => ({brightness: 0, contrast: 0, saturation: null, grayscale: false, duotone: null, clearColor: null, sharpen: 0});
/** deckcraft `PictureFill { media, ..Default::default() }`. */
export const pictureFill = (media, crop = [0, 0, 0, 0]) => ({media, crop, mode: {kind: 'stretch', fillRect: [0, 0, 0, 0]}, alpha: null, adjust: pictureAdjustDefault()});
/** deckcraft `Line::default()` and `Effects::default()`. */
export const lineDefault = () => ({fill: null, width: null, dash: null, cap: null, join: null, compound: null, head: null, tail: null});
/** deckcraft `Line::none()`. */
export const lineNoneFull = () => ({...lineDefault(), fill: fillNone()});
export const effectsDefault = () => ({outerShadow: null, innerShadow: null, glow: null, softEdge: null, reflection: null, bevel: null, raw3d: null, fillOverlay: null});

// ---------------------------------------------------------------------------------------------
// Theme quick styles (deckcraft cmd/shape/appearance.rs `quick_style_for`)

const QS_SLOTS = ['dk1', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
/** 7 rows (outline only, solid fill variants, intense…) × 7 colours (dark 1, accents 1–6): [style, fill, line]. */
export function quickStyleFor(index) {
  const slot = QS_SLOTS[index % 7] ?? 'accent1';
  const row = Math.floor(index / 7);
  const st = accentStyle(slot);
  const c = colorScheme(slot);
  switch (row) {
    case 0:
      st.fillRef = [1, colorScheme('lt1')];
      st.lineRef = [2, c];
      st.fontRef = [st.fontRef[0], colorScheme('dk1')];
      return [st, null, null];
    case 1: return [st, null, null];
    case 2:
      st.fillRef = [1, colorWith(colorWith(c, {op: 'lumMod', val: 20000}), {op: 'lumOff', val: 80000})];
      st.lineRef = [0, c];
      st.fontRef = [st.fontRef[0], colorWith(c, {op: 'lumMod', val: 50000})];
      return [st, null, lineNoneFull()];
    case 3:
      st.fillRef = [2, c];
      return [st, null, lineNoneFull()];
    case 4:
      st.fillRef = [3, c];
      st.effectRef = [3, c];
      return [st, null, lineNoneFull()];
    default:
      st.fillRef = [1, colorWith(c, {op: 'lumMod', val: 75000})];
      st.lineRef = [1, colorScheme('lt1')];
      return [st, null, null];
  }
}
export {fillNone, fillSolid, colorRgb, colorScheme, colorWith};

// ---------------------------------------------------------------------------------------------
// Painted formatting (deckcraft cmd/format/painter.rs `Painted`, `apply_painted`): what the Format
// Painter picks up and what Set as Default Shape keeps for new shapes. Session state, kept in the
// document's view state (`view.painter`, `view.defaultLook`), never in the file or the undo stack.

/** `apply_painted`: a shape takes the painted fill, outline, effects and style, and its text the painted run. */
export function applyPainted(sh, painted) {
  if (!painted) return;
  if (painted.fill != null || painted.style != null) {
    sh.fill = painted.fill ?? null;
    sh.line = painted.line ?? null;
    sh.effects = painted.effects ?? null;
    sh.style = painted.style ?? null;
  }
  if (painted.run && sh.text) sh.text = formatAll(sh.text, () => ({...painted.run}));
}
