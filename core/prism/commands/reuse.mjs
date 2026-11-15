// Home > New Slide > Reuse Slides: insert slides from another presentation.
// Translated from deckcraft crates/engine/src/cmd/reuse.rs (`reuse_list`, `reuse`, `import_master`, `copy_media`,
// `matching_layout`, `relink_shapes`) at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The slides take the destination's look by default (each moves to the destination layout with the same name, else the
// same kind); with `keepFormatting` the source master and its layouts come along. Pictures, media and sounds are copied
// under fresh ids, shape ids are renumbered with animations and connector ends following them, and links to another reused
// slide follow its copy. The file is read by core/prism/formats/pptx-read.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {UPSTREAM_COMMIT, bad, hasDoc, mediaBytes} from '../lib/shape-common.mjs';
import {reid, remapAnimations, mediaRefs, remapMedia, bringMedia, takeId} from '../lib/edit-shapes.mjs';
import {importPptx} from '../formats/pptx-read.mjs';
import {currentSlideId} from '../model/doc.mjs';
import {slideTitle} from '../model/presentation.mjs';
import {selectSlideList} from '../lib/text-session.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/reuse.rs']};

async function open(ctx, p, cmd) {
  const {name, bytes} = await mediaBytes(ctx, p, cmd);
  try { return {name, src: await importPptx(bytes)}; } catch (e) {
    throw new CommandError('failed', `${cmd}: ${name} is not a presentation Prism can open (${e?.message ?? e})`);
  }
}

async function list(ctx, p) {
  const {name, src} = await open(ctx, p, 'slide.reuseList');
  return {name, slides: src.slides.map((sl, index) => ({index, title: slideTitle(sl), hidden: !!sl.hidden}))};
}

/** The destination layout a reused slide moves to: same name, else same kind, else the first. */
function matchingLayout(pres, name, kind) {
  const all = (pres.masters ?? []).flatMap(m => m.layouts ?? []);
  return (all.find(l => name && String(l.name ?? '').toLowerCase() === name.toLowerCase()) ?? all.find(l => l.kind === kind) ?? all[0])?.id;
}

/** Point links to a reused slide (and Return to Zoom targets) at its copy; links to a slide left behind stay. */
function relink(value, map, depth = 0) {
  if (depth > 256 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(x => relink(x, map, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'action' && v?.kind === 'slide' && map.has(v.slide)) out[k] = {...v, slide: map.get(v.slide)};
    else if (k === 'zoomReturn' && map.has(v)) out[k] = map.get(v);
    else out[k] = relink(v, map, depth + 1);
  }
  return out;
}

const mediaOf = (src, value) => {
  const ids = mediaRefs(value);
  return (src.media ?? []).filter(m => ids.has(String(m.id)));
};

/** A source master with its layouts and media copied into the holder under fresh ids; returns {master, layouts: old id -> new id}. */
function importMaster(cmd, holder, src, master) {
  const map = bringMedia(cmd, holder, mediaOf(src, master));
  const m = remapMedia(structuredClone(master), map);
  m.id = takeId(holder, cmd);
  m.shapes = reid(cmd, holder, m.shapes ?? []).shapes;
  const layouts = new Map();
  m.layouts = (m.layouts ?? []).map(l => {
    const id = takeId(holder, cmd);
    layouts.set(l.id, id);
    return {...remapMedia(l, map), id, shapes: reid(cmd, holder, remapMedia(l.shapes ?? [], map)).shapes};
  });
  return {master: m, layouts};
}

async function reuse(ctx, p) {
  const cmd = 'slide.reuse';
  const {name, src} = await open(ctx, p, cmd);
  const n = src.slides.length;
  let picked = [];
  if (Array.isArray(p.slides)) {
    for (const x of p.slides) {
      if (!Number.isInteger(x) || x < 0 || x >= n) throw bad(cmd, `${name} has ${n} slides; ${JSON.stringify(x)} isn't one of them (indices count from 0)`);
      if (!picked.includes(x)) picked.push(x);
    }
  } else picked = Array.from({length: n}, (_, i) => i);
  if (!picked.length) throw bad(cmd, `${name} has no slides to reuse`);
  const keep = !!p.keepFormatting;
  const cur = ctx.doc.slides.findIndex(x => x.id === currentSlideId(ctx.doc, ctx.selection));
  const at = Math.min(Number.isInteger(p.at) ? p.at : cur + 1, ctx.doc.slides.length);
  const holder = {pres: ctx.doc};
  const layoutMap = new Map();
  const newMasters = [];
  if (keep) {
    const done = new Set();
    for (const i of picked) {
      const master = src.masters.find(m => (m.layouts ?? []).some(l => l.id === src.slides[i].layout));
      if (!master || done.has(master.id)) continue;
      done.add(master.id);
      const got = importMaster(cmd, holder, src, master);
      for (const [k, v] of got.layouts) layoutMap.set(k, v);
      newMasters.push(got.master);
    }
    holder.pres = {...holder.pres, masters: [...(holder.pres.masters ?? []), ...newMasters]};
  }
  const slideMap = new Map();
  const copies = picked.map(i => {
    const from = src.slides[i];
    const media = bringMedia(cmd, holder, mediaOf(src, from));
    const id = takeId(holder, cmd);
    const {shapes, map} = reid(cmd, holder, from.shapes ?? []);
    let sl = remapMedia({...structuredClone(from), id, shapes, animations: remapAnimations(from.animations, map)}, media);
    const srcLayout = src.masters.flatMap(m => m.layouts ?? []).find(l => l.id === from.layout);
    sl.layout = layoutMap.get(from.layout) ?? matchingLayout(holder.pres, srcLayout?.name ?? '', srcLayout?.kind);
    slideMap.set(from.id, id);
    return sl;
  }).map(sl => relink(sl, slideMap));
  ctx.change.set(['nextId'], holder.pres.nextId);
  if ((holder.pres.media ?? []) !== (ctx.doc.media ?? [])) ctx.change.set(['media'], holder.pres.media);
  if (newMasters.length) ctx.change.set(['masters'], holder.pres.masters);
  copies.forEach((sl, k) => ctx.change.splice(['slides'], Math.min(at + k, ctx.doc.slides.length), 0, sl));
  const ids = copies.map(x => x.id);
  selectSlideList(ctx, ids, ids[ids.length - 1]);
  return {slides: ids.length, ids, from: name, keepFormatting: keep};
}

export default defineCommands({
  family: 'reuse',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'slide.reuseList', label: 'List Slides to Reuse', risk: 'read', state: hasDoc,
      description: '{path | data: base64, name?} → {name, slides: [{index, title, hidden}]}: the slides of another presentation, for choosing which ones `slide.reuse` brings in',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string()), name: s.optional(s.string({max: 255}))}),
      run: list},
    {id: 'slide.reuse', label: 'Reuse Slides…', risk: 'edit', state: hasDoc, dialog: 'dialog.reuseSlides',
      description: '{path? | data: base64, name?, slides?: [index] (0-based, default all), keepFormatting?: bool (default false: use the destination theme), at?: index (default after the current slide)}',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string()), name: s.optional(s.string({max: 255})),
        slides: s.optional(s.array(s.any(), {max: 10000})), keepFormatting: s.optional(s.boolean()), at: s.optional(s.integer({min: 0}))}),
      run: reuse},
  ],
});

