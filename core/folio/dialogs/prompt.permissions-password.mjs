// Permissions password (submit: protect.unlock): lifts the limits of a document opened with its open
// password. Translated from printcraft crates/ui-egui/src/dialogs/prompts.rs (request_unlock) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Opened by Remove security and Protect when the document is restricted: then the dialog's values go back
// to that command (host.openDialog), otherwise Unlock runs protect.unlock.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'prompt.permissions-password',
  title: 'Permissions password',
  command: 'protect.unlock',
  init() { return {password: ''}; },
  validate: v => (v.password ? [] : [{field: 'password', message: 'Type the permissions password'}]),
  toCommand: v => ({command: 'protect.unlock', params: {password: v.password}}),
});
