// Mailings › Write & Insert Fields › Insert Merge Field: the recipient list's fields to choose from
// and a Field box (the name may be typed); Insert runs mailings.insertField.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`insert_merge_field_dialog`) and
// dialogs.rs (`insertMergeField`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Drawn by src/apps/quill/dialogs/insertMergeField.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {mergeOf} from '../lib/mailings-merge.mjs';

export default defineDialog({
  id: 'dialog.insertMergeField',
  title: 'Insert Merge Field',
  command: 'mailings.insertField',
  init(ctx) {
    const fields = mergeOf(ctx).headers;
    return {fields, field: fields[0] ?? ''};
  },
  validate: v => (String(v.field ?? '').trim() ? [] : [{field: 'field', message: 'Choose a field.'}]),
  toCommand: v => ({command: 'mailings.insertField', params: {field: String(v.field).trim()}}),
});
