// Home › Font › Phonetic Guide: the base text, the Ruby text, Alignment, Offset and Size of the guide over the selected text (or the guide
// the selection is). Remove takes an existing guide away. OK runs format.phonetic.
//
// Over wordcraft crates/ui-egui/src/dialogs/dispatch.rs `phonetic_dialog` (its six alignments, offset -100 to 100 pt, size 1 to 200 pt).
// Word's Font box and preview are not upstream. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {phoneticOf} from '../commands/word-core.mjs';

export const ALIGNS = Object.freeze([['center', 'Center'], ['distributeLetter', 'Distribute letters'], ['distributeSpace', 'Distribute spacing'], ['left', 'Left'], ['right', 'Right'],
  ['rightVertical', 'Right (vertical)']]);
const idOf = label => (ALIGNS.find(([, l]) => l === label) ?? ALIGNS[0])[0];

export default defineDialog({
  id: 'dialog.phonetic',
  title: 'Phonetic Guide',
  command: 'format.phonetic',
  init(ctx) {
    let st;
    try { st = phoneticOf(ctx); } catch { st = {base: '', ruby: '', align: 'center', size: 5, offset: 0, existing: false}; }
    return {base: st.base, ruby: st.ruby, alignment: (ALIGNS.find(([k]) => k === st.align) ?? ALIGNS[0])[1], offset: st.offset, size: st.size, existing: st.existing};
  },
  validate(v) {
    const errors = [];
    if (!String(v.ruby ?? '').trim() && !v.existing) errors.push({field: 'ruby', message: 'Type the ruby text.'});
    if (!String(v.base ?? '').trim() && !v.existing) errors.push({field: 'base', message: 'Select the text to put the guide over first.'});
    return errors;
  },
  buttons: {remove: (_ctx, v) => (v.existing ? {command: 'format.phonetic', params: {ruby: null}} : null)},
  toCommand: v => ({command: 'format.phonetic', params: {ruby: String(v.ruby ?? ''), align: idOf(v.alignment), size: Number(v.size) || 1, offset: Number(v.offset) || 0}}),
});
