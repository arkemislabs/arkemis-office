// Date and Time (submit: insert.dateTime): Available formats (today's date and time in each of
// `datetime1`…`datetime13`, in the chosen language; formats with names exist only in English),
// Language, Update automatically.
// Translated from deckcraft crates/ui-egui/src/dialogs/date_time.rs and crates/text/src/datetime.rs
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// PowerPoint's Calendar type and Set As Default are not offered (deckcraft keeps no default format).

import {defineDialog} from '../../kernel/dialog.mjs';
import {DATE_KINDS, fieldText, fromMillis} from '../lib/insert-datetime.mjs';

export const LANGUAGES = Object.freeze([
  {value: 'en-US', label: 'English (United States)'}, {value: 'en-GB', label: 'English (United Kingdom)'}, {value: 'fr-FR', label: 'French (France)'},
  {value: 'ja-JP', label: 'Japanese'}, {value: 'sv-SE', label: 'Swedish'},
]);

/** The formats the list shows for `lang` at `now`: each with today's text as its label (ones a language can't write are left out). */
export function formatOptions(lang, now) {
  return DATE_KINDS.map(k => ({value: k, label: fieldText(k, lang, now)})).filter(o => o.label !== null);
}

export default defineDialog({
  id: 'dialog.dateTime',
  title: 'Date and Time',
  command: 'insert.dateTime',
  init(ctx) {
    const now = fromMillis(ctx.host?.now?.() ?? Date.now());
    return {format: 'datetime1', language: 'en-US', update: true, formatOptions: formatOptions('en-US', now)};
  },
  derive(v, changed) {
    if (!changed.includes('language')) return {};
    const opts = formatOptions(v.language, fromMillis(Date.now()));
    return {formatOptions: opts, format: opts.some(o => o.value === v.format) ? v.format : opts[0]?.value ?? 'datetime1'};
  },
  validate(v) {
    const out = [];
    if (!DATE_KINDS.includes(v.format)) out.push({field: 'format', message: 'Choose a format.'});
    if (!LANGUAGES.some(l => l.value === v.language)) out.push({field: 'language', message: 'Choose a language.'});
    return out;
  },
  toCommand(v) { return {command: 'insert.dateTime', params: {format: v.format, update: !!v.update, language: v.language}}; },
});
