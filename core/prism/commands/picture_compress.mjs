// Picture Format › Adjust › Compress Pictures: downsample pictures to a target resolution for the size
// they are shown at, and optionally delete their cropped-away areas. The picture is re-encoded as PNG,
// or as JPEG (quality 85) when it was one and has no transparency (the renderer host's `decodeImage`
// and `encodeImage`); other formats (GIF, SVG, metafiles) are left alone, and a picture never grows.
// Translated from deckcraft crates/engine/src/cmd/compress.rs (`pack`, `compress`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The area-average resample stands in for deckcraft's Lanczos.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, always, targets, currentSlide, writeShapes, addMedia, base64Decode, contentType} from '../lib/shape-common.mjs';
import {findShape} from '../model/presentation.mjs';
import {isSchema2, slideById} from '../model/doc.mjs';
import {decodeImage, encodePng, cropImage, resizeImage, hasAlpha, isPng} from '../lib/raster.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/compress.rs']};
/** Largest picture decoded for compression (a 61 MP camera frame fits); bigger ones are left as they are. */
const MAX_PIXELS = 64_000_000;
const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);

/** Whether `crop` cuts something away (and only cuts: negative values pad, and are kept). */
const realCrop = c => c.every(v => v >= 0 && v < 1) && c.some(v => v > 0) && c[0] + c[2] < 1 && c[1] + c[3] < 1;

/** Compress `bytes` for a picture shown `wPt` × `hPt` with `crop` at `ppi`; null when nothing would get smaller. */
async function pack(host, bytes, ct, crop, wPt, hPt, ppi, deleteCropped) {
  const png = isPng(bytes), jpeg = ct === 'image/jpeg';
  if (!png && !jpeg) return null;
  let img = await decodeImage(bytes, host);
  if (!img || img.width < 1 || img.height < 1 || img.width * img.height > MAX_PIXELS) return null;
  if (!crop.every(Number.isFinite)) return null;
  const cut = deleteCropped && realCrop(crop);
  let newCrop = crop, fx = Math.max(1 - crop[0] - crop[2], 0.01), fy = Math.max(1 - crop[1] - crop[3], 0.01);
  if (cut) {
    const x = Math.floor(crop[0] * img.width), y = Math.floor(crop[1] * img.height);
    const w = Math.min(Math.max(Math.round(fx * img.width), 1), img.width - Math.min(x, img.width - 1));
    const h = Math.min(Math.max(Math.round(fy * img.height), 1), img.height - Math.min(y, img.height - 1));
    img = cropImage(img, Math.min(x, img.width - 1), Math.min(y, img.height - 1), w, h);
    newCrop = [0, 0, 0, 0];
    fx = 1; fy = 1;
  }
  // Pixels needed for the whole (possibly still cropped) image at `ppi`.
  const needW = Math.max(Math.ceil((Math.abs(wPt) / 72) * ppi / fx), 1), needH = Math.max(Math.ceil((Math.abs(hPt) / 72) * ppi / fy), 1);
  const k = Math.max(needW / img.width, needH / img.height);
  const resized = k < 1;
  if (resized) img = resizeImage(img, Math.max(Math.round(img.width * k), 1), Math.max(Math.round(img.height * k), 1));
  if (!resized && !cut) return null;
  let out, type = 'image/png';
  if (jpeg && !hasAlpha(img) && typeof host?.encodeImage === 'function') {
    out = await host.encodeImage(img, 'image/jpeg', 0.85);
    type = 'image/jpeg';
  }
  if (!out) { out = await encodePng(img); type = 'image/png'; }
  // Never make a picture bigger just to resample it; deleting a crop is worth it regardless.
  if (out.length >= bytes.length && !cut) return null;
  return {bytes: out, type, crop: newCrop};
}

/** Every string in `v`, to know which media are still referenced. */
function strings(v, used, depth = 0) {
  if (depth > 200 || v === null || v === undefined) return;
  if (typeof v === 'string') used.add(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, used, depth + 1);
  else if (typeof v === 'object') for (const x of Object.values(v)) strings(x, used, depth + 1);
}

