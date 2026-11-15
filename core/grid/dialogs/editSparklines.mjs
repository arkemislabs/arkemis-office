// Edit Sparklines dialog model (Sparkline > Edit Data; submit: sparkline.edit).
// Excel's Edit Sparklines (Data Range, Location Range) over gridcraft's single sparkline
// ({cell, source}; crates/ui-egui/src/dialogs.rs `sparkline`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: at (the cell it was opened for), range, location.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1, parseCell, parseRange} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

const plain = v => String(v ?? '').replace(/\$/g, '').trim();

export default defineDialog({
  id: 'dialog.editSparklines',
  title: 'Edit Sparklines',
  command: 'sparkline.edit',
  init(ctx) {
    const sel = gridSel(ctx);
    const here = a1(sel.active.row, sel.active.col);
    const sp = (ctx.doc.sheets[sel.sheet].sparklines ?? []).find(x => String(x.cell).replace(/\$/g, '') === here);
    return {at: here, range: sp?.source ?? '', location: here};
  },
  validate(v) {
    const out = [];
    if (!parseRange(plain(v.range).replace(/^.*!/, ''))) out.push({field: 'range', message: 'Enter the data range, for example B2:M2.'});
    if (!parseCell(plain(v.location).replace(/^.*!/, ''))) out.push({field: 'location', message: 'Enter the cell for the sparkline, for example N2.'});
    return out;
  },
  toCommand: v => ({command: 'sparkline.edit', params: {location: v.at, range: plain(v.range), ...(plain(v.location).replace(/^.*!/, '') !== v.at ? {newLocation: plain(v.location)} : {})}}),
});
