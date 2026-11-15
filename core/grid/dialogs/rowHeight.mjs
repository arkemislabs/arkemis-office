// Row Height dialog model (Home › Cells › Format › Row Height…; submit: home.rowHeight {points}).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:260 (Row Height, in points, opening with
// the active row's height selected for typing) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {rowHeight} from '../model/sheet.mjs';

export default defineDialog({
  id: 'dialog.rowHeight',
  title: 'Row Height',
  command: 'home.rowHeight',
  init(ctx) {
    const sel = gridSel(ctx);
    return {points: Math.round(rowHeight(ctx.doc.sheets[sel.sheet], sel.active.row) * 0.75 * 100) / 100};
  },
  validate(v) {
    const n = Number(v.points);
    if (v.points === null || v.points === '' || !Number.isFinite(n)) return [{field: 'points', message: 'Enter a row height in points.'}];
    if (n < 0 || n > 409.5) return [{field: 'points', message: 'Row height must be between 0 and 409.5 points.'}];
    return [];
  },
  toCommand: v => ({command: 'home.rowHeight', params: {points: Number(v.points)}}),
});
