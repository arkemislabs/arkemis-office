// Paragraph… (submit: format.paragraphDialog): alignment, indentation before and after text and
// the special first-line or hanging indent (inches), spacing before and after (pt), line spacing
// presets with At, and Tabs… (the Tabs dialog on top).
// Translated from deckcraft crates/ui-egui/src/dialogs/paragraph.rs (`paragraph_dialog`,
// `line_preset_label`) and crates/engine/src/cmd/format/paragraph.rs (`paragraph_dialog_params`)
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {paragraphDialogParams} from '../commands/format.mjs';

const r4 = v => Math.round(v * 10000) / 10000;
const finite = v => typeof v === 'number' && Number.isFinite(v);

/** deckcraft `line_preset_label`: the preset a (kind, value) pair shows as. */
export function linePreset(kind, value) {
  if (kind === 'exactly') return 'exactly';
  if (value === 1) return 'single';
  if (value === 1.5) return 'onePointFive';
  if (value === 2) return 'double';
  return 'multiple';
}

export function paragraphValues(ctx) {
  const p = paragraphDialogParams(ctx);
  return {align: p.align, before: r4(p.indentLeft / 72), after: r4(p.indentRight / 72), special: p.special, by: r4(p.specialBy / 72),
    spaceBefore: p.spaceBefore, spaceBeforeKind: p.spaceBeforeKind, spaceBeforeSeed: p.spaceBefore, spaceAfter: p.spaceAfter,
    spaceAfterKind: p.spaceAfterKind, spaceAfterSeed: p.spaceAfter, lineKind: linePreset(p.lineKind, p.lineValue), lineValue: p.lineValue};
}

export function deriveParagraph(v, changed) {
  if (!changed.includes('lineKind')) return {};
  switch (v.lineKind) {
    case 'single': return {lineValue: 1};
    case 'onePointFive': return {lineValue: 1.5};
    case 'double': return {lineValue: 2};
    case 'exactly': return finite(v.lineValue) && v.lineValue <= 9.99 ? {lineValue: 18} : {};
    default: return finite(v.lineValue) && v.lineValue > 9.99 ? {lineValue: 1} : {};
  }
}

/** OK: deckcraft's params; a spacing left as it was keeps its kind (pt or % of a line). */
export function paragraphParams(v) {
  const params = {align: v.align ?? 'left', indentLeft: v.before * 72, indentRight: v.after * 72, special: v.special ?? 'none', specialBy: v.by * 72,
    spaceBefore: v.spaceBefore, spaceAfter: v.spaceAfter,
    spaceBeforeKind: v.spaceBefore === v.spaceBeforeSeed ? v.spaceBeforeKind ?? 'pts' : 'pts',
    spaceAfterKind: v.spaceAfter === v.spaceAfterSeed ? v.spaceAfterKind ?? 'pts' : 'pts'};
  if (v.lineKind === 'exactly') params.lineSpacingPt = v.lineValue; else params.lineSpacing = v.lineValue;
  return params;
}

export default defineDialog({
  id: 'dialog.paragraph',
  title: 'Paragraph',
  command: 'format.paragraphDialog',
  init: ctx => paragraphValues(ctx),
  derive: deriveParagraph,
  validate(v) {
    const out = [];
    const need = (k, m) => { if (!finite(v[k])) out.push({field: k, message: m}); };
    need('before', 'Indent before text must be a number of inches');
    need('after', 'Indent after text must be a number of inches');
    need('by', 'Special indent must be a number of inches');
    need('spaceBefore', 'Spacing before must be a number');
    need('spaceAfter', 'Spacing after must be a number');
    need('lineValue', 'Line spacing must be a number');
    return out;
  },
  toCommand: v => ({command: 'format.paragraphDialog', params: paragraphParams(v)}),
});
