// Slides: new (with a layout), duplicate, delete, move, go to / next / previous / first / last,
// select slides and slide ranges, hide, layout, reset, notes, rename, sections, slides from outline.
// Translated from deckcraft crates/engine/src/cmd/slide.rs (`specs`, `find_layout`,
// `current_master`, `new`, `body_placeholder`, `index_of`, `duplicate`, `delete`, `move_slide`,
// `go_to`, `go`, `next`, `prev`, `first`, `last`, `select_slides`, `select_range`, `hide`,
// `apply_layout`, `set_layout`, `reset`, `notes`, `rename`, `section_add`, `section_rename`,
// `section_remove`, `section_remove_all`, `section_move`, `from_outline`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Schema 2 (a deckcraft Presentation) is translated here. Schema-1 content (the legacy editor)
// keeps its own implementation of slide.new/duplicate/delete/move (lib/slide-schema1.mjs).
// deckcraft's `Selection` (current slide index, selected slide ids, Shift-click range anchor) is
// the kernel selection (one `/sl:<id>` range per selected slide, the current one primary) plus
// the view key `slideRangeAnchor` ([anchor id, end id]).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {newSlide, layoutOfKind} from '../model/defaults.mjs';
import {bodyFromText, promoteLeadingTabs, bodyEmpty} from '../model/text.mjs';
import {replaceText} from '../model/edit.mjs';
import {shape as newShape, isTitlePh, isFooterPh, layoutById, presetGeom} from '../model/presentation.mjs';
import {LEGACY, UPSTREAM as LEGACY_UPSTREAM} from '../lib/slide-schema1.mjs';
import {bad, hasDoc, hasSlide, optIndex, usizeParam, selectionOf, selectSlideList, NO_ID_SPACE, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {reid, remapAnimations} from '../lib/edit-shapes.mjs';
import {parseOutline, parseMarkdown, outlineSlides} from '../lib/slide-outline.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/slide.rs', 'crates/format/src/lib.rs', ...LEGACY_UPSTREAM.files]};
const MAX = 5000;

const index = s.optional(s.integer({min: 0, max: MAX, description: '0-based slide index (default: the selected slides, else the current slide)'}));
const slideId = s.union([s.string({min: 1, max: 64}), s.integer({min: 0, max: 4294967295})]);
const LAYOUT_KINDS = 'title, titleAndContent, sectionHeader, twoContent, comparison, titleOnly, blank, contentWithCaption, pictureWithCaption';
const layoutKey = s.union([s.string({min: 1, max: 200}), s.integer({min: 0})], {description: `Layout id, name or kind (${LAYOUT_KINDS})`});

// ---------------------------------------------------------------------------------------------
// Helpers

const slidesOf = c => c.slides ?? [];
const sid = v => (v === undefined || v === null ? null : String(v));
const indexOfId = (c, id) => slidesOf(c).findIndex(x => x.id === id);
const sectionOfId = (c, id) => (c.sections ?? []).findIndex(sec => sec.slides.includes(id));
const setSections = (ctx, secs) => ctx.change.set(['sections'], secs);
const cloneSections = c => (c.sections ?? []).map(sec => ({...sec, slides: [...sec.slides]}));
const orderOf = c => new Map(slidesOf(c).map((x, i) => [x.id, i]));
const sortByDoc = (ids, order) => [...ids].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));

/** deckcraft `find_layout`: a layout by id, by name (letters and digits, any case) or kind keyword, in master `mi`. */
export function findLayout(c, key, mi) {
  if (typeof key === 'number' || (typeof key === 'string' && /^\d+$/.test(key))) {
    const id = String(key);
    if (layoutById(c, id)) return id;
    if (typeof key === 'number') return null;
  }
  if (typeof key !== 'string') return null;
  const m = c.masters?.[mi] ?? c.masters?.[0];
  if (!m) return null;
  const norm = x => [...String(x)].filter(ch => /[\p{L}\p{N}]/u.test(ch)).join('').toLowerCase();
  const k = norm(key);
  const kind = {title: 'title', titleslide: 'title', titleandcontent: 'titleAndContent', content: 'titleAndContent', obj: 'titleAndContent',
    sectionheader: 'sectionHeader', section: 'sectionHeader', twocontent: 'twoContent', two: 'twoContent', comparison: 'comparison',
    titleonly: 'titleOnly', blank: 'blank', contentwithcaption: 'contentWithCaption', picturewithcaption: 'pictureWithCaption',
    picture: 'pictureWithCaption', titleandverticaltext: 'titleAndVerticalText', verticaltitleandtext: 'verticalTitleAndText'}[k] ?? null;
  const hit = m.layouts.find(l => norm(l.name) === k) ?? (kind ? m.layouts.find(l => l.kind === kind) : null);
  return hit?.id ?? null;
}

