// The Photo Album dialog model (new and edit): the list of pictures and text boxes, and the album options.
// Translated from deckcraft crates/ui-egui/src/dialogs/photo_album.rs and crates/engine/src/cmd/insert/album.rs
// (`album_seed`, `infer_album`, `items_from_slides`) at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {defineDialog} from '../../kernel/dialog.mjs';
import {isSchema2, currentSlideId} from '../model/doc.mjs';
import {MAX_ITEMS, LAYOUT_KEYS, FRAMES, markOf, albumOf} from './album.mjs';
import {bodyText} from '../model/text.mjs';

const pics = slide => (slide.shapes ?? []).filter(sh => sh.kind?.type === 'picture');

/** The album under the selection as dialog values: items (picture bytes as base64) and the options it was made with. */
export function seed(ctx) {
  const out = {items: [], selected: 0, layout: '1', frame: 'none', captions: false, grayscale: false, theme: '', album: null};
  if (!isSchema2(ctx?.doc)) return out;
  const index = ctx.doc.slides.findIndex(x => x.id === currentSlideId(ctx.doc, ctx.selection));
  const found = albumOf(ctx.doc.slides, index);
  if (!found) return out;
  const slides = found.slides.map(x => ctx.doc.slides[x.index]);
  for (const sl of slides) {
    const list = pics(sl);
    if (!list.length) {
      const text = (sl.shapes ?? []).filter(sh => sh.textBox && sh.text).map(sh => bodyText(sh.text)).find(t => t.trim());
      if (text) out.items.push({kind: 'text', text: text.trim()});
      continue;
    }
    for (const sh of list) {
      const media = (ctx.doc.media ?? []).find(m => m.id === sh.kind.fill?.media);
      const adj = sh.kind.fill?.adjust ?? {};
      out.items.push({kind: 'picture', name: sh.descr || media?.name || 'picture', data: media?.data ?? '', rot: sh.xfrm?.rot ?? 0,
        brightness: adj.brightness ?? 0, contrast: adj.contrast ?? 0});
    }
  }
  const mark = markOf(slides[0]);
  const most = Math.max(1, ...slides.map(sl => pics(sl).length));
  out.layout = mark?.layout && LAYOUT_KEYS.includes(mark.layout) ? mark.layout : most >= 3 ? '4' : most === 2 ? '2' : '1';
  out.frame = mark && FRAMES.includes(mark.frame) ? mark.frame : 'none';
  out.captions = !!mark?.captions;
  out.grayscale = !!mark?.gray;
  out.theme = mark?.theme ?? '';
  out.album = found.id || null;
  return out;
}

export function albumDialog(edit) {
  return defineDialog({
    id: edit ? 'dialog.photoAlbumEdit' : 'dialog.photoAlbum',
    title: edit ? 'Edit Photo Album' : 'Photo Album',
    command: edit ? 'insert.photoAlbumEdit' : 'insert.photoAlbum',
    init: ctx => (edit ? seed(ctx) : {items: [], selected: 0, layout: '1', frame: 'none', captions: false, grayscale: false, theme: '', album: null}),
    validate(v) {
      const items = Array.isArray(v.items) ? v.items : [];
      if (!items.length) return [{field: 'items', message: 'Add at least one picture or text box.'}];
      if (items.length > MAX_ITEMS) return [{field: 'items', message: `An album holds at most ${MAX_ITEMS} pictures or text boxes.`}];
      if (items.some(i => i.kind === 'text' && !String(i.text ?? '').trim())) return [{field: 'items', message: 'A text box needs some text.'}];
      return [];
    },
    toCommand(v) {
      const pictures = v.items.map(i => (i.kind === 'text' ? {text: String(i.text).trim()}
        : {name: i.name, data: i.data, rot: i.rot ?? 0, brightness: i.brightness ?? 0, contrast: i.contrast ?? 0}));
      const params = {pictures, layout: v.layout, frame: v.frame, captions: !!v.captions, grayscale: !!v.grayscale};
      if (v.theme) params.theme = v.theme;
      if (edit && v.album) params.album = v.album;
      return {command: edit ? 'insert.photoAlbumEdit' : 'insert.photoAlbum', params};
    },
  });
}
