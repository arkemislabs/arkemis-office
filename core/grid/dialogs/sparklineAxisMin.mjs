// Custom Axis Value dialog model (Sparkline > Axis > Vertical Axis Minimum Value Options > Custom Value; submit: sparkline.axis).
// Excel's Sparkline Vertical Axis Settings: the value the axis starts at for the sparkline in the active cell and its group.
// Not in gridcraft (its sparklines scale to their own data): built from Excel's x14 manualMin and manualMax, not checked against upstream.
//
// Values: value.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

export default defineDialog({
  id: 'dialog.sparklineAxisMin',
  title: 'Sparkline Vertical Axis Settings',
  command: 'sparkline.axis',
  init(ctx) {
    const sel = gridSel(ctx);
    const here = a1(sel.active.row, sel.active.col);
    const sp = (ctx.doc.sheets[sel.sheet].sparklines ?? []).find(x => String(x.cell).replace(/\$/g, '') === here);
    return {value: typeof sp?.axis?.min === 'number' ? String(sp.axis.min) : ''};
  },
  validate: v => (Number.isFinite(Number(String(v.value ?? '').trim())) && String(v.value ?? '').trim() !== '' ? [] : [{field: 'value', message: 'Enter a number.'}]),
  toCommand: v => ({command: 'sparkline.axis', params: {minType: 'custom', min: Number(String(v.value).trim())}}),
});
