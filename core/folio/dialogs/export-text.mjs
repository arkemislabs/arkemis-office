// Export to Text (submit: export.text): Pages All / Current page / Range.
// Translated from printcraft crates/ui-egui/src/workflows/export_ui.rs:47 (the export dialog's page
// choice) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.export-text',
  title: 'Export to Text',
  command: 'export.text',
  init(ctx) {
    const list = ctx.doc?.pages ?? [];
    return {pages: 'All', from: 1, to: Math.max(1, list.length), __count: list.length, __current: Math.max(0, list.findIndex(p => p.id === ctx.doc?.activePageId))};
  },
  validate(v) {
    if (v.pages !== 'Range') return [];
    const n = Number(v.__count) || 1, a = Number(v.from), b = Number(v.to);
    if (!(Number.isInteger(a) && a >= 1 && a <= n)) return [{field: 'from', message: `Type a page number from 1 to ${n}`}];
    if (!(Number.isInteger(b) && b >= a && b <= n)) return [{field: 'to', message: `Type a page number from ${a} to ${n}`}];
    return [];
  },
  toCommand(v) {
    const pages = v.pages === 'Current page' ? [Number(v.__current) || 0]
      : v.pages === 'Range' ? Array.from({length: Number(v.to) - Number(v.from) + 1}, (_, k) => Number(v.from) - 1 + k) : null;
    return {command: 'export.text', params: pages ? {pages} : {}};
  },
});
