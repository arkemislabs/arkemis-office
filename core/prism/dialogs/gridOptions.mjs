// Grid Options dialog model (Align › Grid Settings…): Snap objects to grid, Snap objects to other objects,
// the spacing in points, Display grid on screen and Display drawing guides on screen. OK runs
// view.gridOptions in one call; Cancel leaves the presentation as it was.
// Translated from deckcraft crates/ui-egui/src/dialogs/grid_options.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridOptions} from '../commands/view_grid.mjs';

export default defineDialog({
  id: 'dialog.gridOptions',
  title: 'Grid Options',
  command: 'view.gridOptions',
  init(ctx) { const o = gridOptions(ctx); return {snap: o.snap, smart: o.smartGuides, spacing: o.spacing, gridlines: o.gridlines, guides: o.guides}; },
  validate(v) {
    const out = [];
    if (typeof v.spacing !== 'number' || !Number.isFinite(v.spacing) || v.spacing < 1 || v.spacing > 288) out.push({field: 'spacing', message: 'Spacing must be from 1 to 288 points'});
    return out;
  },
  toCommand: v => ({command: 'view.gridOptions', params: {spacing: v.spacing, snap: !!v.snap, smartGuides: !!v.smart, gridlines: !!v.gridlines, guides: !!v.guides}}),
});
