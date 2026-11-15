// Move PivotTable dialog model (PivotTable Analyze > Actions > Move PivotTable; submit: pivot.move).
// Excel's "Choose where you want the PivotTable to be placed" (New Worksheet / Existing Worksheet with its
// Location). Not in gridcraft (the report moves by being created at another cell): not checked against upstream.
//
// Values: pivot (the name), destination ('new' | 'existing'), location (Sheet1!$H$3).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findPivot} from '../commands/pivot.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {parseRange, colToLetters} from '../lib/addr.mjs';

export default defineDialog({
  id: 'dialog.movePivotTable',
  title: 'Move PivotTable',
  command: 'pivot.move',
  init(ctx) {
    const [si, pi] = findPivot(ctx, {});
    const content = baseDoc(ctx);
    const pt = content.sheets[si].pivots[pi];
    const at = parseRange(pt.anchor)?.start ?? {row: 0, col: 0};
    return {pivot: pt.name, destination: 'existing', location: `'${content.sheets[si].name.replace(/'/g, "''")}'!$${colToLetters(at.col)}$${at.row + 1}`};
  },
  validate(v) {
    if (v.destination !== 'existing') return [];
    return parseRange(String(v.location ?? '').replace(/^.*!/, '').replace(/\$/g, '')) ? [] : [{field: 'location', message: 'Enter the cell where the PivotTable report goes, for example Sheet1!$H$3.'}];
  },
  toCommand: v => ({command: 'pivot.move', params: {pivot: v.pivot, to: v.destination === 'existing' ? String(v.location).trim() : 'new'}}),
});

export {gridSel};
