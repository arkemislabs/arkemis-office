// Paste Name (F3, Use in Formula › Paste Names…): OK or a double-click puts the selected name at
// the caret of the edit under way (or starts `=name`); Paste List writes every name and what it
// refers to from the active cell.
// Translated from gridcraft crates/ui-egui/src/dialogs/names.rs (`paste_name`, `insert_name`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fromKernelSelection} from '../model/workbook.mjs';
import {pasteableNames} from '../lib/formulas-names.mjs';

export default defineDialog({
  id: 'dialog.pasteName',
  title: 'Paste Name',
  command: 'formulas.pasteName',
  init(ctx) {
    const sel = fromKernelSelection(ctx.doc, ctx.selection);
    const items = pasteableNames(ctx.doc, sel.sheet).map(([n]) => n);
    return {name: items[0] ?? null, items};
  },
  validate: v => (typeof v.name === 'string' && v.name ? [] : [{field: 'name', message: 'There are no names to paste'}]),
  buttons: {
    'Paste List': (_ctx, v) => (Array.isArray(v.items) && v.items.length ? {command: 'formulas.pasteName', params: {list: true}} : null),
  },
  toCommand: v => ({command: 'formulas.pasteName', params: {name: String(v.name)}}),
});
