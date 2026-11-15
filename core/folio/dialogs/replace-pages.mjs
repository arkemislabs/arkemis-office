// Replace Pages (submit: page.replace): Original — replace pages from..to; Replacement — from page N
// of the chosen file (the file is picked in the system Open dialog when OK runs the command).
// Translated from printcraft crates/ui-egui/src/dialogs.rs:957 (dialog_replace) and
// workflows/files.rs start_replace (the range starts at the selection) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {targetPages} from '../commands/page.mjs';

export default defineDialog({
  id: 'dialog.replace-pages',
  title: 'Replace Pages',
  command: 'page.replace',
  init(ctx) {
    const sel = targetPages(ctx);
    return {from: sel[0] + 1, to: sel[sel.length - 1] + 1, 'src-from': 1, __count: (ctx.doc?.pages ?? []).length};
  },
  validate(v) {
    const n = Number(v.__count) || 1, a = Number(v.from), b = Number(v.to);
    if (!(Number.isInteger(a) && a >= 1 && a <= n)) return [{field: 'from', message: `Type a page number from 1 to ${n}`}];
    if (!(Number.isInteger(b) && b >= a && b <= n)) return [{field: 'to', message: `Type a page number from ${a} to ${n}`}];
    if (!(Number.isInteger(Number(v['src-from'])) && Number(v['src-from']) >= 1)) return [{field: 'src-from', message: 'Type a page number of 1 or more'}];
    return [];
  },
  preview(ctx, v) {
    const k = Math.max(0, Number(v.to) - Number(v.from) + 1);
    return {text: `to ${Number(v['src-from']) + k - 1}`};
  },
  toCommand(v) {
    return {command: 'page.replace', params: {from: Number(v.from), to: Number(v.to), srcFrom: Number(v['src-from'])}};
  },
});
