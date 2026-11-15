// Print to PDF (submit: print.pages): Pages to Print (All, Current page, Pages with More options and Reverse pages) and Page Sizing & Handling (Size, Multiple, Booklet), written as a
// PDF of the sheets. Translated from printcraft crates/ui-egui/src/workflows/print_ui/body.rs at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt); the printer
// choice, Poster and Label and comments are not offered; the preview shows the sheets (src/apps/folio/dialogs/print.tsx) (commands/print.mjs says why).

import {defineDialog} from '../../kernel/dialog.mjs';
import {currentPage} from '../commands/page.mjs';
import {PAPERS, selectPages, sheetPlan} from '../lib/print-job.mjs';
import {viewSize} from '../lib/geom.mjs';

const SUBSETS = {'All pages in range': 'all', 'Odd pages only': 'odd', 'Even pages only': 'even'};
const FITS = {Fit: 'fit', 'Actual size': 'actual', 'Shrink oversized pages': 'shrink', 'Custom scale:': 'custom'};
const ORDERS = {Horizontal: 'horizontal', 'Horizontal reversed': 'horizontal-reversed', Vertical: 'vertical', 'Vertical reversed': 'vertical-reversed', 'Cut and stack': 'cut-stack'};
const BOOKLET = {'Both sides': 'both', 'Front side only': 'front', 'Back side only': 'back'};
const ORIENT = {'Auto portrait/landscape': 'auto', Portrait: 'portrait', Landscape: 'landscape'};
const HANDLING = {Size: 'size', Multiple: 'multiple', Booklet: 'booklet'};

const dialog = defineDialog({
  id: 'dialog.print',
  title: 'Print pages',
  command: 'print.pages',
  init(ctx) {
    const n = Math.max(1, (ctx?.doc?.pages ?? []).length);
    return {paper: PAPERS[0][0], orientation: 'Auto portrait/landscape', pages: 'All', range: '', subset: 'All pages in range', reverse: false, handling: 'Size', fit: 'Fit', scale: 100, pps: '2', order: 'Horizontal',
      border: false, booklet: 'Both sides', binding: 'Left', __count: n, __current: ctx?.doc?.pages ? currentPage(ctx) + 1 : 1};
  },
  validate(v) {
    const out = [];
    if (v.pages === 'Pages' && !String(v.range ?? '').trim()) out.push({field: 'range', message: 'Type the pages to print, such as 1-3, 6'});
    if (v.fit === 'Custom scale:' && !(Number(v.scale) >= 1 && Number(v.scale) <= 1000)) out.push({field: 'scale', message: 'Type a scale from 1 to 1000 percent'});
    return out;
  },
  /** The sheets the settings make, laid out for the preview: the pages' sizes, where each goes on each sheet (lib/print-job.mjs sheetPlan). */
  preview(ctx, v) {
    const pages = ctx?.doc?.pages ?? [];
    if (!pages.length) return null;
    const p = dialog.toCommand(v).params;
    let picked;
    try {
      if (v.pages === 'Pages' && !String(v.range ?? '').trim()) return {problem: 'Type the pages to print.'};
      picked = selectPages(pages.length, p.range, {subset: p.subset, reverse: p.reverse});
    } catch (e) { return {problem: e.message}; }
    const plan = sheetPlan(picked.map(i => { const z = viewSize(pages[i]); return {w: z.width, h: z.height}; }), p);
    return {base64: ctx.doc.sourceBase64, content: ctx.doc, pages: picked.length, total: plan.total, sheets: plan.sheets.map(sh => ({size: sh.size, cells: sh.cells.map(c => ({page: c.n === null ? null : picked[c.n], rect: c.rect}))}))};
  },
  toCommand(v) {
    const params = {subset: SUBSETS[v.subset] ?? 'all', reverse: v.reverse === true, paper: PAPERS.some(p => p[0] === v.paper) ? v.paper : PAPERS[0][0], orientation: ORIENT[v.orientation] ?? 'auto',
      handling: HANDLING[v.handling] ?? 'size', fit: FITS[v.fit] ?? 'fit', scale: Number(v.scale) || 100, perSheet: Math.max(2, Math.trunc(Number(v.pps)) || 2), order: ORDERS[v.order] ?? 'horizontal',
      border: v.border === true, booklet: BOOKLET[v.booklet] ?? 'both', binding: v.binding === 'Right' ? 'right' : 'left'};
    if (v.pages === 'Current page') params.range = String(Number(v.__current) || 1);
    else if (v.pages === 'Pages') params.range = String(v.range).trim();
    return {command: 'print.pages', params};
  },
});

export default dialog;
