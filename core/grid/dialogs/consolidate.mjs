// Consolidate dialog model (submit: data.consolidate).
// Excel's Consolidate dialog (Function, Reference with Add and Delete, All references, Use labels in
// Top row / Left column) on gridcraft's cmd/whatif/consolidate.rs (`consolidate`: sources, function,
// topRow, leftColumn, destination = the selection's first cell) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: function, reference (the box), references (All references), selected, topRow, leftColumn, destination.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {selectionText} from '../lib/data-dialog.mjs';

export default defineDialog({
  id: 'dialog.consolidate',
  title: 'Consolidate',
  command: 'data.consolidate',
  init(ctx) {
    const sel = gridSel(ctx);
    return {function: 'sum', reference: selectionText(ctx).split(',')[0], references: [], selected: -1, topRow: false, leftColumn: false, destination: a1(sel.active.row, sel.active.col)};
  },
  validate(v) {
    const n = (v.references ?? []).length + (String(v.reference ?? '').trim() ? 1 : 0);
    return n ? [] : [{field: 'reference', message: 'Enter at least one reference to consolidate.'}];
  },
  toCommand(v) {
    const typed = String(v.reference ?? '').trim();
    const sources = [...(v.references ?? [])];
    if (typed && !sources.includes(typed)) sources.push(typed);
    return {command: 'data.consolidate', params: {sources, destination: v.destination, function: v.function ?? 'sum', topRow: v.topRow === true, leftColumn: v.leftColumn === true}};
  },
});
