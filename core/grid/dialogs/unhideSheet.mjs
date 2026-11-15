// Unhide dialog model (Home › Cells › Format › Hide & Unhide › Unhide Sheet…; submit: sheet.unhide).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:406 (the hidden sheets) and laid out as
// Excel's list of hidden sheets, at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.unhideSheet',
  title: 'Unhide',
  command: 'sheet.unhide',
  init(ctx) {
    const hidden = ctx.doc.sheets.filter(x => x.hidden && x.hidden !== 'veryHidden').map(x => x.name);
    return {hiddenSheets: hidden, sheet: hidden[0] ?? null};
  },
  validate: v => ((v.hiddenSheets ?? []).includes(v.sheet) ? [] : [{field: 'sheet', message: 'Choose a sheet to unhide.'}]),
  toCommand: v => ({command: 'sheet.unhide', params: {sheet: v.sheet}}),
});
