// Value Field Settings dialog model (submit: pivot.valueSettings): Custom Name, Summarize Values By, Show Values As and Number Format
// of one value field (the one under the active cell, else the first), on gridcraft's cmd/pivot/fields.rs `value_settings` at fb1e59f.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: index (which value field), source (its source field), name, func, showAs, numberFormat, baseField (the first row field, shown).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findPivot, activeField} from '../commands/pivot.mjs';
import {baseDoc, failed} from '../lib/data-common.mjs';

export default defineDialog({
  id: 'dialog.valueFieldSettings',
  title: 'Value Field Settings',
  command: 'pivot.valueSettings',
  init(ctx, args) {
    const [si, pi] = findPivot(ctx, {});
    const pt = baseDoc(ctx).sheets[si].pivots[pi];
    if (!pt.values.length) throw failed('Add a field to the Values area first.');
    const af = activeField(ctx, {});
    const index = Number.isInteger(args?.index) ? args.index : af?.area === 'values' ? af.index : 0;
    const v = pt.values[index];
    return {index, source: v.sourceCol, name: v.name, func: v.func, showAs: v.showAs ?? 'normal', numberFormat: v.numberFormat ?? '', baseField: pt.rows[0]?.sourceCol ?? ''};
  },
  validate: v => (String(v.name ?? '').trim() ? [] : [{field: 'name', message: "The name isn't valid."}]),
  toCommand: v => ({command: 'pivot.valueSettings', params: {index: Number(v.index), name: String(v.name).trim(), func: String(v.func), showAs: String(v.showAs), numberFormat: String(v.numberFormat ?? '') || null}}),
});
