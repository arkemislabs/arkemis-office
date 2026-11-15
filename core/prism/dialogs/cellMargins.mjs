// Cell Text Layout (submit: table.cellMargins): Custom Margins of Table Layout > Cell Margins. The
// vertical alignment, the text direction and the four internal margins (inches) of the selected
// cells, seeded from the cell the caret is in. PowerPoint's dialog; deckcraft has only the four
// margin presets (not checked against upstream).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findShape} from '../model/presentation.mjs';
import {slideById, currentSlideId} from '../model/doc.mjs';
import {currentCell} from '../lib/table-sel.mjs';

const r2 = v => Math.round(v * 100) / 100;
const DIR_OF = {horizontal: 'horizontal', vertical: 'rotate90', vertical270: 'rotate270', stacked: 'stacked'};
const inches = v => Number(String(v ?? '').replace(/[^0-9.+-]/g, ''));

export default defineDialog({
  id: 'dialog.cellMargins',
  title: 'Cell Text Layout',
  command: 'table.cellMargins',
  init(ctx) {
    const cur = currentCell(ctx.doc, ctx.selection);
    const sh = cur ? findShape(slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection))?.shapes, cur.shape) : null;
    const cell = sh?.kind?.rows?.[cur.cell[0]]?.cells?.[cur.cell[1]];
    const [l, r, t, b] = cell?.margins ?? [7.2, 7.2, 3.6, 3.6];
    return {anchor: cell?.anchor ?? 'top', direction: DIR_OF[cell?.vertical ?? 'horizontal'] ?? 'horizontal', left: r2(l / 72), right: r2(r / 72), top: r2(t / 72), bottom: r2(b / 72)};
  },
  validate(v) {
    const out = [];
    for (const k of ['left', 'right', 'top', 'bottom']) {
      const n = inches(v[k]);
      if (!Number.isFinite(n) || n < 0 || n > 5.5) out.push({field: k, message: 'Margins are from 0 to 5.5 inches'});
    }
    return out;
  },
  toCommand: v => ({command: 'table.cellMargins', params: {left: inches(v.left) * 72, right: inches(v.right) * 72, top: inches(v.top) * 72, bottom: inches(v.bottom) * 72,
    anchor: v.anchor, direction: v.direction}}),
});
