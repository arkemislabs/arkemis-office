// Export All Images (submit: export.all_images): Exclude images smaller than, and Pages All / Current page / Range.
// Translated from printcraft crates/ui-egui/src/workflows/export_ui.rs:48 at 8f16855. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export const pagesOf = v => (v.pages === 'Current page' ? [Number(v.__current) || 0]
  : v.pages === 'Range' ? Array.from({length: Number(v.to) - Number(v.from) + 1}, (_, k) => Number(v.from) - 1 + k) : null);

export const rangeErrors = v => {
  if (v.pages !== 'Range') return [];
  const n = Number(v.__count) || 1, a = Number(v.from), b = Number(v.to);
  if (!(Number.isInteger(a) && a >= 1 && a <= n)) return [{field: 'from', message: `Type a page number from 1 to ${n}`}];
  if (!(Number.isInteger(b) && b >= a && b <= n)) return [{field: 'to', message: `Type a page number from ${a} to ${n}`}];
  return [];
};

export const pageInit = ctx => {
  const list = ctx.doc?.pages ?? [];
  return {pages: 'All', from: 1, to: Math.max(1, list.length), __count: list.length, __current: Math.max(0, list.findIndex(p => p.id === ctx.doc?.activePageId))};
};

export default defineDialog({
  id: 'dialog.export-all-images',
  title: 'Export All Images',
  command: 'export.all_images',
  init: ctx => ({min: 0, ...pageInit(ctx)}),
  validate: rangeErrors,
  toCommand(v) {
    const pages = pagesOf(v);
    return {command: 'export.all_images', params: {...(Number(v.min) ? {minSide: Number(v.min)} : {}), ...(pages ? {pages} : {})}};
  },
});
