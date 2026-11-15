// Rename Sheet dialog model (Home › Cells › Format › Rename Sheet; submit: sheet.rename {sheet, name}).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:281 (Name:) with the sheet-name rules of
// crates/model/src/workbook.rs `check_sheet_name` at 146161b4b450a56e5e59a083ba0478582d1e602b.
// Excel renames in place on the tab (the surface does too); this is the ribbon's path.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {checkSheetName} from '../model/sheet.mjs';

export default defineDialog({
  id: 'dialog.renameSheet',
  title: 'Rename Sheet',
  command: 'sheet.rename',
  init(ctx) {
    const si = gridSel(ctx).sheet;
    const sh = ctx.doc.sheets[si];
    return {name: sh.name, sheet: `/sh:${encodeURIComponent(sh.id)}`, others: ctx.doc.sheets.filter((_, i) => i !== si).map(x => x.name)};
  },
  validate(v) {
    const err = checkSheetName({sheets: (v.others ?? []).map(name => ({name}))}, String(v.name ?? '').trim());
    return err ? [{field: 'name', message: err}] : [];
  },
  toCommand: v => ({command: 'sheet.rename', params: {sheet: v.sheet, name: String(v.name).trim()}}),
});
