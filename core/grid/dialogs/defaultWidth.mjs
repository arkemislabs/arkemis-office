// Standard Width dialog model (Home > Cells > Format > Default Width…; submit: home.defaultWidth).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:274 (Standard Width) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's unit: the box takes characters of the default font's digits
// (8.43 for the 64 px that is the default), the command keeps pixels. The field is still called `width`.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {defaultColWidth, pointsToChars, charsToPixels} from '../model/sheet.mjs';

export default defineDialog({
  id: 'dialog.defaultWidth',
  title: 'Standard Width',
  command: 'home.defaultWidth',
  init: ctx => ({width: pointsToChars(defaultColWidth(ctx.doc.sheets[gridSel(ctx).sheet]))}),
  validate(v) {
    const n = Number(v.width);
    if (v.width === null || v.width === '' || !Number.isFinite(n) || n < 0 || n > 255) return [{field: 'width', message: 'Standard width must be between 0 and 255 characters.'}];
    return [];
  },
  toCommand: v => ({command: 'home.defaultWidth', params: {width: charsToPixels(Number(v.width))}}),
});
