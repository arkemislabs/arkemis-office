// Rename Document dialog model (submit: file.rename).
// Upstream: wordcraft crates/ui-egui/src/dialogs/dispatch.rs (renameDocument: one name field).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.renameDocument',
  title: 'Rename Document',
  command: 'file.rename',
  init: ctx => ({name: ctx.file?.title ?? ''}),
  validate(values) {
    const name = String(values.name ?? '').trim();
    if (!name) return [{field: 'name', message: 'Enter a name'}];
    if (name.length > 200) return [{field: 'name', message: 'Use at most 200 characters'}];
    return [];
  },
  toCommand: values => ({command: 'file.rename', params: {name: String(values.name).trim()}}),
});
