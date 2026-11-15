// Set Password (Password Protection > Set Password...; submit: password.set). Two entries that must match.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';

export default defineDialog({
  id: 'dialog.password-set',
  title: 'Password Protection',
  command: 'password.set',
  init(ctx, args) { return {sectionId: args?.sectionId ?? currentLocation(ctx.doc, ctx.selection).sectionId, password: '', confirm: ''}; },
  validate(v) {
    const out = [];
    if (!v.password) out.push({field: 'password', message: 'Enter a password.'});
    if (v.confirm !== v.password) out.push({field: 'confirm', message: 'The passwords do not match.'});
    return out;
  },
  toCommand: v => ({command: 'password.set', params: {sectionId: v.sectionId, password: v.password}}),
});
