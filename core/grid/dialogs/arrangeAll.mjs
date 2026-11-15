// Arrange Windows dialog model (View > Arrange All; submit: view.arrangeAll).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:234 (Tiled / Horizontal / Vertical / Cascade and
// "Windows of active workbook", defaults tiled and off) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.arrangeAll',
  title: 'Arrange Windows',
  command: 'view.arrangeAll',
  init: () => ({arrange: 'tiled', activeWorkbook: false}),
  validate: v => (['tiled', 'horizontal', 'vertical', 'cascade'].includes(v.arrange) ? [] : [{field: 'arrange', message: 'Choose how to arrange the windows.'}]),
  toCommand: v => ({command: 'view.arrangeAll', params: {arrange: v.arrange, activeWorkbook: v.activeWorkbook === true}}),
});
