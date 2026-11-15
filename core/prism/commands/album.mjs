// Insert > Photo Album: New Photo Album and Edit Photo Album.
// Translated from deckcraft crates/engine/src/cmd/insert/album.rs (`photo_album`, `photo_album_edit`, `commit_album`,
// `insert_album`, `album_seed`) at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// PowerPoint starts a new presentation for an album; these slides go into the open one after the current slide, so the
// album is one undo step. Each album slide is a Blank slide named "Photo Album" with the marker tag of core/prism/lib/album.mjs,
// by which Edit Photo Album finds the slides again (deleting them and building the album at the same place).
// The dialog (dialogs/photoAlbum.mjs) opens when `pictures` is not given; a command call must give them.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, hasDoc, mediaBytes, contentType, imageDimensions, newId} from '../lib/shape-common.mjs';
import {isSchema2, currentSlideId} from '../model/doc.mjs';
import {slidePath} from '../model/doc.mjs';
import {
  MAX_ITEMS, MAX_BYTES, MAX_TOTAL, MAX_TEXT, TAG, LAYOUTS, FRAME_LINE, layoutOf, frameOf, plan, place, fileStem, marker, albumOf,
} from '../lib/album.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/insert/album.rs']};
const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);

const slideIndex = ctx => {
  const id = currentSlideId(ctx.doc, ctx.selection);
  return id ? ctx.doc.slides.findIndex(x => x.id === id) : -1;
};

const finite = (v, key, cmd) => {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(cmd, `\`${key}\` must be a number`);
  return v;
};
const unit = (v, key, cmd) => {
  const n = finite(v, key, cmd);
  if (n < -1 || n > 1) throw bad(cmd, `\`${key}\` must be between -1 and 1`);
  return n;
};

async function items(ctx, p, cmd) {
  const arr = p.pictures;
  if (!Array.isArray(arr)) throw bad(cmd, '`pictures` must be a list');
  if (!arr.length) throw bad(cmd, 'add at least one picture or text box');
  if (arr.length > MAX_ITEMS) throw bad(cmd, `a photo album holds at most ${MAX_ITEMS} pictures or text boxes`);
  const out = [];
  let total = 0;
  for (const it of arr) {
    if (!it || typeof it !== 'object') throw bad(cmd, 'each album item must be a picture or a text box');
    if (it.data === undefined && it.path === undefined) {
      const text = typeof it.text === 'string' ? it.text.trim() : null;
      if (text === null) throw bad(cmd, 'each album item needs `path`, `data` or `text`');
      if (!text) throw bad(cmd, 'a text box needs some text');
      if ([...text].length > MAX_TEXT) throw bad(cmd, `text is longer than ${MAX_TEXT} characters`);
      out.push({kind: 'text', text});
      continue;
    }
    const {name, bytes} = await mediaBytes(ctx, it, cmd);
    if (bytes.length > MAX_BYTES) throw bad(cmd, `${name} is larger than 32 MB`);
    total += bytes.length;
    if (total > MAX_TOTAL) throw bad(cmd, 'the album is larger than 64 MB');
    const ct = contentType(name, bytes);
    if (!ct.startsWith('image/')) throw bad(cmd, `${name} is not a picture`);
    const dim = imageDimensions(bytes);
    if (ct !== 'image/svg+xml' && ct !== 'image/tiff' && !dim) throw bad(cmd, `${name}: the picture can't be read`);
    const rot = ((finite(it.rot, 'rot', cmd) % 360) + 360) % 360;
    out.push({kind: 'picture', name, data: typeof it.data === 'string' ? it.data : null, path: it.path, pxW: dim?.w ?? 4, pxH: dim?.h ?? 3, rot,
      brightness: unit(it.brightness, 'brightness', cmd), contrast: unit(it.contrast, 'contrast', cmd)});
  }
  return out;
}

function options(p, cmd) {
  let layoutKey = '1', layout = LAYOUTS[1];
  if (p.layout !== undefined && p.layout !== null) {
    if (typeof p.layout !== 'string') throw bad(cmd, '`layout` must be text');
    const l = layoutOf(p.layout);
    if (!l) throw bad(cmd, `unknown layout \`${p.layout}\` (use fit, 1, 2, 4, 1title, 2title or 4title)`);
    ({key: layoutKey, layout} = l);
  }
  let frame = 'none';
  if (p.frame !== undefined && p.frame !== null) {
    if (typeof p.frame !== 'string') throw bad(cmd, '`frame` must be text');
    frame = frameOf(p.frame);
    if (!frame) throw bad(cmd, `unknown frame \`${p.frame}\` (use none, rect, rounded or simple)`);
  }
  for (const k of ['captions', 'grayscale']) if (p[k] !== undefined && p[k] !== null && typeof p[k] !== 'boolean') throw bad(cmd, `\`${k}\` must be true or false`);
  return {layoutKey, layout, frame, captions: !!p.captions, grayscale: !!p.grayscale, theme: typeof p.theme === 'string' ? p.theme.trim() : ''};
}

