// Language (submit: format.language, or format.languageAll for the whole presentation): the
// language to mark the selected text (or every text) as, and Do not check spelling or grammar.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_language`,
// `selected_language`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {currentRun} from '../lib/format-text.mjs';
import {hasTextOrShapes} from '../lib/shape-common.mjs';

/** Starts from the selected text's language; with nothing selected, the whole presentation. */
export function languageValues(ctx) {
  const r = currentRun(ctx);
  const has = hasTextOrShapes(ctx).enabled;
  return {scope: has ? 'sel' : 'all', lang: r.lang ?? ctx.doc?.defaultTextStyle?.levels?.[0]?.run?.lang ?? ctx.prefs?.editingLanguage ?? 'en-US', noProof: r.noProof === true};
}

export default defineDialog({
  id: 'dialog.language',
  title: 'Language',
  command: 'format.language',
  init: ctx => languageValues(ctx),
  validate: v => (typeof v.lang === 'string' && /^[A-Za-z0-9-]{1,35}$/.test(v.lang) ? [] : [{field: 'lang', message: 'Choose a language'}]),
  toCommand: v => ({command: v.scope === 'all' ? 'format.languageAll' : 'format.language', params: {lang: v.lang, noProof: !!v.noProof}}),
});
