// Review › Language › Set Proofing Language…: Word's Language dialog — Mark selected text as (the
// language list), Do not check spelling or grammar, Detect language automatically, Set As Default.
// OK runs review.language for the selection; Set As Default makes it the document's default too.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/text.rs:329 (`language`
// dialog over review.language) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {Document} from '../model/document.mjs';
import {isQuill2} from '../model/content.mjs';
import * as P from '../model/para.mjs';
import {LANGUAGES, normalizeTag} from '../lib/review-proofing.mjs';

export function languageValues(ctx) {
  let lang = ctx.doc?.styles?.defaultChr?.lang ?? 'en-US', noProof = false;
  if (isQuill2(ctx.doc)) {
    try {
      const d = new Document(ctx.doc);
      const f = d.clamp(ctx.model.selection(ctx)[0].focus);
      const p = d.paraAt(f);
      const c = p ? P.propsAt(p, f.off) : {};
      lang = c.lang ?? lang;
      noProof = !!c.noProof;
    } catch { /* the defaults */ }
  }
  return {lang: normalizeTag(lang) ?? 'en-US', noProof, detect: ctx.prefs?.detectLanguage ?? true};
}

const params = v => ({lang: v.lang, noProof: !!v.noProof, detect: !!v.detect});

export default defineDialog({
  id: 'dialog.language',
  title: 'Language',
  command: 'review.language',
  init: ctx => languageValues(ctx),
  validate: v => (normalizeTag(v.lang) ? [] : [{field: 'lang', message: 'Choose a language.'}]),
  buttons: {'set-as-default': (_ctx, v) => ({command: 'review.language', params: {...params(v), default: true}})},
  toCommand: v => ({command: 'review.language', params: params(v)}),
});

export {LANGUAGES};
