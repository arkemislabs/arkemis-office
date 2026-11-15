// Protected Section (the locked section's placeholder > Enter Password; submit: password.unlock).
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';

export default defineDialog({
  id: 'dialog.password-unlock',
  title: 'Protected Section',
  command: 'password.unlock',
  init(ctx, args) { return {sectionId: args?.sectionId ?? currentLocation(ctx.doc, ctx.selection).sectionId, password: ''}; },
  validate: v => (v.password ? [] : [{field: 'password', message: 'Enter the password.'}]),
  toCommand: v => ({command: 'password.unlock', params: {sectionId: v.sectionId, password: v.password}}),
});
