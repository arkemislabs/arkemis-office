// Find / Replace dialog model (Home › Editing › Find, Ctrl+F; Replace, Ctrl+H): Find what, Replace
// with (replace mode), Match case, Find whole words only; Find Next steps through the matches in
// slide text, table cells and notes ("Match n of m on slide k (notes)."), Replace replaces the
// current match and finds the next, Replace All reports "Replaced n occurrence(s).", Replace…
// switches a Find dialog to replace mode, Close.
// Translated from deckcraft crates/ui-egui/src/dialogs/find.rs (`find_dialog`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Buttons are keyed by their field ids (findNext, replace, replaceAll, replaceMode).
// Find Next goes to the match's slide and selects the matched text (PowerPoint highlights the
// found text; deckcraft selects the shape that holds it), through slide.go, text.edit and
// text.select. Button handlers keep the dialog's own state (`cur`: the current match, `next`:
// the index Find Next shows, `status`) in its values, as deckcraft keeps them in the dialog's fields.

import {defineDialog} from '../../kernel/dialog.mjs';
import {findOpts, findAll, replaceAll} from '../commands/find.mjs';

const query = v => ({text: String(v.text ?? ''), matchCase: !!v.matchCase, wholeWords: !!v.wholeWords});
const PRODUCT = 'Prism';
const cantFind = text => `${PRODUCT} can't find “${text}”.`;

/** The steps that show match `m`: its slide, then its text selected (shape text, table cell or notes). */
export function showMatch(m) {
  const steps = [{command: 'slide.go', params: {index: m.slide}}];
  if (m.shape == null) steps.push({command: 'text.edit', params: {notes: true}});
  else steps.push({command: 'text.edit', params: {id: m.shape, ...(m.cell ? {cell: m.cell} : {}), at: [m.para, m.start]}});
  steps.push({command: 'text.select', params: {anchor: [m.para, m.start], caret: [m.para, m.end]}});
  return {batch: steps};
}

/** deckcraft `find_next` on `doc`: sets cur/next/status in `v`; returns the steps or null. */
function findNext(doc, v) {
  const text = String(v.text ?? '');
  let list = [];
  try { list = findAll(doc, findOpts(query(v), 'text.find')); } catch { list = []; }
  if (!list.length) {
    v.status = cantFind(text);
    v.cur = null;
    return null;
  }
  const n = (Number.isInteger(v.next) ? v.next : 0) % list.length;
  const m = list[n];
  v.cur = m;
  v.next = n + 1;
  v.status = `Match ${n + 1} of ${list.length} on slide ${m.slide + 1}${m.shape == null ? ' (notes)' : ''}.`;
  return showMatch(m);
}

/** A read-only call so the dialog redraws its status when nothing else runs. */
const refresh = v => ({command: 'text.find', params: query(v)});

export default defineDialog({
  id: 'dialog.find',
  title: 'Find and Replace',
  command: 'text.find',
  init: () => ({text: '', with: '', matchCase: false, wholeWords: false, replace: false, status: '', cur: null, next: 0}),
  derive(v, changed) {
    // A new search starts from the first match.
    if (changed.some(k => ['text', 'matchCase', 'wholeWords'].includes(k))) return {cur: null, next: 0, status: ''};
    return {};
  },
  validate: v => (String(v.text ?? '') ? [] : [{field: 'text', message: 'Type what to find'}]),
  buttons: {
    findNext(ctx, v) {
      if (!v.text) return null;
      return findNext(ctx.doc, v) ?? refresh(v);
    },
    replace(ctx, v) {
      if (!v.text) return null;
      const o = findOpts(query(v), 'text.replace');
      const steps = [];
      let doc = ctx.doc;
      if (v.cur) {
        const at = {slide: v.cur.slide, shape: v.cur.shape, cell: v.cur.cell ?? null, para: v.cur.para, start: v.cur.start};
        const r = replaceAll(doc, o, String(v.with ?? ''), at);
        if (r.count) {
          steps.push({command: 'text.replace', params: {...query(v), with: String(v.with ?? ''), at: v.cur}});
          const slides = doc.slides.map((sl, i) => (r.slides.has(i) ? {...sl, ...r.slides.get(i)} : sl));
          doc = {...doc, slides};
          v.next = Math.max((Number.isInteger(v.next) ? v.next : 1) - 1, 0);
        }
      }
      const shown = findNext(doc, v);
      if (shown) steps.push(...shown.batch);
      return steps.length ? {batch: steps} : refresh(v);
    },
    replaceAll(ctx, v) {
      if (!v.text) return null;
      const r = replaceAll(ctx.doc, findOpts(query(v), 'text.replace'), String(v.with ?? ''), null);
      v.cur = null;
      v.next = 0;
      if (!r.count) { v.status = cantFind(v.text); return refresh(v); }
      v.status = `Replaced ${r.count} occurrence(s).`;
      return {command: 'text.replace', params: {...query(v), with: String(v.with ?? '')}};
    },
    replaceMode(_ctx, v) {
      v.replace = true;
      return refresh(v);
    },
  },
  toCommand: v => ({command: 'text.find', params: query(v)}),
});
