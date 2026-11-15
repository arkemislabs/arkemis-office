// Insert Hyperlink (submit: insert.hyperlink): link to a web page, a slide in this presentation or
// an email address, with a ScreenTip; text to display when nothing is selected.
// Translated from deckcraft crates/ui-egui/src/dialogs/hyperlink.rs (`HyperlinkSeed`, `seed_of_link`,
// `seed_from`, `link_covering`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Place in This Document lists First, Last, Next and Previous Slide and every slide by title; Browse (in the body of
// the Address field) fills the address with the chosen file's name. Not offered: Create New Document, Subject,
// Bookmark… (PowerPoint lists the slides of the file the address names; reading another presentation here is not offered, and this presentation's own slides are Place in This Document) and Target Frame (nothing here to set).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findShape, slideTitle} from '../model/presentation.mjs';
import {currentSlideId, slideById, selectedShapeIds, textSelection} from '../model/doc.mjs';
import {posOf, runLen} from '../model/text.mjs';

const JUMPS = ['first', 'last', 'next', 'previous'];
const blank = () => ({mode: 'url', url: 'https://', email: '', slide: 1, tip: '', highlight: false, preserve: false});

/** `seed_of_link`: the dialog's values for an existing link. */
export function seedOfLink(link, slideIds) {
  const seed = {mode: 'url', url: '', email: '', slide: 1, tip: link.tooltip ?? '', highlight: !!link.highlightClick, preserve: true};
  const a = link.action ?? {};
  if (a.kind === 'url') {
    seed.preserve = false;
    if (a.url.startsWith('mailto:')) { seed.mode = 'email'; seed.email = a.url.slice(7); seed.url = 'https://'; } else seed.url = a.url;
  } else if (['firstSlide', 'lastSlide', 'nextSlide', 'previousSlide'].includes(a.kind)) {
    seed.preserve = false; seed.mode = 'slide'; seed.url = 'https://';
    seed.slide = {firstSlide: 'first', lastSlide: 'last', nextSlide: 'next', previousSlide: 'previous'}[a.kind];
  } else if (a.kind === 'slide') {
    const i = slideIds.indexOf(a.slide);
    if (i >= 0) { seed.preserve = false; seed.mode = 'slide'; seed.slide = i + 1; seed.url = 'https://'; }
  }
  return seed;
}

/** `link_covering`: the link on every run the text selection covers: null (none), a link, or 'mixed'. */
export function linkCovering(body, a, b) {
  if (a[0] === b[0] && a[1] === b[1]) return null;
  let seen;
  for (let pi = a[0]; pi <= b[0]; pi++) {
    const para = body.paragraphs?.[pi];
    if (!para) continue;
    const from = pi === a[0] ? a[1] : 0, to = pi === b[0] ? b[1] : Infinity;
    if (from >= to) continue;
    let acc = 0;
    for (const run of para.runs ?? []) {
      const len = runLen(run), end = acc + len;
      if (len > 0 && end > from && acc < to) {
        const l = run.props?.link ?? null;
        if (seen === undefined) seen = l;
        else if (JSON.stringify(seen) !== JSON.stringify(l)) return 'mixed';
      }
      acc = end;
    }
  }
  return seen ?? null;
}

export default defineDialog({
  id: 'dialog.hyperlink',
  title: 'Insert Hyperlink',
  command: 'insert.hyperlink',
  init(ctx) {
    const c = ctx.doc;
    const slideIds = (c.slides ?? []).map(s => s.id);
    const slideOptions = (c.slides ?? []).map((s, i) => ({value: i, label: `${i + 1}. ${slideTitle(s) || `Slide ${i + 1}`}`}));
    const sl = slideById(c, currentSlideId(c, ctx.selection));
    let current = null;
    const t = textSelection(c, ctx.selection);
    if (t && !t.notes && !t.cell) {
      const sh = findShape(sl?.shapes, t.shape);
      if (sh?.text) {
        const pa = posOf(sh.text, Math.min(t.anchor, t.caret)), pb = posOf(sh.text, Math.max(t.anchor, t.caret));
        current = linkCovering(sh.text, pa, pb);
      }
    } else {
      const id = selectedShapeIds(c, ctx.selection)[0];
      current = id ? findShape(sl?.shapes, id)?.click ?? null : null;
    }
    const seed = current === null ? blank() : current === 'mixed' ? {...blank(), preserve: true, url: ''} : seedOfLink(current, slideIds);
    // Place in This Document: the four jumps, then every slide by its title.
    const slideTargets = [{value: 'first', label: 'First Slide'}, {value: 'last', label: 'Last Slide'}, {value: 'next', label: 'Next Slide'}, {value: 'previous', label: 'Previous Slide'},
      ...slideOptions.map(o => ({value: o.value + 1, label: o.label}))];
    return {...seed, display: '', hasText: !!t, slideOptions, slideTargets};
  },
  validate(v) {
    if (v.mode === 'url' && !String(v.url ?? '').trim()) return [{field: 'url', message: 'Type an address.'}];
    if (v.mode === 'email' && !String(v.email ?? '').trim()) return [{field: 'email', message: 'Type an email address.'}];
    if (v.mode === 'slide' && !JUMPS.includes(v.slide) && !(Number.isInteger(Number(v.slide)) && Number(v.slide) >= 1 && Number(v.slide) <= (v.slideOptions?.length ?? 1))) return [{field: 'slide', message: 'Choose a place in this presentation.'}];
    return [];
  },
  toCommand(v) {
    const params = {tooltip: String(v.tip ?? ''), highlightClick: !!v.highlight};
    if (v.mode === 'slide') { if (JUMPS.includes(v.slide)) params.jump = v.slide; else params.slide = Number(v.slide) - 1; }
    else if (v.mode === 'email') params.url = `mailto:${String(v.email).trim()}`;
    else params.url = String(v.url).trim();
    if (String(v.display ?? '').trim()) params.text = String(v.display);
    return {command: 'insert.hyperlink', params};
  },
});