/** deckcraft `current_master`: the master holding the current slide's layout (0 when none). */
export function currentMaster(c, sel) {
  const sl = slidesOf(c)[sel.slideIndex];
  const i = sl ? (c.masters ?? []).findIndex(m => (m.layouts ?? []).some(l => l.id === sl.layout)) : -1;
  return i < 0 ? 0 : i;
}

/** deckcraft `body_placeholder`: the main content placeholder a new slide's `body` goes into. */
function bodyPlaceholder(shapes) {
  let best = -1, bestRank = null;
  shapes.forEach((sh, i) => {
    const ph = sh.ph;
    if (!ph || isTitlePh(ph.kind)) return;
    const text = ph.kind === 'body' || ph.kind === 'obj' || ph.kind === 'subTitle';
    const small = ph.size === 'half' || ph.size === 'quarter';
    const rank = [ph.idx !== 1 ? 1 : 0, small ? 1 : 0, text ? 0 : 1];
    if (bestRank === null || rank[0] < bestRank[0] || (rank[0] === bestRank[0] && (rank[1] < bestRank[1] || (rank[1] === bestRank[1] && rank[2] < bestRank[2])))) {
      best = i; bestRank = rank;
    }
  });
  return best;
}

/** deckcraft `index_of`: the `index` param or the current slide; errors on a missing slide. */
function indexOf(ctx, p, cmd) {
  const i = optIndex(p, 'index', cmd) ?? selectionOf(ctx).slideIndex;
  if (i >= slidesOf(ctx.doc).length) throw bad(cmd, `no slide ${i}`, {path: '/index'});
  return i;
}

/** The selected slides' indices in document order, else the current slide (deckcraft `targets` of hide/layout/duplicate). */
function selectedOrCurrent(ctx) {
  const sel = selectionOf(ctx);
  const v = sel.slides.map(id => indexOfId(ctx.doc, id)).filter(i => i >= 0);
  return v.length ? v.sort((a, b) => a - b) : [sel.slideIndex];
}

/** A text body from `text`; leading tabs set the outline level (deckcraft `apply_leading_tabs`). */
function bodyWithLevels(text) {
  const b = bodyFromText(text);
  return {...b, paragraphs: b.paragraphs.map(p => promoteLeadingTabs(p)[0])};
}

/** deckcraft `go_to`: make slide `i` current and the only one selected; clear shapes, text and the range anchor. */
function goTo(ctx, iIn) {
  const list = slidesOf(ctx.doc);
  const i = Math.min(iIn, Math.max(list.length - 1, 0));
  const id = list[i]?.id;
  if (id) selectSlideList(ctx, [id], id);
  if (ctx.view?.slideRangeAnchor || ctx.view?.textLineEnd) ctx.setView({slideRangeAnchor: null, textLineEnd: null});
  return {index: i};
}

/**
 * The Layouts gallery (Home › New Slide › Layouts, Home › Layout): the current master's layouts
 * as gallery items, `value` the layout id (deckcraft ribbon/home.rs:51 lists the first master's).
 */
export function layoutGallery(c, sel) {
  const m = c.masters?.[currentMaster(c, sel)] ?? c.masters?.[0];
  return (m?.layouts ?? []).map(l => ({id: l.id, label: l.name || l.kind || l.id, value: l.id}));
}

/** Schema-2 only commands refuse schema-1 content. */
const v2 = (cmd, ctx) => { if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)'); };
/** Commands with a schema-1 implementation run it on schema-1 content. */
const legacyState = (id, pred) => ctx => (isSchema2(ctx.doc) ? pred(ctx) : LEGACY[id].state(ctx));

/**
 * deckcraft `apply_layout`: re-map slide `i`'s placeholders onto `layout`: content kept (matched
 * by type and index, else by title-ness), new empty placeholders for the rest, leftovers with
 * content stay (positioned), empty ones go. Writes the slide; `holder.pres` supplies ids.
 */
export function applyLayout(holder, i, layout, cmd) {
  const hit = layoutById(holder.pres, layout);
  if (!hit) throw bad(cmd, 'no such layout');
  const fresh = [];
  for (const ls of hit[1].shapes ?? []) {
    if (!ls.ph || isFooterPh(ls.ph.kind)) continue;
    const a = holder.take();
    fresh.push([a, ls]);
  }
  const sl = holder.pres.slides[i];
  if (!sl) throw bad(cmd, 'no slide');
  const old = structuredClone(sl.shapes ?? []);
  const out = [];
  for (const [id, ls] of fresh) {
    const lph = ls.ph;
    let k = old.findIndex(o => o.ph && o.ph.kind === lph.kind && (o.ph.idx === lph.idx || isTitlePh(lph.kind)));
    if (k < 0) k = old.findIndex(o => o.ph && isTitlePh(o.ph.kind) === isTitlePh(lph.kind) && !isFooterPh(o.ph.kind));
    if (k >= 0) {
      const [o] = old.splice(k, 1);
      out.push({...o, ph: {...o.ph, kind: lph.kind, idx: lph.idx}, xfrm: null});
    } else {
      out.push(newShape({id, name: ls.name, ph: structuredClone(lph), text: {body: {}, paragraphs: []}}));
    }
  }
  for (const o of old) {
    const emptyPh = !!o.ph && (!o.text || bodyEmpty(o.text)) && (o.kind?.type ?? 'shape') === 'shape';
    if (!emptyPh) out.push(o);
  }
  const slides = [...holder.pres.slides];
  slides[i] = {...sl, shapes: out, layout};
  holder.pres = {...holder.pres, slides};
}