async function build(ctx, list, o, at, albumId, cmd) {
  const size = ctx.doc.slideSize ?? {width: 960, height: 540};
  const first = at ?? (ctx.doc.slides.length ? slideIndex(ctx) + 1 : 0);
  let pin = at, slides = 0, pictures = 0;
  for (const sl of plan(list, o.layout.per)) {
    const made = await ctx.run('slide.new', pin !== null && pin !== undefined ? {layout: 'blank', at: pin} : {layout: 'blank'});
    pin = null;
    const path = slidePath(ctx.doc, made.id);
    ctx.change.set([...path, 'name'], 'Photo Album');
    ctx.change.set([...path, 'tags'], [[TAG, marker(albumId, o)]]);
    slides += 1;
    if (sl.text !== undefined) {
      const rect = o.layout.title ? [36, 18, Math.max(36, size.width - 72), 48] : [36, 36, Math.max(36, size.width - 72), Math.max(36, size.height - 72)];
      await ctx.run('insert.textBox', {rect, text: sl.text});
      continue;
    }
    const {title, placed} = place(size.width, size.height, o.layout, sl.pictures, o.captions);
    for (let i = 0; i < sl.pictures.length; i++) {
      const pic = sl.pictures[i], cell = placed[i];
      if (!cell) continue;
      const ins = await ctx.run('insert.picture', {name: pic.name, ...(pic.data !== null ? {data: pic.data} : {path: pic.path}), rect: cell.pic});
      const id = ins?.id;
      if (id === undefined) throw bad(cmd, 'the picture was not inserted');
      if (o.frame !== 'none') await ctx.run('shape.line', {ids: [id], ...FRAME_LINE[o.frame]});
      if (o.grayscale || Math.abs(pic.brightness) > 1e-6 || Math.abs(pic.contrast) > 1e-6) {
        await ctx.run('picture.adjust', {ids: [id], grayscale: o.grayscale, brightness: pic.brightness, contrast: pic.contrast});
      }
      if (pic.rot > 0.01) await ctx.run('shape.rotate', {ids: [id], deg: pic.rot});
      pictures += 1;
      if (cell.caption) await ctx.run('insert.textBox', {rect: cell.caption, text: fileStem(pic.name)});
    }
    if (title) await ctx.run('insert.textBox', {rect: title, text: fileStem(sl.pictures[0]?.name)});
  }
  await ctx.run('slide.go', {index: first});
  return {slides, first, pictures, album: albumId};
}

async function album(ctx, p, edit) {
  const cmd = edit ? 'insert.photoAlbumEdit' : 'insert.photoAlbum';
  if (!Array.isArray(p.pictures)) throw bad(cmd, 'give `pictures`: the Photo Album dialog collects them');
  const o = options(p, cmd);
  const list = await items(ctx, p, cmd);
  if (!o.theme) o.theme = ctx.doc.masters?.[0]?.theme?.name ?? '';
  let at = null, id = 0;
  if (edit) {
    const found = albumOf(ctx.doc.slides, slideIndex(ctx), Number(p.album) || 0);
    if (!found) throw bad(cmd, p.album ? 'that photo album is no longer in this presentation' : 'this slide is not part of a photo album');
    id = found.id;
    at = Math.min(...found.slides.map(x => x.index));
    await ctx.run('slide.delete', {ids: found.slides.map(x => x.id)});
  }
  if (!id) id = newId(ctx, cmd);
  const cur = ctx.doc.masters?.[0]?.theme?.name ?? '';
  if (o.theme && o.theme.toLowerCase() !== cur.toLowerCase()) await ctx.run('design.theme', {name: o.theme});
  return build(ctx, list, o, at, id, cmd);
}

export default defineCommands({
  family: 'album',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.photoAlbum', label: 'New Photo Album…', risk: 'edit', state: hasDoc, dialog: 'dialog.photoAlbum',
      description: '{pictures: [{path?|data: base64, name?, rot?: deg, brightness?: -1..1, contrast?: -1..1} | {text}], layout?: fit|1|2|4|1title|2title|4title, frame?: none|rect|rounded|simple, captions?: bool, grayscale?: bool, theme?: name} — the album goes in after the current slide',
      params: s.object({pictures: s.optional(s.array(s.any(), {max: 100})), layout: s.optional(s.any()), frame: s.optional(s.any()), captions: s.optional(s.any()),
        grayscale: s.optional(s.any()), theme: s.optional(s.any())}),
      run: (ctx, p) => album(ctx, p, false)},
    {id: 'insert.photoAlbumEdit', label: 'Edit Photo Album…', risk: 'edit', dialog: 'dialog.photoAlbumEdit',
      state(ctx) {
        if (!isSchema2(ctx.doc)) return {enabled: false, reason: 'no presentation'};
        return albumOf(ctx.doc.slides, slideIndex(ctx)) ? {enabled: true} : {enabled: false, reason: 'select a slide of a photo album'};
      },
      description: '{album?: id, pictures: same as insert.photoAlbum, layout?, frame?, captions?, grayscale?, theme?} — rebuilds the album under the selection (or `album`) in place',
      params: s.object({album: s.optional(ID), pictures: s.optional(s.array(s.any(), {max: 100})), layout: s.optional(s.any()), frame: s.optional(s.any()),
        captions: s.optional(s.any()), grayscale: s.optional(s.any()), theme: s.optional(s.any())}),
      run: (ctx, p) => album(ctx, p, true)},
  ],
});

