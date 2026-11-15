// Insert › Text › Date & Time (submit: insert.dateTime).
// Word's Date and Time dialog (office source): Available formats (today's date and time in each of
// Word's English (United States) pictures), Language, Update automatically (inserts a DATE field
// instead of text), Set As Default. wordcraft crates/engine/src/cmd/insert.rs `insert.dateTime`
// {format, update} and insert/items.rs `format_date` (aadb077e072b7de05f724e359d8db82e151f125c) do
// the inserting; the pictures are crates/ui-egui/src/dialogs/dialogs_insert/field.rs DATE_FORMATS.
// Only English (United States) is offered: upstream's date pictures have English month and day
// names only. Set As Default is not offered (no upstream command keeps a default picture).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {formatDate} from '../commands/insert.mjs';
import {DATE_FORMATS} from './field.mjs';

/** Word's list (English (United States)), in its order. */
export const WORD_DATE_FORMATS = DATE_FORMATS;

export default defineDialog({
  id: 'dialog.dateTime',
  title: 'Date and Time',
  command: 'insert.dateTime',
  init(ctx) {
    const now = ctx.host?.now?.() ?? Date.now();
    const kept = ctx.prefs?.dateTimeFormat;
    const formats = WORD_DATE_FORMATS.map(f => ({value: f, label: formatDate(f, now)}));
    return {formats: WORD_DATE_FORMATS.includes(kept) ? kept : WORD_DATE_FORMATS[0], language: 'en-US', updateAuto: false, formatOptions: formats};
  },
  validate(v) { return v.formats ? [] : [{field: 'formats', message: 'Choose a format.'}]; },
  toCommand(v) {
    return {command: 'insert.dateTime', params: {format: v.formats, update: !!v.updateAuto}};
  },
});
