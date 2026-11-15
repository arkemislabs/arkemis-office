// References › Captions › Insert Caption (Caption, with Numbering… and New Label… / Delete Label;
// submit: references.caption). Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/
// caption.rs (`CaptionForm` read/preview/params, `caption_ui`, `numbering_ui`, `new_label_ui`) and
// common.rs (`BUILT_IN_LABELS`, `NUMBER_FORMATS`, `SEPARATORS`) at aadb077e072b7de05f724e359d8db82e151f125c.
// The labels the person made are their preference (references.captionLabels), as upstream's
// `ui.caption_labels`. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {captionLabels} from '../lib/references-lists.mjs';
import {formatNumber} from '../model/numfmt.mjs';

export const BUILT_IN_LABELS = ['Equation', 'Figure', 'Table'];
const NUMFMT = {ARABIC: 'decimal', alphabetic: 'lowerLetter', ALPHABETIC: 'upperLetter', roman: 'lowerRoman', ROMAN: 'upperRoman'};

/** The labels the form offers: built-in, the person's, the document's (CaptionForm::read). */
export function labelsFor(prefs, d) {
  const out = [...BUILT_IN_LABELS];
  const own = Array.isArray(prefs?.captionLabels) ? prefs.captionLabels : [];
  for (const l of [...own, ...captionLabels(d)]) if (typeof l === 'string' && !out.includes(l)) out.push(l);
  return out;
}

/** What the caption will read: "Figure 1-1" (CaptionForm::preview). */
export function captionPreview(v) {
  const n = formatNumber(NUMFMT[v.format] ?? 'decimal', 1);
  const num = v.chapter ? `1${v.separator ?? '-'}${n}` : n;
  return v.excludeLabel ? num : `${v.label ?? 'Figure'} ${num}`;
}

/** CaptionForm::params. */
export function captionParams(v) {
  const p = {label: v.label, position: v.position === 'above' ? 'above' : 'below', excludeLabel: !!v.excludeLabel, format: v.format ?? 'ARABIC'};
  const text = String(v.text ?? '').replace(/^\s*:\s*/, '');
  if (text.trim()) p.text = text.trim();
  if (v.chapter) { p.chapter = Number(v.chapterLevel) || 1; p.separator = v.separator ?? '-'; }
  return p;
}

export default defineDialog({
  id: 'dialog.caption',
  title: 'Caption',
  command: 'references.caption',
  init(ctx) {
    const d = T.open(ctx).d;
    return {text: '', label: 'Figure', labels: labelsFor(ctx.prefs, d), position: 'below', excludeLabel: false, format: 'ARABIC', chapter: false, chapterLevel: 1, separator: '-', newLabel: ''};
  },
  validate: v => (v.label ? [] : [{field: 'label', message: 'Choose a label.'}]),
  buttons: {
    addLabel: (_ctx, v) => (String(v.newLabel ?? '').trim() ? {command: 'references.captionLabels', params: {add: String(v.newLabel).trim()}} : null),
    deleteLabel: (_ctx, v) => (BUILT_IN_LABELS.includes(v.label) ? null : {command: 'references.captionLabels', params: {remove: v.label}}),
  },
  toCommand: v => ({command: 'references.caption', params: captionParams(v)}),
});
