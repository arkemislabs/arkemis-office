// Password required (submit: protect.open): a password-protected PDF asks for its open (or permissions)
// password in this dialog; a wrong one stays in the dialog with the message.
// Translated from printcraft crates/ui-egui/src/dialogs/prompts.rs (the password prompt) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The password is typed here, goes to the command as a secret param and is never stored.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'prompt.password',
  title: 'Password required',
  command: 'protect.open',
  init(ctx) { return {password: '', __name: ctx.doc?.sourceName ?? ''}; },
  validate: v => (v.password ? [] : [{field: 'password', message: 'Type the password'}]),
  toCommand: v => ({command: 'protect.open', params: {password: v.password}}),
});
