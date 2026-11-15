// Change Password (Password Protection > Change Password...; submit: password.change).
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';

export default defineDialog({
  id: 'dialog.password-change',
  title: 'Change Password',
  command: 'password.change',
  init(ctx, args) { return {sectionId: args?.sectionId ?? currentLocation(ctx.doc, ctx.selection).sectionId, oldPassword: '', newPassword: '', confirm: ''}; },
  validate(v) {
    const out = [];
    if (!v.oldPassword) out.push({field: 'oldPassword', message: 'Enter the old password.'});
    if (!v.newPassword) out.push({field: 'newPassword', message: 'Enter a new password.'});
    if (v.confirm !== v.newPassword) out.push({field: 'confirm', message: 'The passwords do not match.'});
    return out;
  },
  toCommand: v => ({command: 'password.change', params: {sectionId: v.sectionId, oldPassword: v.oldPassword, newPassword: v.newPassword}}),
});
