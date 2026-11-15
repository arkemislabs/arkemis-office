// Outline Settings dialog model (submit: data.outlineSettings): where summary rows and columns sit.
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (Settings: Summary rows below detail,
// Summary columns to right of detail) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

export default defineDialog({
  id: 'dialog.outlineSettings',
  title: 'Settings',
  command: 'data.outlineSettings',
  init(ctx) {
    const sheet = ctx.doc.sheets[gridSel(ctx).sheet];
    return {summaryBelow: sheet?.summaryBelow !== false, summaryRight: sheet?.summaryRight !== false};
  },
  validate: () => [],
  toCommand: v => ({command: 'data.outlineSettings', params: {summaryBelow: v.summaryBelow !== false, summaryRight: v.summaryRight !== false}}),
});
