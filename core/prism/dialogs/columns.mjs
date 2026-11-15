// Columns (submit: format.columns): the number of columns (1–16) and the spacing between them
// (inches, 0–22), seeded from the shape as drawn.
// Translated from deckcraft crates/ui-egui/src/dialogs/columns.rs and
// crates/engine/src/cmd/format/paragraph.rs (`current_columns`) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {currentColumns} from '../commands/format.mjs';

const r4 = v => Math.round(v * 10000) / 10000;

export default defineDialog({
  id: 'dialog.columns',
  title: 'Columns',
  command: 'format.columns',
  // A shape with one column and no gap shows PowerPoint's default gap of 0.5 in, not a dead 0.
  init(ctx) { const [count, spacing] = currentColumns(ctx); return {count, spacing: r4((count === 1 && spacing === 0 ? 36 : spacing) / 72)}; },
  validate(v) {
    const out = [];
    if (!Number.isInteger(v.count) || v.count < 1 || v.count > 16) out.push({field: 'count', message: 'Number must be a whole number from 1 to 16'});
    if (typeof v.spacing !== 'number' || !Number.isFinite(v.spacing) || v.spacing < 0 || v.spacing > 22) out.push({field: 'spacing', message: 'Spacing must be from 0 to 22 inches'});
    return out;
  },
  toCommand: v => ({command: 'format.columns', params: {count: v.count, spacing: v.spacing * 72}}),
});
