// Schema-1 Prism content (legacy editor): New Slide, Duplicate Slide, Delete Slide, Move Slide.
// core/prism/commands/slide.mjs runs these when the document is not a schema-2 presentation
// (design note F-prism--slide--schema2: schema 1 stays as is until the legacy editor retires).
// Translated from deckcraft crates/engine/src/cmd/slide.rs (`slide.new` → `new`,
// `slide.duplicate` → `duplicate`, `slide.delete` → `delete`, `slide.move` → `move_slide`,
// `has_doc`/`has_slide` from cmd.rs) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Schema 1 keeps slides in `content.slides` with string ids and the current slide in
// `activeSlideId`; the selection may hold slide addresses `/sl:<slideId>`. Sections arrive with
// the Prism foundation.

import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {findLayout, layoutOf, newSlide, LAYOUTS} from './slide-layouts.mjs';

export const UPSTREAM = {repo: 'deckcraft', commit: 'f893f6af7d36a5409fd804e81a34fd895cfefedf', files: ['crates/engine/src/cmd/slide.rs', 'crates/engine/src/cmd.rs']};
/** The schema-1 validator's limit (core/model.mjs). */
export const MAX_SLIDES = 500;

const bad = (message, path) => new CommandError('invalid_params', message, path ? {path} : undefined);
const slides = ctx => ctx.doc?.slides;
const hasDoc = ctx => (Array.isArray(slides(ctx)) ? {enabled: true} : {enabled: false, reason: 'no presentation open'});
const hasSlide = ctx => (!Array.isArray(slides(ctx)) ? {enabled: false, reason: 'no presentation open'}
  : slides(ctx).length ? {enabled: true} : {enabled: false, reason: 'no slides'});

/** The current slide's index (deckcraft `selection.slide`). */
function current(ctx) {
  const list = slides(ctx);
  const i = list.findIndex(sl => sl.id === ctx.doc.activeSlideId);
  return i < 0 ? 0 : i;
}

/** Selected slide ids from `/sl:<id>` selection addresses (deckcraft `selection.slides`), in document order. */
function selectedIds(ctx) {
  const ids = new Set();
  for (const r of ctx.selection?.ranges ?? []) {
    for (const a of [r.anchor, r.focus]) {
      const m = /^\/sl:([^/]+)$/.exec(String(a ?? ''));
      if (m) ids.add(decodeURIComponent(m[1]));
    }
  }
  return slides(ctx).filter(sl => ids.has(sl.id)).map(sl => sl.id);
}

const select = (ctx, id) => {
  ctx.change.set(['activeSlideId'], id);
  ctx.setSelection(id ? {ranges: [{anchor: `/sl:${id}`, focus: `/sl:${id}`}], primary: 0} : {ranges: [], primary: 0});
};

function indexParam(ctx, p, name) {
  if (p.index === undefined) return undefined;
  if (p.index >= slides(ctx).length) throw bad(`no slide ${p.index}`, '/index');
  return p.index;
}

const index = s.optional(s.integer({min: 0, max: MAX_SLIDES, description: '0-based slide index (default: the selected slides, else the current one)'}));

