// Unlock a file of the Combine files list (submit: combine.unlock): its password, with Show password.
// Translated from printcraft crates/ui-egui/src/workflows/combine_ui/view.rs (the unlock prompt) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The password is a secret param, kept in memory only and never logged.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.combine-unlock',
  title: 'Unlock file',
  titleFor: v => (v.__name ? `Unlock ${v.__name}` : 'Unlock file'),
  command: 'combine.unlock',
  init(ctx) {
    const tab = ctx.view?.combine ?? {files: [], selected: []};
    const locked = (tab.files ?? []).filter(f => ['password', 'wrong-password', 'not-permitted'].includes(f.problem));
    const f = locked.find(x => (tab.selected ?? []).includes(x.id)) ?? locked[0];
    return {password: '', show: false, __id: f?.id ?? null, __name: f?.name ?? '', __title: f?.name ? `Unlock ${f.name}` : 'Unlock file'};
  },
  validate: v => (v.password ? [] : [{field: 'password', message: 'Type the password'}]),
  toCommand: v => ({command: 'combine.unlock', params: {...(v.__id ? {id: v.__id} : {}), password: v.password}}),
});
