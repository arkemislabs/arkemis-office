// Create Sparklines dialog model (submit: insert.sparkline).
// Excel's Create Sparklines (Data Range, Location Range) with gridcraft's Markers box
// (crates/ui-egui/src/dialogs.rs `sparkline`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. The type (line, column, winLoss) is
// the opening menu item's argument.
//
// Values: range, location, markers.

import {defineDialog} from '../../kernel/dialog.mjs';
import {parseRange} from '../lib/addr.mjs';
import {selectionText} from '../lib/data-dialog.mjs';

export default defineDialog({
  id: 'dialog.sparkline',
  title: 'Create Sparklines',
  command: 'insert.sparkline',
  init: ctx => ({range: selectionText(ctx).split(',')[0], location: '', markers: false}),
  validate(v) {
    const out = [];
    if (!parseRange(String(v.range ?? '').replace(/\$/g, '').replace(/^.*!/, ''))) out.push({field: 'range', message: 'Enter the data range, for example B2:M2.'});
    if (!parseRange(String(v.location ?? '').replace(/\$/g, '').replace(/^.*!/, ''))) out.push({field: 'location', message: 'Enter the cell for the sparkline, for example N2.'});
    return out;
  },
  toCommand: v => ({command: 'insert.sparkline', params: {range: String(v.range).replace(/\$/g, ''), location: String(v.location).replace(/\$/g, ''), markers: v.markers === true}}),
});
