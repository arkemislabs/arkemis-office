// Layout › Arrange › Align › Grid Settings… (submit: layout.gridSettings): the drawing grid's spacing and whether the page view draws it.
// Not checked against upstream (wordcraft keeps the spacing, w:drawingGridHorizontalSpacing, and draws it with Gridlines, but has no box for it); the fields
// are the ones of Word's Drawing Grid box that do something here: Horizontal and Vertical spacing, Display gridlines on screen. Snapping objects to the grid
// is not offered (an object is placed by Position, with numbers).

import {defineDialog} from '../../kernel/dialog.mjs';
import {DEFAULT_GRID} from '../model/content.mjs';
import {viewOf} from '../lib/view-layout.mjs';

const r2 = x => Math.round(x * 100) / 100;

export default defineDialog({
  id: 'dialog.gridSettings',
  title: 'Grid Settings',
  command: 'layout.gridSettings',
  init(ctx) {
    const st = ctx.doc?.settings ?? {};
    return {gridH: r2(st.gridH ?? DEFAULT_GRID), gridV: r2(st.gridV ?? DEFAULT_GRID), gridlines: !!viewOf(ctx.view).gridlines};
  },
  validate(v) {
    return ['gridH', 'gridV'].flatMap(k => { const x = Number(v[k]); return Number.isFinite(x) && x >= 0.5 && x <= 1584 ? [] : [{field: k, message: 'The spacing must be between 0.5 and 1584 pt.'}]; });
  },
  toCommand(v) { return {command: 'layout.gridSettings', params: {gridH: Number(v.gridH), gridV: Number(v.gridV), gridlines: !!v.gridlines}}; },
});
