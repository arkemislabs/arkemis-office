// Rotate Pages (submit: page.rotate_dialog): Direction, Pages All / Selection / From–to, Rotate
// even/odd, Orientation landscape/portrait. Opens on Selection when pages are selected.
// Translated from printcraft crates/ui-egui/src/dialogs.rs:1079 (dialog_rotate_pages) and
// commands.rs:425-433 (rotate_draft: to = page count, which = selection or all) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {selectedPages} from '../commands/page.mjs';

const DIRECTIONS = {'Clockwise 90 degrees': 90, 'Counterclockwise 90 degrees': 270, '180 degrees': 180};
const PARITY = {'Even and Odd Pages': 'both', 'Even Pages Only': 'even', 'Odd Pages Only': 'odd'};
const ORIENTATION = {'Landscape and Portrait Pages': 'both', 'Landscape Pages': 'landscape', 'Portrait Pages': 'portrait'};
let draft = null;

export default defineDialog({
  id: 'dialog.rotate-pages',
  title: 'Rotate Pages',
  command: 'page.rotate_dialog',
  init(ctx) {
    const n = (ctx.doc?.pages ?? []).length;
    const sel = selectedPages(ctx);
    return {direction: draft?.direction ?? 'Clockwise 90 degrees', pages: sel.length ? 'Selection' : 'All', from: 1, to: Math.max(1, n),
      parity: draft?.parity ?? 'Even and Odd Pages', orientation: draft?.orientation ?? 'Landscape and Portrait Pages', __count: n};
  },
  validate(v) {
    if (v.pages !== 'From') return [];
    const n = Number(v.__count) || 1, a = Number(v.from), b = Number(v.to);
    if (!(Number.isInteger(a) && a >= 1 && a <= n)) return [{field: 'from', message: `Type a page number from 1 to ${n}`}];
    if (!(Number.isInteger(b) && b >= a && b <= n)) return [{field: 'to', message: `Type a page number from ${a} to ${n}`}];
    return [];
  },
  toCommand(v) {
    draft = {direction: v.direction, parity: v.parity, orientation: v.orientation};
    const which = v.pages === 'Selection' ? 'selection' : v.pages === 'From' ? 'range' : 'all';
    return {command: 'page.rotate_dialog', params: {degrees: DIRECTIONS[v.direction] ?? 90, which, ...(which === 'range' ? {from: Number(v.from), to: Number(v.to)} : {}),
      parity: PARITY[v.parity] ?? 'both', orientation: ORIENTATION[v.orientation] ?? 'both'}};
  },
});
