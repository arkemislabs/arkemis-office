// Confirm Password dialog model (Excel's second Protect Sheet / Protect Workbook box: "Reenter password to proceed"). The
// protection command, asked with a password and `askConfirm`, opens it with the command and its parameters; OK runs the command
// again with `confirmPassword`, and a different one is refused. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: command, params (the command's other parameters), expected (the password to match), confirm (what is typed). The
// password is never written down: the command's `password` and `confirmPassword` are secrets.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.confirmPassword',
  title: 'Confirm Password',
  command: 'review.protectSheet',
  init: () => ({command: 'review.protectSheet', params: {}, expected: '', confirm: ''}),
  validate: v => (String(v.confirm ?? '') === String(v.expected ?? '') ? [] : [{field: 'confirm', message: 'Confirmation password is not identical to the password.'}]),
  toCommand: v => ({command: String(v.command), params: {...(v.params ?? {}), password: String(v.expected ?? ''), confirmPassword: String(v.confirm ?? '')}}),
});
