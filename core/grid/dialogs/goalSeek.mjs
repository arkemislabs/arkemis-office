// Goal Seek dialog model (submit: data.goalSeek).
// Translated from gridcraft crates/ui-egui/src/dialogs/analysis.rs (Goal Seek: Set cell, To value,
// By changing cell) at 146161b4b450a56e5e59a083ba0478582d1e602b; after OK the surface shows Excel's
// Goal Seek Status. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1} from '../lib/addr.mjs';
import {parseNumberText} from '../lib/parse.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

export default defineDialog({
  id: 'dialog.goalSeek',
  title: 'Goal Seek',
  command: 'data.goalSeek',
  init(ctx) { const a = gridSel(ctx).active; return {set: a1(a.row, a.col), to: '', changing: ''}; },
  validate(v) {
    const out = [];
    if (!String(v.set ?? '').trim()) out.push({field: 'set', message: 'Reference is not valid.'});
    if (String(v.to ?? '').trim() === '' || parseNumberText(String(v.to)) === null) out.push({field: 'to', message: 'Enter the value to reach as a number.'});
    if (!String(v.changing ?? '').trim()) out.push({field: 'changing', message: 'Reference is not valid.'});
    return out;
  },
  toCommand: v => ({command: 'data.goalSeek', params: {set: String(v.set).trim(), to: parseNumberText(String(v.to)), changing: String(v.changing).trim()}}),
});
