// Column Width dialog model (Home › Cells › Format › Column Width…; submit: home.columnWidth {chars}).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:267 (Column Width, in characters of the
// default font's digits) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {colWidth, pointsToChars} from '../model/sheet.mjs';

export default defineDialog({
  id: 'dialog.columnWidth',
  title: 'Column Width',
  command: 'home.columnWidth',
  init(ctx) {
    const sel = gridSel(ctx);
    return {chars: pointsToChars(colWidth(ctx.doc.sheets[sel.sheet], sel.active.col))};
  },
  validate(v) {
    const n = Number(v.chars);
    if (v.chars === null || v.chars === '' || !Number.isFinite(n)) return [{field: 'chars', message: 'Enter a column width in characters.'}];
    if (n < 0 || n > 255) return [{field: 'chars', message: 'Column width must be between 0 and 255 characters.'}];
    return [];
  },
  toCommand: v => ({command: 'home.columnWidth', params: {chars: Number(v.chars)}}),
});
