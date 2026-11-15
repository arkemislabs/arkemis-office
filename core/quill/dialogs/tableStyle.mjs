// Table Design › Table Styles › New Table Style… (submit: table.newStyle).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_table_style.rs (`open` for
// `newTableStyle`: based on the caret table's style (else Table Grid), named "Table Style n", the
// parts read from its base; OK sends only what changed) at aadb077e072b7de05f724e359d8db82e151f125c;
// the form itself is core/quill/lib/table_style-form.mjs. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {deriveForm, formCommand, openForm, validateForm} from '../lib/table_style-form.mjs';

export default defineDialog({
  id: 'dialog.tableStyle',
  title: 'Create New Style from Formatting',
  command: 'table.newStyle',
  init: ctx => openForm(ctx, 'new'),
  derive: (v, changed) => deriveForm(v, changed),
  validate: validateForm,
  toCommand: formCommand,
});
