// Remove hidden information (submit: protect.remove_hidden): the categories to remove, checked by default.
// Translated from printcraft crates/ui-egui/src/tools/redact_ui.rs (HiddenDraft, hidden_body) and
// crates/redact/src/sanitize.rs (Hidden) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Counts of what each category holds are not shown in
// the dialog (a dialog model reads the document without waiting); the result says what was removed.

import {defineDialog} from '../../kernel/dialog.mjs';
import {HIDDEN} from '../lib/redact.mjs';

export default defineDialog({
  id: 'dialog.remove-hidden',
  title: 'Remove hidden information',
  command: 'protect.remove_hidden',
  init: () => ({...Object.fromEntries(HIDDEN.map(h => [h.id, true])), note: 'Form fields are flattened: their values stay visible. Saving rewrites the whole file.'}),
  validate: v => (HIDDEN.some(h => v[h.id]) ? [] : [{field: 'metadata', message: 'Select at least one item to remove'}]),
  toCommand: v => ({command: 'protect.remove_hidden', params: {items: HIDDEN.filter(h => v[h.id]).map(h => h.id)}}),
});
