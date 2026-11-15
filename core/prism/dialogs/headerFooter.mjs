// Header and Footer (submit: design.headerFooter): the Slide page: Date and time (Update automatically
// with a format, or Fixed), Slide number, Footer and its text, Don't show on title slide. Apply to All
// puts them on every slide, Apply to Slide on the current one.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_header_footer`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Not translated: Language, Calendar type and the Notes and Handouts page (deckcraft
// edits those placeholders on the Notes and Handout masters).

import {defineDialog} from '../../kernel/dialog.mjs';
import {DATE_KINDS} from '../lib/insert-datetime.mjs';
import {defaultHeaderFooter} from '../model/presentation.mjs';
import {notesHandoutsState} from '../commands/master.mjs';

/** The Notes and Handouts page, sent only once a field on it has changed. */
const notesCall = v => ({command: 'design.notesHeaderFooter', params: {
  date: !!v.nDate, ...(v.nDate ? (v.nDateMode === 'fixed' ? {dateText: String(v.nDateText ?? '')} : {dateText: '', dateFormat: v.nDateFormat || 'datetime1'}) : {}),
  header: !!v.nHeader, headerText: String(v.nHeaderText ?? ''), pageNumber: !!v.nPage, footer: !!v.nFooter, footerText: String(v.nFooterText ?? ''),
}});
const call = (v, all) => ({command: 'design.headerFooter', params: {
  date: !!v.date, dateText: v.dateMode === 'fixed' ? String(v.dateText ?? '') : '', ...(v.dateFormat ? {dateFormat: v.dateFormat} : {}),
  slideNumber: !!v.num, footer: !!v.footer, footerText: String(v.footerText ?? ''), hideOnTitle: !!v.hide, all,
}});

const notesInit = ctx => {
  const n = notesHandoutsState(ctx.doc ?? {});
  return {nDate: n.date, nDateMode: n.dateFixed ? 'fixed' : 'auto', nDateFormat: n.dateFormat, nDateText: n.dateText, nHeader: n.header, nHeaderText: n.headerText, nPage: n.pageNumber, nFooter: n.footer, nFooterText: n.footerText};
};

const withNotes = (main, v, close) => (v.nTouched ? {batch: [main, notesCall(v)], ...(close ? {close: true} : {})} : close ? {...main, close: true} : main);

export default defineDialog({
  id: 'dialog.headerFooter',
  title: 'Header and Footer',
  command: 'design.headerFooter',
  init(ctx) {
    const hf = {...defaultHeaderFooter(), ...(ctx.doc?.headerFooter ?? {})};
    return {date: !!hf.date, dateMode: hf.dateText ? 'fixed' : 'auto', dateText: hf.dateText ?? '', dateFormat: hf.dateFormat || 'datetime1', num: !!hf.slideNumber,
      footer: !!hf.footer, footerText: hf.footerText ?? '', hide: !!hf.hideOnTitle, ...notesInit(ctx), nTouched: false};
  },
  // Any change on the Notes and Handouts page marks it to be applied.
  derive: (_v, changed) => (changed.some(k => /^n[A-Z]/.test(k) && k !== 'nTouched') ? {nTouched: true} : {}),
  // The small slide beside the fields: where the date, footer and number go and what they say.
  preview: (_ctx, v) => ({date: !!v.date, dateText: v.dateMode === 'fixed' ? String(v.dateText ?? '') : '', num: !!v.num, footer: !!v.footer, footerText: String(v.footerText ?? ''), hide: !!v.hide}),
  validate(v) {
    const out = [];
    if (!DATE_KINDS.includes(v.dateFormat)) out.push({field: 'dateFormat', message: 'Choose a date format'});
    if (v.date && v.dateMode === 'fixed' && !String(v.dateText ?? '').trim()) out.push({field: 'dateText', message: 'Type the fixed date'});
    return out;
  },
  buttons: {'apply-to-slide': (_ctx, v) => withNotes(call(v, false), v, true)},
  toCommand: v => withNotes(call(v, true), v, false),
});
