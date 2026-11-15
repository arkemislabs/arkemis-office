// Advanced Filter dialog model (submit: data.advancedFilter).
// Translated from gridcraft crates/ui-egui/src/dialogs/data.rs (`advanced_filter_form`: Action in
// place or copy, List range, Criteria range, Copy to, Unique records only) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {regionInfo} from '../lib/data-dialog.mjs';

export default defineDialog({
  id: 'dialog.advancedFilter',
  title: 'Advanced Filter',
  command: 'data.advancedFilter',
  init(ctx) { return {action: 'inPlace', range: regionInfo(ctx).a1, criteria: '', copyTo: '', unique: false}; },
  validate(v) {
    const out = [];
    if (!String(v.range ?? '').trim()) out.push({field: 'range', message: 'Enter the list range.'});
    if (v.action === 'copy' && !String(v.copyTo ?? '').trim()) out.push({field: 'copyTo', message: 'Enter where to copy the matching rows.'});
    return out;
  },
  toCommand(v) {
    const p = {range: String(v.range).trim(), unique: v.unique === true};
    if (String(v.criteria ?? '').trim()) p.criteria = String(v.criteria).trim();
    if (v.action === 'copy') p.copyTo = String(v.copyTo).trim();
    return {command: 'data.advancedFilter', params: p};
  },
});
