// PivotTable Options dialog model (submit: pivot.options): the name and Enable show details, on gridcraft's cmd/pivot.rs `options`
// at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: name, enableShowDetails.

import {defineDialog} from '../../kernel/dialog.mjs';
import {findPivot} from '../commands/pivot.mjs';
import {baseDoc} from '../lib/data-common.mjs';

export default defineDialog({
  id: 'dialog.pivotTableOptions',
  title: 'PivotTable Options',
  command: 'pivot.options',
  init(ctx) {
    const [si, pi] = findPivot(ctx, {});
    const pt = baseDoc(ctx).sheets[si].pivots[pi];
    return {name: pt.name, enableShowDetails: pt.enableShowDetails !== false};
  },
  validate: v => (String(v.name ?? '').trim() ? [] : [{field: 'name', message: 'Enter a name for the PivotTable.'}]),
  toCommand: v => ({command: 'pivot.options', params: {name: String(v.name).trim(), enableShowDetails: v.enableShowDetails !== false}}),
});
