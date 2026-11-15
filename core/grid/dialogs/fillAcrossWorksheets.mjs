// Fill Across Worksheets dialog model (submit: edit.fillAcrossSheets). Excel asks All, Contents or Formats for the grouped sheets; here the
// other sheets are listed with check boxes (src/apps/grid/dialogs/fillAcrossWorksheets.tsx). Not in gridcraft (not checked against upstream).
// Values: fill ('All', 'Contents', 'Formats'), others (the other sheets' names), targets (the ones checked).

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

export default defineDialog({
  id: 'dialog.fillAcrossWorksheets',
  title: 'Fill Across Worksheets',
  command: 'edit.fillAcrossSheets',
  init(ctx) {
    const me = gridSel(ctx).sheet;
    const others = ctx.doc.sheets.map(sh => sh.name).filter((_, i) => i !== me);
    return {fill: 'All', others, targets: [...others]};
  },
  validate: v => ((v.targets ?? []).length ? [] : [{field: 'targets', message: 'Select the other worksheets to fill.'}]),
  toCommand: v => ({command: 'edit.fillAcrossSheets', params: {what: String(v.fill ?? 'All').toLowerCase(), sheets: v.targets ?? []}}),
});