/** The schema-1 commands by id (params schemas and run functions). */
export const LEGACY = Object.fromEntries([
    {
      id: 'slide.new', label: 'New Slide', risk: 'edit', shortcut: ['Mod+Shift+N', 'Ctrl+M'],
      description: 'New Slide (Home › Slides): insert a slide after the current one, on a layout, optionally with title and body text.',
      params: s.object({
        layout: s.optional(s.string({min: 1, max: 100, description: `Layout kind or name: ${Object.keys(LAYOUTS).join(', ')}`})),
        at: s.optional(s.integer({min: 0, max: MAX_SLIDES, description: '0-based index to insert at (default: after the current slide)'})),
        title: s.optional(s.string({max: 10000})),
        body: s.optional(s.string({max: 100000})),
      }),
      state: hasDoc,
      run(ctx, p) {
        const list = slides(ctx);
        if (list.length >= MAX_SLIDES) throw bad(`A presentation holds at most ${MAX_SLIDES} slides`);
        const cur = current(ctx);
        let layout;
        if (p.layout !== undefined) {
          layout = findLayout(p.layout);
          if (!layout) throw bad(`no layout ${JSON.stringify(p.layout)}`, '/layout');
        } else {
          // PowerPoint picks Title and Content after a title slide, else the current layout.
          const curLayout = list.length ? layoutOf(list[cur], cur) : null;
          layout = curLayout && curLayout !== 'title' ? curLayout : 'titleAndContent';
        }
        const slide = newSlide(layout, {uid: () => ctx.host.uid(), background: list[cur]?.background ?? '#ffffff', title: p.title, body: p.body});
        const at = Math.min(p.at ?? (list.length ? cur + 1 : 0), list.length);
        ctx.change.splice(['slides'], at, 0, slide);
        select(ctx, slide.id);
        return {index: at, id: slide.id, layout};
      },
    },
    {
      id: 'slide.duplicate', label: 'Duplicate Slide', risk: 'edit',
      description: 'Duplicate Slide: copy the selected slides (or the slide at index) and insert the copies after the last one.',
      params: s.object({index}),
      state: hasSlide,
      run(ctx, p) {
        const list = slides(ctx);
        const at = indexParam(ctx, p);
        let indices;
        if (at !== undefined) indices = [at];
        else {
          const ids = selectedIds(ctx);
          indices = ids.length ? ids.map(id => list.findIndex(sl => sl.id === id)) : [current(ctx)];
        }
        indices.sort((a, b) => a - b);
        if (list.length + indices.length > MAX_SLIDES) throw bad(`A presentation holds at most ${MAX_SLIDES} slides`);
        const last = indices[indices.length - 1];
        const copies = indices.map(i => {
          const src = structuredClone(list[i]);
          return {...src, id: ctx.host.uid(), elements: src.elements.map(e => ({...e, id: ctx.host.uid()}))};
        });
        ctx.change.splice(['slides'], last + 1, 0, ...copies);
        const ids = copies.map(c => c.id);
        ctx.change.set(['activeSlideId'], ids[ids.length - 1]);
        ctx.setSelection({ranges: ids.map(id => ({anchor: `/sl:${id}`, focus: `/sl:${id}`})), primary: ids.length - 1});
        return {ids};
      },
    },
    {
      id: 'slide.delete', label: 'Delete Slide', risk: 'edit',
      description: 'Delete Slide: remove slides by id, by index, or the selected (else current) slide. Undo brings them back.',
      params: s.object({index, ids: s.optional(s.array(s.string({min: 1, max: 200}), {min: 1, max: MAX_SLIDES}))}),
      state: hasSlide,
      run(ctx, p) {
        const list = slides(ctx);
        let ids;
        if (p.ids) ids = p.ids.filter(id => list.some(sl => sl.id === id));
        else if (p.index !== undefined) ids = list[p.index] ? [list[p.index].id] : [];
        else {
          const sel = selectedIds(ctx);
          ids = sel.length ? sel : list.length ? [list[current(ctx)].id] : [];
        }
        if (!ids.length) throw bad('no such slide');
        const gone = new Set(ids);
        const first = Math.min(...ids.map(id => list.findIndex(sl => sl.id === id)));
        for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i].id)) ctx.change.splice(['slides'], i, 1);
        const rest = slides(ctx);
        select(ctx, rest[Math.min(first, rest.length - 1)]?.id ?? '');
        return {deleted: ids.length, remaining: rest.length};
      },
    },
    {
      id: 'slide.move', label: 'Move Slide', risk: 'edit',
      description: 'Move Slide: move the slide at `from` (default: the current one) to index `to`.',
      params: s.object({from: s.optional(s.integer({min: 0, max: MAX_SLIDES})), to: s.integer({min: 0, max: MAX_SLIDES})}),
      state: hasSlide,
      run(ctx, p) {
        const list = slides(ctx);
        const from = p.from ?? current(ctx);
        if (from >= list.length) throw bad(`no slide ${from}`, '/from');
        const slide = list[from];
        ctx.change.splice(['slides'], from, 1);
        const to = Math.min(p.to, list.length - 1);
        ctx.change.splice(['slides'], to, 0, slide);
        select(ctx, slide.id);
        return {index: to};
      },
    },
  ].map(c => [c.id, c]));
