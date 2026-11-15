// References › Footnotes launcher: Footnote and Endnote (Location, Convert…, Format, Apply changes
// to). Insert applies the options, then inserts a footnote or endnote (with the custom mark); Apply
// only applies them. Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_notes.rs
// (`FORMATS`, `NoteForm` read/params, `note_options`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {sectionOf} from '../model/section.mjs';

export const FORMATS = [['decimal', '1, 2, 3, …'], ['lowerLetter', 'a, b, c, …'], ['upperLetter', 'A, B, C, …'], ['lowerRoman', 'i, ii, iii, …'], ['upperRoman', 'I, II, III, …']];

/** NoteForm::read: both kinds' options in effect at the caret. */
export function noteValues(ctx) {
  const S = T.open(ctx);
  const sect = sectionOf(T.caretSection(S));
  const f = S.d.noteOptions(sect, false), e = S.d.noteOptions(sect, true);
  return {kind: 'footnote', footnotePos: f.pos, endnotePos: e.pos, fmt: [f.numFmt, e.numFmt], start: [f.numStart, e.numStart], restart: [f.numRestart, e.numRestart],
    numFmt: f.numFmt, startAt: f.numStart, numbering: f.numRestart, customMark: '', applyTo: 'document'};
}

/** NoteForm::params for the kind shown. */
export function noteParams(v) {
  const endnote = v.kind === 'endnote';
  const restart = endnote && v.numbering === 'eachPage' ? 'continuous' : v.numbering;
  return {kind: endnote ? 'endnote' : 'footnote', pos: endnote ? v.endnotePos : v.footnotePos, numFmt: v.numFmt, numStart: Math.max(1, Math.min(32_767, Math.round(Number(v.startAt) || 1))),
    numRestart: restart, scope: v.applyTo === 'section' ? 'section' : 'document'};
}

export default defineDialog({
  id: 'dialog.noteOptions',
  title: 'Footnote and Endnote',
  command: 'references.noteOptions',
  init: noteValues,
  derive(v, changed) {
    // Switching Footnotes/Endnotes shows that kind's format, start and numbering (NoteForm keeps both).
    if (changed.includes('kind')) {
      const k = v.kind === 'endnote' ? 1 : 0;
      return {numFmt: v.fmt?.[k] ?? 'decimal', startAt: v.start?.[k] ?? 1, numbering: v.restart?.[k] ?? 'continuous'};
    }
    return {};
  },
  validate(v) {
    const n = Number(v.startAt);
    return Number.isInteger(n) && n >= 1 && n <= 32_767 ? [] : [{field: 'startAt', message: 'Enter a number from 1 to 32767.'}];
  },
  buttons: {
    applyChanges: (_ctx, v) => ({command: 'references.noteOptions', params: noteParams(v)}),
    convertEndnote: () => ({command: 'references.convertNotes', params: {to: 'endnote'}}),
    convertFootnote: () => ({command: 'references.convertNotes', params: {to: 'footnote'}}),
    convertSwap: () => ({command: 'references.convertNotes', params: {to: 'swap'}}),
  },
  toCommand: v => ({batch: [{command: 'references.noteOptions', params: noteParams(v)},
    {command: v.kind === 'endnote' ? 'references.endnote' : 'references.footnote', params: {mark: String(v.customMark ?? '').trim()}}]}),
});
