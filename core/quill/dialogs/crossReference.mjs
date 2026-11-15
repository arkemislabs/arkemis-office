// Insert › Links / References › Captions › Cross-reference (submit: insert.crossReference).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/cross_ref.rs (`CrossRefForm`,
// `cross_ref_ui`: the reference types, the caption labels of the person's own, what to insert, the
// targets of the type) at aadb077e072b7de05f724e359d8db82e151f125c, with Word's Insert as hyperlink.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {refTargets, captionLabels} from '../lib/references-lists.mjs';

/** Reference types: built-in, then each caption label of the person's own (`label:<Name>`). */
export function refTypes(d) {
  const out = [['heading', 'Heading'], ['bookmark', 'Bookmark'], ['equation', 'Equation'], ['figure', 'Figure'], ['table', 'Table']];
  for (const l of captionLabels(d)) if (!['Equation', 'Figure', 'Table'].includes(l)) out.push([`label:${l}`, l]);
  return out;
}
/** What can be inserted for a type (Word's Insert reference to). */
export function showOptions(to) {
  if (to === 'heading') return [['text', 'Heading text'], ['page', 'Page number'], ['aboveBelow', 'Above/below']];
  if (to === 'bookmark') return [['text', 'Bookmark text'], ['page', 'Page number'], ['aboveBelow', 'Above/below']];
  return [['text', 'Entire caption'], ['number', 'Only label and number'], ['page', 'Page number'], ['aboveBelow', 'Above/below']];
}

export default defineDialog({
  id: 'dialog.crossReference',
  title: 'Cross-reference',
  command: 'insert.crossReference',
  init(ctx) {
    const d = T.open(ctx).d;
    const targets = {};
    const types = refTypes(d);
    for (const [k] of types) targets[k] = refTargets(d, k).map(([t]) => t);
    return {to: 'heading', types, targets, show: 'text', hyperlink: true, target: targets.heading[0] ?? null};
  },
  derive(v, changed) {
    if (changed.includes('to')) {
      const list = v.targets?.[v.to] ?? [];
      const show = showOptions(v.to).some(([k]) => k === v.show) ? v.show : 'text';
      return {target: list[0] ?? null, show};
    }
    return {};
  },
  validate: v => (typeof v.target === 'string' && v.target ? [] : [{field: 'target', message: 'Choose what to refer to.'}]),
  toCommand: v => ({command: 'insert.crossReference', params: {to: v.to, target: v.target, show: v.show, hyperlink: !!v.hyperlink}}),
});
