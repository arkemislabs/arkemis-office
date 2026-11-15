// Insert Paste dialog model (Insert Copied Cells over a block; submit: home.insertCopiedCells {shift}).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:242 (Shift cells right / Shift cells down)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.insertPaste',
  title: 'Insert Paste',
  command: 'home.insertCopiedCells',
  init: () => ({shift: 'down'}),
  validate: v => (v.shift === 'right' || v.shift === 'down' ? [] : [{field: 'shift', message: 'Choose how to insert.'}]),
  toCommand: v => ({command: 'home.insertCopiedCells', params: {shift: v.shift}}),
});
