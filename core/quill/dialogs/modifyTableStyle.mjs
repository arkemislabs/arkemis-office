// Table Design › Table Styles › Modify Table Style… (submit: table.modifyStyle).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_table_style.rs (`open` for
// `modifyTableStyle`: the caret table's style, its name and base, its parts as they resolve; none
// when the table has no table style; OK sends only what changed) at
// aadb077e072b7de05f724e359d8db82e151f125c. Upstream opens one dialog under two names; the spec's
// dialog.tableStyle is the New one, this is the Modify one (same form, core/quill/lib/table_style-form.mjs).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {deriveForm, formCommand, openForm, validateForm} from '../lib/table_style-form.mjs';

export default defineDialog({
  id: 'dialog.modifyTableStyle',
  title: 'Modify Style',
  command: 'table.modifyStyle',
  init: ctx => openForm(ctx, 'modify'),
  derive: (v, changed) => deriveForm(v, changed),
  validate: validateForm,
  toCommand: formCommand,
});