async function compress(ctx, p) {
  const cmd = 'picture.compress';
  const ppi = p.ppi ?? 220;
  if (typeof ppi !== 'number' || !Number.isFinite(ppi) || ppi < 36 || ppi > 1200) throw bad(cmd, '`ppi` must be between 36 and 1200 (PowerPoint offers 330, 220, 150 and 96)');
  const deleteCropped = p.deleteCropped !== false, all = p.all === true;
  const sel = all ? null : new Set(targets(ctx, p, cmd).map(String));
  if (!all && !sel.size) throw bad(cmd, 'select a picture, or pass all: true');
  const slides = all ? ctx.doc.slides.map(x => x.id) : [currentSlide(ctx, cmd).id];
  const media = new Map((ctx.doc.media ?? []).map(m => [m.id, m]));
  const cache = new Map(), jobs = [];
  let before = 0, after = 0;
  // Pass 1: pack each distinct (picture, size, crop) once.
  const visit = async (list, slideId) => {
    for (const sh of list) {
      if (sh.kind?.type === 'group') await visit(sh.kind.children ?? [], slideId);
      if (sh.kind?.type !== 'picture' || (sel && !sel.has(String(sh.id)))) continue;
      const f = sh.kind.fill, m = media.get(f.media);
      const w = sh.xfrm?.w ?? 0, h = sh.xfrm?.h ?? 0, crop = f.crop ?? [0, 0, 0, 0];
      const key = `${f.media}|${crop.join(',')}|${w}|${h}`;
      if (!cache.has(key)) {
        const bytes = m?.data ? base64Decode(m.data) : null;
        const packed = bytes ? await pack(ctx.host, bytes, m.contentType ?? contentType(m.name ?? '', bytes), crop, w, h, ppi, deleteCropped) : null;
        if (packed) { before += bytes.length; after += packed.bytes.length; }
        cache.set(key, packed ? {...packed, name: String(m.name ?? 'picture').replace(/\.[^.]+$/, '') + (packed.type === 'image/jpeg' ? '.jpg' : '.png')} : null);
      }
      if (cache.get(key)) jobs.push({slideId, id: sh.id, key, old: f.media});
    }
  };
  for (const id of slides) await visit(slideById(ctx.doc, id)?.shapes ?? [], id);
  // Pass 2: write the new media and rewrite the pictures.
  const added = new Map();
  for (const [key, v] of cache) if (v) added.set(key, addMedia(ctx, cmd, v.name, v.type, v.bytes));
  const bySlide = new Map(), rewritten = new Map();
  for (const j of jobs) (bySlide.get(j.slideId) ?? bySlide.set(j.slideId, []).get(j.slideId)).push(j);
  for (const [slideId, list] of bySlide) {
    const shapes = structuredClone(slideById(ctx.doc, slideId).shapes);
    for (const j of list) {
      const sh = findShape(shapes, j.id), v = cache.get(j.key);
      sh.kind.fill.media = added.get(j.key);
      sh.kind.fill.crop = v.crop;
    }
    writeShapes(ctx, slideId, shapes);
    rewritten.set(slideId, shapes);
  }
  // Drop the originals nothing uses any more, so the saved file actually shrinks.
  const changed = new Set(jobs.map(j => j.old));
  if (changed.size) {
    const used = new Set();
    for (const [k, v] of Object.entries(ctx.doc)) {
      if (k === 'media') continue;
      if (k === 'slides') for (const sl of v ?? []) strings(rewritten.has(sl.id) ? {...sl, shapes: rewritten.get(sl.id)} : sl, used);
      else strings(v, used);
    }
    const keep = (ctx.doc.media ?? []).filter(m => !changed.has(m.id) || used.has(m.id));
    if (keep.length !== (ctx.doc.media ?? []).length) ctx.change.set(['media'], keep);
  }
  return {pictures: jobs.length, before, after, ppi};
}

export default defineCommands({
  family: 'picture_compress',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [{
    id: 'picture.compress', label: 'Compress Pictures', risk: 'edit', state: always, dialog: 'dialog.compressPictures',
    description: '{ppi?: 330|220|150|96 (default 220), deleteCropped?: bool (default true), all?: bool (every picture in the presentation; default the selected pictures), ids?} → {pictures, before, after}',
    params: s.object({ppi: s.optional(s.number()), deleteCropped: s.optional(s.boolean()), all: s.optional(s.boolean()), ids: s.optional(s.array(ID, {max: 5000})), id: s.optional(ID)}),
    run: compress,
  }],
});
