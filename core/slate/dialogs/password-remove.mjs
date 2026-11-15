// Remove Password (Password Protection > Remove Password...; submit: password.remove).
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';

export default defineDialog({
  id: 'dialog.password-remove',
  title: 'Remove Password',
  command: 'password.remove',
  init(ctx, args) { return {sectionId: args?.sectionId ?? currentLocation(ctx.doc, ctx.selection).sectionId, password: ''}; },
  validate: v => (v.password ? [] : [{field: 'password', message: 'Enter the password.'}]),
  toCommand: v => ({command: 'password.remove', params: {sectionId: v.sectionId, password: v.password}}),
});
