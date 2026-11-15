// Unprotect Sheet dialog model (submit: review.unprotectSheet): the password of a protected sheet.
// gridcraft's `unprotectSheet` form (crates/ui-egui/src/dialogs.rs): one password field. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Values: password (never written down: the command's
// `password` is a secret).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.unprotectSheet',
  title: 'Unprotect Sheet',
  command: 'review.unprotectSheet',
  init: () => ({password: ''}),
  validate: () => [],
  toCommand: v => ({command: 'review.unprotectSheet', params: {password: String(v.password ?? '')}}),
});