/** An id allocator over a working copy of the presentation (`take()` → fresh id). */
export function idHolder(ctx, cmd) {
  const h = {pres: ctx.doc, take() {
    const next = Math.max(h.pres.nextId ?? 0, 1) + 1;
    if (!Number.isSafeInteger(next) || next > 0xffffffff) throw bad(cmd, NO_ID_SPACE);
    h.pres = {...h.pres, nextId: next};
    return String(next);
  }};
  return h;
}

/** A TextBody param (slide.notes `body`), shape-checked as the model's validator does. */
function checkBody(b, cmd) {
  const ok = b && typeof b === 'object' && Array.isArray(b.paragraphs) && b.paragraphs.every(p => p && typeof p === 'object'
    && (p.runs === undefined || (Array.isArray(p.runs) && p.runs.every(r => r && typeof r === 'object' && (r.text === undefined || typeof r.text === 'string'))))
    && (p.level === undefined || (Number.isInteger(p.level) && p.level >= 0 && p.level <= 8)));
  if (!ok) throw bad(cmd, 'invalid `body`: a text body has paragraphs of runs', {path: '/body'});
  return {body: {}, ...structuredClone(b)};
}

// ---------------------------------------------------------------------------------------------

export default defineCommands({
  family: 'slide',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'slide.new', label: 'New Slide', risk: 'edit', shortcut: ['Mod+Shift+N', 'Ctrl+M'],
      description: 'New Slide (Home › Slides): insert a slide after the current one on a layout (default: Title and Content after a title slide, else the current layout), optionally with title and body text (leading tabs in the body set bullet levels).',
      params: s.object({
        layout: s.optional(layoutKey),
        at: s.optional(s.integer({min: 0, max: MAX, description: '0-based index to insert at (default: after the current slide)'})),
        title: s.optional(s.string({max: 10000})),
        body: s.optional(s.string({max: 100000})),
      }),
      state(ctx) {
        if (!isSchema2(ctx.doc)) return LEGACY['slide.new'].state(ctx);
        const st = hasDoc(ctx);
        return st.enabled ? {enabled: true, value: layoutGallery(ctx.doc, selectionOf(ctx))} : st;
      },
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) return LEGACY['slide.new'].run(ctx, p);
        const c = ctx.doc;
        const sel = selectionOf(ctx);
        if (slidesOf(c).length >= MAX) throw bad('slide.new', `a presentation holds at most ${MAX} slides`);
        let layout;
        if (p.layout !== undefined) {
          layout = findLayout(c, p.layout, currentMaster(c, sel));
          if (!layout) throw bad('slide.new', `no layout ${JSON.stringify(p.layout)}`, {path: '/layout'});
        } else {
          // PowerPoint picks Title and Content after a title slide, else the current layout.
          const cur = slidesOf(c)[sel.slideIndex]?.layout ?? null;
          const isTitle = cur && layoutById(c, cur)?.[1]?.kind === 'title';
          layout = cur && !isTitle ? cur : layoutOfKind(c, 'titleAndContent') ?? cur ?? c.masters[0].layouts[0]?.id;
        }
        const made = newSlide(c, layout);
        if (!made) throw bad('slide.new', NO_ID_SPACE);
        const slide = made.slide;
        if (p.title !== undefined) {
          const k = slide.shapes.findIndex(x => x.ph && isTitlePh(x.ph.kind));
          if (k >= 0) slide.shapes[k] = {...slide.shapes[k], text: bodyFromText(p.title)};
        }
        if (p.body !== undefined) {
          const k = bodyPlaceholder(slide.shapes);
          if (k >= 0) slide.shapes[k] = {...slide.shapes[k], text: bodyWithLevels(p.body)};
        }
        const n = slidesOf(c).length;
        const at = Math.min(p.at ?? (n ? sel.slideIndex + 1 : 0), n);
        // Inherit the section of the slide before.
        const prev = at > 0 ? slidesOf(c)[at - 1] : null;
        const si = prev ? sectionOfId(c, prev.id) : -1;
        ctx.change.set(['nextId'], made.nextId);
        ctx.change.splice(['slides'], at, 0, slide);
        if (si >= 0) {
          const secs = cloneSections(c);
          const k = secs[si].slides.indexOf(prev.id);
          secs[si].slides.splice(Math.min(k >= 0 ? k + 1 : secs[si].slides.length, secs[si].slides.length), 0, slide.id);
          setSections(ctx, secs);
        } else if ((c.sections ?? []).length) {
          const secs = cloneSections(c);
          secs[0].slides.unshift(slide.id);
          setSections(ctx, secs);
        }
        selectSlideList(ctx, [slide.id], slide.id);
        return {index: at, id: slide.id};
      },
    },
    {
      id: 'slide.duplicate', label: 'Duplicate Slide', risk: 'edit',
      description: 'Duplicate Slide: copy the selected slides (or the slide at `index`) and insert the copies after the last of them; shapes get new ids and animations follow them.',
      params: s.object({index}),
      state: legacyState('slide.duplicate', hasSlide),
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) return LEGACY['slide.duplicate'].run(ctx, p);
        const c0 = ctx.doc;
        const given = optIndex(p, 'index', 'slide.duplicate');
        const indices = given !== undefined ? [given] : selectedOrCurrent(ctx);
        if (given !== undefined && given >= slidesOf(c0).length) throw bad('slide.duplicate', `no slide ${given}`, {path: '/index'});
        if (slidesOf(c0).length + indices.length > MAX) throw bad('slide.duplicate', `a presentation holds at most ${MAX} slides`);
        const holder = idHolder(ctx, 'slide.duplicate');
        const last = indices[indices.length - 1] ?? 0;
        const newIds = [];
        indices.forEach((i, k) => {
          const src = holder.pres.slides[i];
          if (!src) return;
          const copyId = holder.take();
          const {shapes, map} = reid('slide.duplicate', holder, src.shapes ?? []);
          const copy = {...structuredClone(src), id: copyId, shapes, animations: remapAnimations(src.animations, map)};
          const si = sectionOfId(holder.pres, src.id);
          const at = Math.min(last + 1 + k, holder.pres.slides.length);
          const slides = [...holder.pres.slides];
          slides.splice(at, 0, copy);
          holder.pres = {...holder.pres, slides};
          newIds.push(copyId);
          if (si >= 0) {
            const secs = cloneSections(holder.pres);
            secs[si].slides.push(copyId);
            // Keep the section list in document order so the copy sits next to its source.
            secs[si].slides = sortByDoc(secs[si].slides, orderOf(holder.pres));
            holder.pres = {...holder.pres, sections: secs};
          }
        });
        ctx.change.set(['nextId'], holder.pres.nextId);
        newIds.forEach((id, k) => ctx.change.splice(['slides'], Math.min(last + 1 + k, slidesOf(ctx.doc).length), 0, holder.pres.slides[indexOfId(holder.pres, id)]));
        if ((holder.pres.sections ?? []).length) setSections(ctx, holder.pres.sections);
        const cur = slidesOf(ctx.doc)[Math.min(last + newIds.length, slidesOf(ctx.doc).length - 1)]?.id;
        selectSlideList(ctx, newIds, cur);
        return {ids: newIds};
      },
    },
    {
      id: 'slide.delete', label: 'Delete Slide', risk: 'edit',
      description: 'Delete Slide: remove slides by id, by index, or the selected (else the current) slide; they leave their sections. Undo brings them back.',
      params: s.object({index, ids: s.optional(s.array(slideId, {min: 1, max: MAX}))}),
      state: legacyState('slide.delete', hasSlide),
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) return LEGACY['slide.delete'].run(ctx, {...p, ids: p.ids?.map(String)});
        const c = ctx.doc;
        const sel = selectionOf(ctx);
        let ids;
        if (Array.isArray(p.ids)) ids = p.ids.map(sid);
        else {
          const i = optIndex(p, 'index', 'slide.delete');
          if (i !== undefined) ids = slidesOf(c)[i] ? [slidesOf(c)[i].id] : [];
          else if (sel.slides.length) ids = sel.slides;
          else ids = sel.slide ? [sel.slide.id] : [];
        }
        const gone = new Set(ids);
        const idx = slidesOf(c).map((x, i) => (gone.has(x.id) ? i : -1)).filter(i => i >= 0);
        if (!ids.length) throw bad('slide.delete', 'no such slide');
        const first = idx.length ? Math.min(...idx) : 0;
        for (let k = idx.length - 1; k >= 0; k--) ctx.change.splice(['slides'], idx[k], 1);
        if ((c.sections ?? []).length) setSections(ctx, cloneSections(c).map(sec => ({...sec, slides: sec.slides.filter(x => !gone.has(x))})));
        const rest = slidesOf(ctx.doc);
        const cur = rest[Math.min(first, Math.max(rest.length - 1, 0))]?.id;
        if (cur) selectSlideList(ctx, [cur], cur);
        else ctx.setSelection({ranges: [], primary: 0});
        return {deleted: ids.length, remaining: rest.length};
      },
    },
    {
      id: 'slide.move', label: 'Move Slide', risk: 'edit',
      description: 'Move Slide: move the slide at `from` (default: the current one) to index `to`; sections follow the slide\'s new neighbour.',
      params: s.object({from: s.optional(s.integer({min: 0, max: MAX})), to: s.integer({min: 0, max: MAX})}),
      state: legacyState('slide.move', hasSlide),
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) return LEGACY['slide.move'].run(ctx, p);
        const c = ctx.doc;
        const from = optIndex(p, 'from', 'slide.move') ?? selectionOf(ctx).slideIndex;
        if (from >= slidesOf(c).length) throw bad('slide.move', `no slide ${from}`, {path: '/from'});
        const sl = slidesOf(c)[from];
        ctx.change.splice(['slides'], from, 1);
        const to = Math.min(p.to, slidesOf(ctx.doc).length);
        ctx.change.splice(['slides'], to, 0, sl);
        // Keep sections consistent with order: the id moves into the section of its new neighbour.
        if ((c.sections ?? []).length) {
          const secs = cloneSections(c).map(sec => ({...sec, slides: sec.slides.filter(x => x !== sl.id)}));
          const neighbour = to > 0 ? slidesOf(ctx.doc)[to - 1]?.id : null;
          let si = neighbour ? secs.findIndex(sec => sec.slides.includes(neighbour)) : -1;
          if (si < 0) si = 0;
          secs[si].slides = sortByDoc([...secs[si].slides, sl.id], orderOf(ctx.doc));
          setSections(ctx, secs);
        }
        selectSlideList(ctx, [sl.id], sl.id);
        return {index: to};
      },
    },
    {
      id: 'slide.go', label: 'Go to Slide', risk: 'read', effect: 'view',
      description: 'Go to Slide: make the slide at `index` (or with `id`) the current one, selected alone.',
      params: s.object({index: s.optional(s.integer({min: 0, max: MAX})), id: s.optional(slideId)}),
      state: hasSlide,
      run(ctx, p) {
        v2('slide.go', ctx);
        let i;
        if (p.index !== undefined) i = p.index;
        else if (p.id !== undefined) {
          i = indexOfId(ctx.doc, sid(p.id));
          if (i < 0) throw bad('slide.go', 'no such slide', {path: '/id'});
        } else throw bad('slide.go', 'missing `index`', {path: '/index'});
        if (i >= slidesOf(ctx.doc).length) throw bad('slide.go', `no slide ${i}`, {path: '/index'});
        return goTo(ctx, i);
      },
    },
    {id: 'slide.next', label: 'Next Slide', risk: 'read', effect: 'view', shortcut: 'PageDown', shortcutContext: 'prism.slides',
      description: 'Next Slide: go to the slide after the current one.', params: s.object({}), state: hasSlide,
      run(ctx) { v2('slide.next', ctx); return goTo(ctx, selectionOf(ctx).slideIndex + 1); }},
    {id: 'slide.previous', label: 'Previous Slide', risk: 'read', effect: 'view', shortcut: 'PageUp', shortcutContext: 'prism.slides',
      description: 'Previous Slide: go to the slide before the current one.', params: s.object({}), state: hasSlide,
      run(ctx) { v2('slide.previous', ctx); return goTo(ctx, Math.max(selectionOf(ctx).slideIndex - 1, 0)); }},
    {id: 'slide.first', label: 'First Slide', risk: 'read', effect: 'view', shortcut: 'Home', shortcutContext: 'prism.slides',
      description: 'First Slide: go to the first slide.', params: s.object({}), state: hasSlide,
      run(ctx) { v2('slide.first', ctx); return goTo(ctx, 0); }},
    {id: 'slide.last', label: 'Last Slide', risk: 'read', effect: 'view', shortcut: 'End', shortcutContext: 'prism.slides',
      description: 'Last Slide: go to the last slide.', params: s.object({}), state: hasSlide,
      run(ctx) { v2('slide.last', ctx); return goTo(ctx, Math.max(slidesOf(ctx.doc).length - 1, 0)); }},
    {
      id: 'slide.selectRange', label: 'Select Slide Range', risk: 'read', effect: 'view',
      description: 'Shift-click in the slide list: select every slide from `from` (default: the anchor of the previous Shift-click, else the current slide) to `to`; `add` keeps the slides already selected (Ctrl+Shift-click).',
      params: s.object({to: s.integer({min: 0, max: MAX}), from: s.optional(s.integer({min: 0, max: MAX})), add: s.optional(s.boolean())}),
      state: hasSlide,
      run(ctx, p) {
        v2('slide.selectRange', ctx);
        const c = ctx.doc;
        const sel = selectionOf(ctx);
        const n = slidesOf(c).length;
        const anchor = ctx.view?.slideRangeAnchor;
        const fromAnchor = Array.isArray(anchor) && anchor[1] === sel.slideId ? indexOfId(c, anchor[0]) : -1;
        const from = p.from ?? (fromAnchor >= 0 ? fromAnchor : sel.slideIndex);
        if (p.to >= n || from >= n) throw bad('slide.selectRange', 'no such slide');
        const [a, b] = [Math.min(from, p.to), Math.max(from, p.to)];
        const range = slidesOf(c).slice(a, b + 1).map(x => x.id);
        let ids = range;
        if (p.add) { ids = [...sel.slides]; for (const id of range) if (!ids.includes(id)) ids.push(id); }
        const cur = slidesOf(c)[p.to].id;
        selectSlideList(ctx, ids, cur);
        ctx.setView({slideRangeAnchor: [slidesOf(c)[from].id, cur], textLineEnd: null});
        return {selected: ids};
      },
    },
    {
      id: 'slide.selectSlides', label: 'Select Slides', risk: 'read', effect: 'view',
      description: 'Select slides in the slide list by id and/or index; `add` keeps the slides already selected. The last one becomes the current slide.',
      params: s.object({ids: s.optional(s.array(slideId, {max: MAX})), indices: s.optional(s.array(s.integer({min: 0, max: MAX}), {max: MAX})), add: s.optional(s.boolean())}),
      state: hasSlide,
      run(ctx, p) {
        v2('slide.selectSlides', ctx);
        const c = ctx.doc;
        const sel = selectionOf(ctx);
        const ids = (p.ids ?? []).map(sid);
        for (const i of p.indices ?? []) if (slidesOf(c)[i]) ids.push(slidesOf(c)[i].id);
        let next;
        if (p.add) { next = [...sel.slides]; for (const id of ids) if (!next.includes(id)) next.push(id); }
        else next = ids;
        const lastId = [...ids].reverse().find(id => indexOfId(c, id) >= 0);
        const cur = lastId ?? sel.slideId;
        // Ids that are not slides stay out of the selection (the kernel selection holds addresses).
        next = next.filter(id => indexOfId(c, id) >= 0);
        selectSlideList(ctx, next, cur);
        if (ctx.view?.slideRangeAnchor) ctx.setView({slideRangeAnchor: null});
        return {selected: next};
      },
    },
    {
      id: 'slide.hide', label: 'Hide Slide', risk: 'edit',
      description: 'Hide Slide (Slide Show › Set Up): hide the selected slides (or the slide at `index`) in the slide show; toggles when `hidden` is not given (all hidden → show).',
      params: s.object({index, hidden: s.optional(s.boolean())}),
      state(ctx) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        const targets = selectedOrCurrent(ctx);
        return {enabled: true, checked: targets.every(i => !!slidesOf(ctx.doc)[i]?.hidden)};
      },
      run(ctx, p) {
        v2('slide.hide', ctx);
        const given = optIndex(p, 'index', 'slide.hide');
        const targets = given !== undefined ? [given] : selectedOrCurrent(ctx);
        const all = targets.every(i => !!slidesOf(ctx.doc)[i]?.hidden);
        const value = p.hidden ?? !all;
        for (const i of targets) if (slidesOf(ctx.doc)[i]) ctx.change.set(['slides', i, 'hidden'], value);
        return {hidden: value};
      },
    },
    {
      id: 'slide.layout', label: 'Layout', risk: 'edit',
      description: 'Layout (Home › Slides): put the selected slides (or the slide at `index`) on another layout; placeholder content is kept and re-mapped by type.',
      params: s.object({layout: layoutKey, index}),
      state(ctx) {
        const st = hasSlide(ctx);
        if (!st.enabled) return st;
        // The gallery's items (the current layout is the selected slide's `layout`).
        return {enabled: true, value: layoutGallery(ctx.doc, selectionOf(ctx))};
      },
      run(ctx, p) {
        v2('slide.layout', ctx);
        const given = optIndex(p, 'index', 'slide.layout');
        const targets = given !== undefined ? [given] : selectedOrCurrent(ctx);
        const layout = findLayout(ctx.doc, p.layout, currentMaster(ctx.doc, selectionOf(ctx)));
        if (!layout) throw bad('slide.layout', `no layout ${JSON.stringify(p.layout)}`, {path: '/layout'});
        const holder = idHolder(ctx, 'slide.layout');
        for (const i of targets) applyLayout(holder, i, layout, 'slide.layout');
        ctx.change.set(['nextId'], holder.pres.nextId);
        for (const i of targets) ctx.change.set(['slides', i], holder.pres.slides[i]);
        const sel = selectionOf(ctx);
        selectSlideList(ctx, sel.slides, sel.slideId);
        return {layout};
      },
    },
    {
      id: 'slide.reset', label: 'Reset', risk: 'edit',
      description: 'Reset (Home › Slides): put the slide\'s placeholders back to the layout\'s position, size and formatting (text kept) and drop its own background.',
      params: s.object({index}),
      state: hasSlide,
      run(ctx, p) {
        v2('slide.reset', ctx);
        const i = indexOf(ctx, p, 'slide.reset');
        const holder = idHolder(ctx, 'slide.reset');
        applyLayout(holder, i, holder.pres.slides[i].layout, 'slide.reset');
        const sl = holder.pres.slides[i];
        const shapes = sl.shapes.map(sh => {
          if (!sh.ph) return sh;
          const n = {...sh, xfrm: null, fill: null, line: null, effects: null, geom: presetGeom('rect')};
          if (n.text) {
            const {listStyle, ...rest} = n.text;
            void listStyle;
            n.text = {...rest, body: {}, paragraphs: (n.text.paragraphs ?? []).map(para => {
              const {props, ...pr} = para;
              void props;
              return {...pr, runs: (para.runs ?? []).map(r => { const {props: rp, ...rr} = r; void rp; return rr; })};
            })};
          }
          return n;
        });
        ctx.change.set(['nextId'], holder.pres.nextId);
        ctx.change.set(['slides', i], {...sl, background: null, shapes});
        const sel = selectionOf(ctx);
        selectSlideList(ctx, sel.slides, sel.slideId);
        return {};
      },
    },
    {
      id: 'slide.notes', label: 'Notes', risk: 'edit',
      description: 'Notes: set the speaker notes of the current slide (or `index`): `text` as typed (only what changed is replaced, so untouched notes keep their formatting) or a formatted `body`.',
      params: s.object({text: s.optional(s.string({max: 1000000})), body: s.optional(s.any({description: 'Formatted notes (a text body)'})), index}),
      state: hasSlide,
      run(ctx, p) {
        v2('slide.notes', ctx);
        const i = indexOf(ctx, p, 'slide.notes');
        const notes = slidesOf(ctx.doc)[i].notes ?? {body: {}, paragraphs: []};
        const next = p.body !== undefined ? checkBody(p.body, 'slide.notes') : replaceText(notes, p.text ?? '');
        ctx.change.set(['slides', i, 'notes'], next);
        return {};
      },
    },
    {
      id: 'slide.rename', label: 'Rename Slide', risk: 'edit',
      description: 'Rename Slide: the slide\'s name (shown by Zoom and links).',
      params: s.object({name: s.string({max: 1000}), index}),
      state: hasSlide,
      run(ctx, p) {
        v2('slide.rename', ctx);
        const i = indexOf(ctx, p, 'slide.rename');
        ctx.change.set(['slides', i, 'name'], p.name ?? '');
        return {};
      },
    },
    {
      id: 'section.add', label: 'Add Section', risk: 'edit',
      description: 'Add Section (Home › Slides › Section): start a section at the slide `at` (default: the current slide); the first one puts the slides before it in a "Default Section".',
      params: s.object({name: s.optional(s.string({max: 1000})), at: s.optional(s.integer({min: 0, max: MAX}))}),
      state: hasSlide,
      run(ctx, p) {
        v2('section.add', ctx);
        const c = ctx.doc;
        const at = Math.min(optIndex(p, 'at', 'section.add') ?? selectionOf(ctx).slideIndex, Math.max(slidesOf(c).length - 1, 0));
        const name = p.name ?? 'Untitled Section';
        const ids = slidesOf(c).map(x => x.id);
        let secs = cloneSections(c);
        if (!secs.length) {
          if (at > 0) secs.push({name: 'Default Section', slides: ids.slice(0, at)});
          secs.push({name, slides: ids.slice(at)});
        } else {
          const start = ids[at];
          if (!start) throw bad('section.add', 'no slide');
          let si = secs.findIndex(sec => sec.slides.includes(start));
          if (si < 0) si = 0;
          const sec = secs[si];
          let k = sec.slides.indexOf(start);
          if (k < 0) k = sec.slides.length;
          const tail = sec.slides.splice(k);
          secs.splice(si + 1, 0, {name, slides: tail});
          secs = secs.filter(x => x.slides.length || x.name !== 'Default Section');
        }
        setSections(ctx, secs);
        return {sections: secs.length};
      },
    },
    {
      id: 'section.rename', label: 'Rename Section', risk: 'edit', dialog: 'dialog.renameSection',
      description: 'Rename Section: give section `index` a new name.',
      params: s.object({index: s.integer({min: 0, max: MAX}), name: s.string({max: 1000})}),
      state: hasSlide,
      run(ctx, p) {
        v2('section.rename', ctx);
        if (!(ctx.doc.sections ?? [])[p.index]) throw bad('section.rename', 'no such section', {path: '/index'});
        ctx.change.set(['sections', p.index, 'name'], p.name ?? '');
        return {};
      },
    },
    {
      id: 'section.remove', label: 'Remove Section', risk: 'edit',
      description: 'Remove Section: remove section `index` (default: the section of the current slide, as Home › Section › Remove Section does); its slides join the section before (or after), or are deleted with `slides: true` (Remove Section & Slides).',
      params: s.object({index: s.optional(s.integer({min: 0, max: MAX})), slides: s.optional(s.boolean())}),
      state: hasSlide,
      run(ctx, p) {
        v2('section.remove', ctx);
        const c = ctx.doc;
        const secs = cloneSections(c);
        const index = p.index ?? sectionOfId(c, selectionOf(ctx).slideId);
        if (index < 0 || index >= secs.length) throw bad('section.remove', 'no such section', {path: '/index'});
        p = {...p, index};
        const [sec] = secs.splice(p.index, 1);
        if (p.slides) {
          const gone = new Set(sec.slides);
          const sel = selectionOf(ctx);
          const idx = slidesOf(c).map((x, i) => (gone.has(x.id) ? i : -1)).filter(i => i >= 0);
          for (let k = idx.length - 1; k >= 0; k--) ctx.change.splice(['slides'], idx[k], 1);
          const rest = slidesOf(ctx.doc);
          const keep = rest.some(x => x.id === sel.slideId) ? sel.slideId : rest[Math.min(sel.slideIndex, Math.max(rest.length - 1, 0))]?.id;
          if (keep) selectSlideList(ctx, sel.slides.filter(id => !gone.has(id)), keep);
          else ctx.setSelection({ranges: [], primary: 0});
        } else if (p.index > 0) secs[p.index - 1].slides.push(...sec.slides);
        else if (secs[0]) secs[0].slides = [...sec.slides, ...secs[0].slides];
        setSections(ctx, secs);
        return {};
      },
    },
    {
      id: 'section.removeAll', label: 'Remove All Sections', risk: 'edit',
      description: 'Remove All Sections: the slides stay, in order, without sections.',
      params: s.object({}),
      state: hasSlide,
      run(ctx) { v2('section.removeAll', ctx); setSections(ctx, []); return {}; },
    },
    {
      id: 'section.move', label: 'Move Section', risk: 'edit',
      description: 'Move Section: move section `index` to position `to`; its slides move with it.',
      params: s.object({index: s.integer({min: 0, max: MAX}), to: s.integer({min: 0, max: MAX})}),
      state: hasSlide,
      run(ctx, p) {
        v2('section.move', ctx);
        const c = ctx.doc;
        const secs = cloneSections(c);
        if (p.index >= secs.length) throw bad('section.move', 'no such section', {path: '/index'});
        const [sec] = secs.splice(p.index, 1);
        secs.splice(Math.min(p.to, secs.length), 0, sec);
        setSections(ctx, secs);
        // Reorder slides to follow sections (stable: slides in no section go last).
        const order = new Map(secs.flatMap(x => x.slides).map((id, i) => [id, i]));
        const sorted = slidesOf(c).map((x, i) => [x, i]).sort((a, b) => ((order.get(a[0].id) ?? Infinity) - (order.get(b[0].id) ?? Infinity)) || a[1] - b[1]).map(e => e[0]);
        if (sorted.some((x, i) => x.id !== slidesOf(c)[i].id)) ctx.change.set(['slides'], sorted);
        return {};
      },
    },
    {
      id: 'slide.fromOutline', label: 'Slides from Outline…', risk: 'edit', dialog: 'dialog.outline',
      description: 'Slides from Outline (Insert › Slides From): one Title and Content slide per unindented line, tab-indented lines its bullets (or Markdown: headings are slides, list items bullets), inserted after the current slide.',
      params: s.object({text: s.string({max: 1000000}), markdown: s.optional(s.boolean())}),
      state: hasDoc,
      run(ctx, p) {
        v2('slide.fromOutline', ctx);
        const c = ctx.doc;
        const sel = selectionOf(ctx);
        const entries = p.markdown ? parseMarkdown(p.text ?? '') : parseOutline(p.text ?? '');
        const room = Math.max(MAX - slidesOf(c).length, 0);
        const made = outlineSlides(c, entries.slice(0, room));
        const n = made.slides.length;
        if (!n) return {slides: 0};
        const at = Math.min(slidesOf(c).length ? sel.slideIndex + 1 : 0, slidesOf(c).length);
        ctx.change.set(['nextId'], made.pres.nextId);
        ctx.change.splice(['slides'], at, 0, ...made.slides);
        const ids = made.slides.map(x => x.id);
        // Join the section of the slide before, as slide.new does.
        const prev = at > 0 ? slidesOf(c)[at - 1]?.id : null;
        const si = prev ? sectionOfId(c, prev) : -1;
        if ((c.sections ?? []).length) {
          const secs = cloneSections(c);
          if (si >= 0) {
            const k = secs[si].slides.indexOf(prev);
            const pos = Math.min(k >= 0 ? k + 1 : secs[si].slides.length, secs[si].slides.length);
            secs[si].slides.splice(pos, 0, ...ids);
          } else secs[0].slides.unshift(...ids);
          setSections(ctx, secs);
        }
        return {slides: n};
      },
    },
  ],
});
