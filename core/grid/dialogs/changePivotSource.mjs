// Change PivotTable Data Source dialog model (submit: pivot.changeSource). Excel's Table/Range box over gridcraft's
// cmd/pivot/create.rs `change_source` at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: source.

import {defineDialog} from '../../kernel/dialog.mjs';
import {findPivot} from '../commands/pivot.mjs';
import {baseDoc} from '../lib/data-common.mjs';

export default defineDialog({
  id: 'dialog.changePivotSource',
  title: 'Change PivotTable Data Source',
  command: 'pivot.changeSource',
  init(ctx) {
    const [si, pi] = findPivot(ctx, {});
    return {source: baseDoc(ctx).sheets[si].pivots[pi].source};
  },
  validate: v => (String(v.source ?? '').trim() ? [] : [{field: 'source', message: "The PivotTable reference isn't valid. Enter a range or a table name."}]),
  toCommand: v => ({command: 'pivot.changeSource', params: {source: String(v.source).trim()}}),
});
