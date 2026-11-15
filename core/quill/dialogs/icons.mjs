// Insert › Illustrations › Icons: the icon picker (wordcraft crates/ui-egui/src/dialogs/bookmarks.rs `icons_body`): a search box,
// the categories (All and the library's) and a grid of the icons drawn in the ink, with the selected icon's name under it and Insert.
// Double-clicking an icon inserts it. OK runs insert.icon with the selected `id`. Drawn by src/apps/quill/dialogs/icons.tsx.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {findIcon} from '../lib/icon-lib.mjs';

export default defineDialog({
  id: 'dialog.icons',
  title: 'Icons',
  command: 'insert.icon',
  init: () => ({query: '', category: '', selected: ''}),
  validate: v => (findIcon(v.selected) ? [] : [{field: 'selected', message: 'Choose an icon.'}]),
  toCommand: v => ({command: 'insert.icon', params: {id: String(v.selected)}}),
});
