// Rename Layout (submit: master.renameLayout): the name of the open layout.
// Translated from deckcraft crates/ui-egui/src/dialogs/body.rs (`dlg_rename_layout`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.renameLayout',
  title: 'Rename Layout',
  command: 'master.renameLayout',
  init(ctx) {
    const m = ctx.view?.master;
    const layout = m?.kind === 'slide' && m.layout !== null && m.layout !== undefined ? ctx.doc?.masters?.[m.master]?.layouts?.[m.layout] : null;
    return {name: layout?.name ?? ''};
  },
  validate: v => (String(v.name ?? '').trim() ? [] : [{field: 'name', message: 'Give the layout a name'}]),
  toCommand: v => ({command: 'master.renameLayout', params: {name: String(v.name).trim()}}),
});
