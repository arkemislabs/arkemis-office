// Move or Copy dialog model (Home › Cells › Format › Move or Copy Sheet…; submit: sheet.move).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:288 (position, Create a copy) and laid out
// as Excel's dialog: "Before sheet:" lists the workbook's sheets and "(move to end)". "To book:"
// offers this workbook only (moving a sheet into another open workbook is not translated).
// At 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

export const MOVE_TO_END = '(move to end)';

export default defineDialog({
  id: 'dialog.moveSheet',
  title: 'Move or Copy',
  command: 'sheet.move',
  init(ctx) {
    const si = gridSel(ctx).sheet;
    const sh = ctx.doc.sheets[si];
    const list = ctx.doc.sheets.map(x => x.name);
    return {sheet: `/sh:${encodeURIComponent(sh.id)}`, current: si, sheets: list, toBook: 'this', beforeSheet: list[si + 1] ?? MOVE_TO_END, copy: false, to: si};
  },
  derive(v, changed) {
    if (!changed.includes('beforeSheet')) return {};
    const i = (v.sheets ?? []).indexOf(v.beforeSheet);
    return {to: i < 0 ? (v.sheets ?? []).length : i};
  },
  validate: v => ((v.sheets ?? []).includes(v.beforeSheet) || v.beforeSheet === MOVE_TO_END ? [] : [{field: 'beforeSheet', message: 'Choose where to put the sheet.'}]),
  toCommand(v) {
    const n = (v.sheets ?? []).length;
    const before = v.beforeSheet === MOVE_TO_END ? n : (v.sheets ?? []).indexOf(v.beforeSheet);
    // sheet.move takes the final position: a sheet moved right past itself lands one earlier.
    const to = v.copy ? before : before > v.current ? before - 1 : before;
    return {command: 'sheet.move', params: {sheet: v.sheet, to: Math.max(0, to), ...(v.copy ? {copy: true} : {})}};
  },
});
