// Mailings › Select Recipients › Use an Existing List… with a workbook of several sheets: Select Table,
// the sheets to choose from and whether the first row of data holds the column headers. The window
// asks for it (ui.openRecipientList) and reads the values back; nothing is run by OK itself.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`select_table_dialog`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Drawn by src/apps/quill/dialogs/selectTable.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.selectTable',
  title: 'Select Table',
  init: () => ({sheets: [], selected: 0, headers: true}),
  validate: () => [],
  toCommand: () => null,
});
