// Allow Edit Ranges dialog model (submit: review.allowEditRanges, with the action picked).
// gridcraft's form (crates/ui-egui/src/dialogs.rs `allowEditRanges`): the ranges listed, an action (New, Modify,
// Delete, Unlock with password), Title, Refers to cells, Range password, New title and Remove the password.
// Excel's dialog lists the ranges with New, Modify, Delete and Protect Sheet buttons; the body
// (src/apps/grid/dialogs/allowEditRanges.tsx) draws that over the same command. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Values: ranges (the list), selected (index or -1), title, range, password, newTitle, removePassword.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {rangeA1} from '../lib/addr.mjs';
import {editRangeList} from '../commands/review.mjs';

export default defineDialog({
  id: 'dialog.allowEditRanges',
  title: 'Allow Edit Ranges',
  command: 'review.allowEditRanges',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    const ranges = editRangeList(ctx, content.sheets[sel.sheet]);
    return {ranges, selected: ranges.length ? 0 : -1, title: '', range: sel.ranges.map(rangeA1).join(','), password: '', newTitle: '', removePassword: false};
  },
  validate: () => [],
  toCommand: v => ({command: 'review.allowEditRanges', params: {action: 'list'}}),
});
