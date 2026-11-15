// Home > Editing > Fill > Across Worksheets: the selected cells of the active sheet copied to the same cells of other sheets.
// Not in gridcraft (not checked against upstream); Office's behaviour. Excel does this to the sheets grouped by Ctrl-clicking their
// tabs and asks only for All, Contents or Formats; this application has no sheet groups, so the dialog lists the other sheets with
// check boxes (all checked) and the command takes them as `sheets`. Contents copies values and formulas (the formulas read the
// same cells of their own sheet, as in Excel) and leaves the formats; Formats copies the cell formats only; All copies both.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {count, rangeA1} from '../../lib/addr.mjs';
import {MAX_FILL_CELLS} from '../../model/fill.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';
import {hasDoc, targetRange, targetSheet, bad, failed, requireSchema2, areaAddress} from '../../lib/edit-targets.mjs';
import {guardWrite} from '../edit/cell.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: []};
const WHAT = ['all', 'contents', 'formats'];

const severalSheets = ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  return ctx.doc.sheets.length > 1 ? {enabled: true} : {enabled: false, reason: 'the workbook has one sheet'};
};

function fillAcross(ctx, p) {
  const {sheet: from, range} = targetRange(ctx, p);
  requireSchema2(ctx, from);
  const what = String(p.what ?? 'all').toLowerCase();
  if (!WHAT.includes(what)) throw bad('edit.fillAcrossSheets', '`what` is all, contents or formats');
  const content = ctx.doc;
  const names = Array.isArray(p.sheets) && p.sheets.length ? p.sheets : content.sheets.map((_, i) => i).filter(i => i !== from);
  const targets = [...new Set(names.map(n => targetSheet(ctx, {sheet: n})))].filter(i => i !== from);
  if (!targets.length) throw failed('Select the other worksheets to fill.');
  if (count(range) > MAX_FILL_CELLS) throw bad('edit.fillAcrossSheets', 'range too large');
  const src = content.sheets[from];
  for (const ti of targets) {
    requireSchema2(ctx, ti);
    const dst = content.sheets[ti];
    for (let r = range.start.row; r <= range.end.row; r++) {
      for (let c = range.start.col; c <= range.end.col; c++) {
        const a = cellAt(src, r, c) ?? null, b = cellAt(dst, r, c) ?? null;
        let next;
        if (what === 'all') next = a ? {...a} : null;
        else if (what === 'contents') {
          next = {...(a ?? {})};
          delete next.s;
          if (b?.s) next.s = b.s;
        } else {
          next = {...(b ?? {})};
          delete next.s;
          if (a?.s) next.s = a.s;
        }
        if (what !== 'formats') guardWrite(ctx, ti, r, c, next);
        writeCell(ctx.change, content, ti, r, c, next);
      }
    }
  }
  return {range: rangeA1(range), sheets: targets.map(i => content.sheets[i].name), what, address: areaAddress(content, from, range)};
}

export default defineCommands({
  family: 'main/fill-across',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.fillAcrossSheets', label: 'Across Worksheets…', risk: 'edit', dialog: 'dialog.fillAcrossWorksheets',
      description: 'Copy the range (default: the selection) of the active sheet to the same cells of other sheets (default: all the others): what is all, contents (values and formulas) or formats.',
      params: s.object({
        range: s.optional(s.string({min: 1, max: 4096})), sheet: s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})])),
        what: s.optional(s.enum(WHAT)),
        sheets: s.optional(s.array(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]), {max: 255})),
      }),
      state: severalSheets,
      run: fillAcross,
    },
  ],
});
