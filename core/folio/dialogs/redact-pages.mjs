// Redact pages: Mark Page Range (submit: redact.pages): Current page, or Pages from N to M.
// Translated from printcraft crates/ui-egui/src/tools/redact_ui.rs (PagesDraft, pages_body, redact_pages)
// at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

const count = ctx => (ctx.doc?.pages ?? []).length;

export default defineDialog({
  id: 'dialog.redact-pages',
  title: 'Mark Page Range',
  command: 'redact.pages',
  init(ctx) {
    const n = count(ctx);
    const at = Math.max(0, (ctx.doc?.pages ?? []).findIndex(p => p.id === ctx.doc?.activePageId)) + 1;
    return {scope: 'Current page', from: at, to: at, __count: n};
  },
  derive(v, changed) { return changed.includes('from') && Number(v.to) < Number(v.from) ? {to: v.from} : {}; },
  validate(v) {
    if (v.scope === 'Current page') return [];
    const n = Number(v.__count) || 1;
    const from = Number(v.from);
    const to = Number(v.to);
    if (!Number.isInteger(from) || from < 1 || from > n) return [{field: 'from', message: `Type a page from 1 to ${n}`}];
    if (!Number.isInteger(to) || to < from || to > n) return [{field: 'to', message: `Type a page from ${from} to ${n}`}];
    return [];
  },
  toCommand: v => ({command: 'redact.pages', params: v.scope === 'Current page' ? {} : {from: Number(v.from), to: Number(v.to)}}),
});
