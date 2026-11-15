// Split document (submit: page.split): by Number of pages, File size, Top-level bookmarks, or
// Before each selected page; "Creates {f} files from {n} pages."
// Translated from printcraft crates/ui-egui/src/dialogs.rs:885 (dialog_split) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {selectedPages} from '../commands/page.mjs';

const MODES = {'Number of pages': 'pages', 'File size': 'size', 'Top-level bookmarks': 'bookmarks', 'Before each selected page (select pages in Organize)': 'selection'};
let draft = null;

/** What the split makes, as the read-only Summary value (from numbers the model keeps in the values). */
function summaryText(v) {
  const n = Number(v.__count) || 0;
  const mode = MODES[v.mode] ?? 'pages';
  let f = null;
  if (mode === 'pages') f = Math.ceil(n / Math.max(1, Number(v.every) || 1));
  else if (mode === 'selection') f = 1 + (Number(v.__after) || 0);
  else if (mode === 'bookmarks') f = 1 + (Number(v.__marks) || 0);
  return f === null ? `Splits ${n} pages at the size limit.` : `Creates ${f} files from ${n} pages.`;
}

export default defineDialog({
  id: 'dialog.split',
  title: 'Split document',
  command: 'page.split',
  init(ctx) {
    const n = (ctx.doc?.pages ?? []).length;
    const v = {mode: draft?.mode ?? 'Number of pages', every: draft?.every ?? 1, size: draft?.size ?? 2, __count: n,
      __after: selectedPages(ctx).filter(i => i > 0).length,
      __marks: (ctx.doc?.bookmarks ?? []).filter(b => (ctx.doc.pages ?? []).findIndex(p => p.id === b.pageId) > 0).length};
    return {...v, summary: summaryText(v)};
  },
  validate(v) {
    const mode = MODES[v.mode] ?? 'pages';
    if (mode === 'pages' && !(Number.isInteger(Number(v.every)) && Number(v.every) >= 1)) return [{field: 'every', message: 'Type a number of pages of 1 or more'}];
    if (mode === 'size' && !(Number(v.size) > 0)) return [{field: 'size', message: 'Type a size in MB'}];
    return [];
  },
  derive: v => ({summary: summaryText(v)}),
  toCommand(v) {
    draft = {mode: v.mode, every: v.every, size: v.size};
    const mode = MODES[v.mode] ?? 'pages';
    return {command: 'page.split', params: {mode, ...(mode === 'pages' ? {every: Number(v.every) || 1} : {}), ...(mode === 'size' ? {sizeMb: Number(v.size)} : {})}};
  },
});
