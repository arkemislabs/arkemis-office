// Slicer Settings dialog model (submit: slicer.set): the slicer's header caption. gridcraft keeps the caption on the slicer
// (cmd/slicer.rs, model Slicer.caption) at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: caption.

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc, failed} from '../lib/data-common.mjs';
import {selectedObject} from '../lib/objects.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

export default defineDialog({
  id: 'dialog.slicerSettings',
  title: 'Slicer Settings',
  command: 'slicer.set',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = selectedObject(content, ctx.selection);
    const list = sel?.kind === 'slicer' ? content.sheets[sel.si].slicers : content.sheets[gridSel(ctx).sheet].slicers;
    const sl = sel?.kind === 'slicer' ? list.find(x => x.id === sel.id) : list?.[list.length - 1];
    if (!sl) throw failed('Select a slicer first.');
    return {caption: sl.caption ?? sl.column};
  },
  validate: v => (String(v.caption ?? '').trim() ? [] : [{field: 'caption', message: 'Enter a caption for the slicer.'}]),
  toCommand: v => ({command: 'slicer.set', params: {caption: String(v.caption).trim()}}),
});
