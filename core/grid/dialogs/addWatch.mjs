// Add Watch dialog model (Watch Window > Add Watch...; submit: formulas.watchWindow {add}): Excel's "Select the cells that you would like to
// watch the value of", filled with the selection. Over gridcraft's `watch_window` (cmd/extra/window.rs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: range.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {rangeA1} from '../lib/addr.mjs';
import {quoteSheet} from '../lib/addr.mjs';

export default defineDialog({
  id: 'dialog.addWatch',
  title: 'Add Watch',
  command: 'formulas.watchWindow',
  init(ctx) {
    const sel = gridSel(ctx);
    const area = sel.ranges[0] ?? {start: sel.active, end: sel.active};
    return {range: `${quoteSheet(baseDoc(ctx).sheets[sel.sheet].name)}!${rangeA1(area)}`};
  },
  validate: v => (String(v.range ?? '').trim() ? [] : [{field: 'range', message: 'Enter the cells to watch.'}]),
  toCommand: v => ({command: 'formulas.watchWindow', params: {add: String(v.range).trim(), on: true}}),
});
