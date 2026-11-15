// Action Settings (submit: shape.action): what clicking the selected shapes (Mouse Click) or
// pointing at them (Mouse Over) does in a slide show: None, Hyperlink to (next, previous, first,
// last, last viewed slide, end show, a slide, a URL, a custom show), Run program, Play media;
// Highlight click.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (action settings dialog over
// shape.action, crates/engine/src/cmd/insert/links.rs) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
// PowerPoint's Run macro, Object action and Play sound are not offered (deckcraft has none of them).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findShape, slideTitle} from '../model/presentation.mjs';
import {currentSlideId, slideById, selectedShapeIds} from '../model/doc.mjs';

/** Hyperlink targets, as PowerPoint lists them, with deckcraft's action ids. */
export const TARGETS = Object.freeze([
  ['next', 'Next Slide'], ['previous', 'Previous Slide'], ['first', 'First Slide'], ['last', 'Last Slide'], ['lastViewed', 'Last Slide Viewed'],
  ['endShow', 'End Show'], ['customShow', 'Custom Show…'], ['slide', 'Slide…'], ['url', 'URL…'],
]);
const KIND = {nextSlide: 'next', previousSlide: 'previous', firstSlide: 'first', lastSlide: 'last', lastViewed: 'lastViewed', endShow: 'endShow',
  customShow: 'customShow', slide: 'slide', url: 'url'};

/** One tab's values from a shape's click or hover link. */
export function tabValues(link, slides) {
  const out = {kind: 'none', target: 'next', arg: '', program: '', highlight: link ? !!link.highlightClick : true};
  const a = link?.action;
  if (!a) return out;
  if (a.kind === 'program') return {...out, kind: 'program', program: a.path ?? ''};
  if (a.kind === 'playMedia') return {...out, kind: 'playMedia'};
  out.kind = 'hyperlink';
  out.target = KIND[a.kind] ?? 'next';
  if (a.kind === 'url') out.arg = a.url ?? '';
  if (a.kind === 'customShow') out.arg = a.name ?? '';
  if (a.kind === 'slide') out.arg = String(Math.max(slides.findIndex(s => s.id === a.slide), 0) + 1);
  return out;
}

/** The shape.action params for one tab (`on`: click | hover). */
export function tabParams(v, prefix, on) {
  const kind = v[`${prefix}Kind`];
  const p = {on, highlight: !!v[`${prefix}Highlight`]};
  if (kind === 'none') return {...p, action: 'none'};
  if (kind === 'program') return {...p, action: 'program', path: String(v[`${prefix}Program`] ?? '')};
  if (kind === 'playMedia') return {...p, action: 'playMedia'};
  const target = v[`${prefix}Target`];
  const arg = String(v[`${prefix}Arg`] ?? '').trim();
  if (target === 'url') return {...p, action: 'url', url: arg};
  if (target === 'customShow') return {...p, action: 'customShow', show: arg};
  if (target === 'slide') return {...p, action: 'slide', slide: Math.max(Number.parseInt(arg, 10) - 1, 0)};
  return {...p, action: target};
}

export default defineDialog({
  id: 'dialog.action',
  title: 'Action Settings',
  command: 'shape.action',
  init(ctx) {
    const c = ctx.doc;
    const sl = slideById(c, currentSlideId(c, ctx.selection));
    const id = selectedShapeIds(c, ctx.selection)[0];
    const sh = id ? findShape(sl?.shapes, id) : null;
    const slides = c.slides ?? [];
    const ck = tabValues(sh?.click ?? null, slides), hv = tabValues(sh?.hover ?? null, slides);
    const v = {};
    for (const [prefix, t] of [['click', ck], ['hover', hv]]) {
      v[`${prefix}Kind`] = t.kind; v[`${prefix}Target`] = t.target; v[`${prefix}Arg`] = t.arg; v[`${prefix}Program`] = t.program; v[`${prefix}Highlight`] = t.highlight;
    }
    v.slideCount = slides.length;
    v.slideTitles = slides.map((s, i) => slideTitle(s) || `Slide ${i + 1}`);
    return v;
  },
  validate(v) {
    const out = [];
    for (const prefix of ['click', 'hover']) {
      if (v[`${prefix}Kind`] === 'program' && !String(v[`${prefix}Program`] ?? '').trim()) out.push({field: `${prefix}Program`, message: 'Type the program to run.'});
      if (v[`${prefix}Kind`] !== 'hyperlink') continue;
      const t = v[`${prefix}Target`], arg = String(v[`${prefix}Arg`] ?? '').trim();
      if ((t === 'url' || t === 'customShow') && !arg) out.push({field: `${prefix}Arg`, message: t === 'url' ? 'Type an address.' : 'Type the custom show.'});
      if (t === 'slide' && !(Number.parseInt(arg, 10) >= 1 && Number.parseInt(arg, 10) <= (v.slideCount ?? 1))) out.push({field: `${prefix}Arg`, message: 'Type a slide number.'});
    }
    return out;
  },
  toCommand(v) {
    return {batch: [{command: 'shape.action', params: tabParams(v, 'click', 'click')}, {command: 'shape.action', params: tabParams(v, 'hover', 'hover')}]};
  },
});
