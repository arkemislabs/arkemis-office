// Grouping dialog model (submit: pivot.group): how a date field of the PivotTable is grouped, on gridcraft's cmd/pivot/fields.rs `group`
// (years, quarters, months, days) at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: by.

import {defineDialog} from '../../kernel/dialog.mjs';
import {findPivot, activeField} from '../commands/pivot.mjs';
import {baseDoc} from '../lib/data-common.mjs';

export default defineDialog({
  id: 'dialog.pivotGrouping',
  title: 'Grouping',
  command: 'pivot.group',
  init(ctx) {
    const [si, pi] = findPivot(ctx, {});
    const af = activeField(ctx, {});
    const pt = baseDoc(ctx).sheets[si].pivots[pi];
    const cur = af && (af.area === 'rows' || af.area === 'columns') ? pt[af.area][af.index]?.dateGroup : null;
    return {by: cur && cur !== 'none' ? cur : 'months'};
  },
  validate: () => [],
  toCommand: v => ({command: 'pivot.group', params: {by: String(v.by ?? 'months')}}),
});
