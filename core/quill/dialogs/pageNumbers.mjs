// Insert › Header & Footer › Page Number › Format Page Numbers…: Word's Page Number Format box: the number format (1, 2, 3 / - 1 - / a, b, c /
// A, B, C / i, ii, iii / I, II, III) and Page numbering (Continue from previous section, or Start at). OK runs layout.pageNumberFormat on
// the selection's sections. Include chapter number is not offered (the layout has no chapter numbers).
//
// Over wordcraft crates/ui-egui/src/dialogs/dialogs_layout/page.rs and engine page.rs `layout.pageNumberFormat`.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {Document} from '../model/document.mjs';
import {selectionPositions} from '../address.mjs';
import {sectAt} from '../commands/page.mjs';
import {sectionOf} from '../model/section.mjs';

export const FORMATS = Object.freeze([['decimal', '1, 2, 3, …'], ['numberInDash', '- 1 -, - 2 -, …'], ['lowerLetter', 'a, b, c, …'], ['upperLetter', 'A, B, C, …'],
  ['lowerRoman', 'i, ii, iii, …'], ['upperRoman', 'I, II, III, …']]);
export const CONTINUE = 'Continue from previous section';
export const START_AT = 'Start at:';
const idOf = label => (FORMATS.find(([, l]) => l === label) ?? FORMATS[0])[0];

export default defineDialog({
  id: 'dialog.pageNumbers',
  title: 'Page Number Format',
  command: 'layout.pageNumberFormat',
  init(ctx) {
    let x = {};
    try {
      const d = new Document(ctx.doc);
      const r = selectionPositions(ctx.doc, ctx.selection);
      const at = r[ctx.selection?.primary ?? 0] ?? r[0];
      x = sectionOf(sectAt(d, {anchor: at.anchor, focus: at.focus}));
    } catch { x = {}; }
    const start = Number.isFinite(x.pageNumStart) ? x.pageNumStart : null;
    return {format: (FORMATS.find(([k]) => k === x.pageNumFormat) ?? FORMATS[0])[1], numbering: start === null ? CONTINUE : START_AT, startAt: start ?? 1};
  },
  validate: v => (v.numbering === START_AT && !(Number(v.startAt) >= 0) ? [{field: 'startAt', message: 'Type the page number to start at.'}] : []),
  toCommand: v => ({command: 'layout.pageNumberFormat', params: {format: idOf(v.format), start: v.numbering === START_AT ? Math.min(100_000, Math.max(0, Math.trunc(Number(v.startAt) || 0))) : null}}),
});
