// Rename View dialog model (View > Sheet View > Options > Rename…; submit: view.sheetViewOptions {action: rename}). Not in gridcraft
// (not checked against upstream). Values: name.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

export default defineDialog({
  id: 'dialog.renameSheetView',
  title: 'Rename View',
  command: 'view.sheetViewOptions',
  init(ctx) {
    const sheet = ctx.doc.sheets[gridSel(ctx).sheet];
    return {name: ctx.view?.sheetViewActive?.[sheet.id] ?? ''};
  },
  validate: v => (String(v.name ?? '').trim() ? [] : [{field: 'name', message: 'Type a name for the view.'}]),
  toCommand: v => ({command: 'view.sheetViewOptions', params: {action: 'rename', name: String(v.name).trim()}}),
});
