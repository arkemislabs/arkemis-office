// Add / Update Background (submit: edit.background; Update collects it through host.openDialog).
// From color or File (a picture, its page number and scale relative to the page), Opacity, Page
// Range Options, the preview tinted with the colour.
//
// Translated from printcraft crates/ui-egui/src/dialogs/marks_ui.rs (`body` for Background,
// `behind`, `file_source`, `edit`) and crates/edit/src/marks.rs (Background defaults) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {defaultBackground} from '../lib/edit-marks.mjs';
import {draftOf, keepDraft, rangeValues, rangeParams, rangeProblems, hexOf, rgbOf, previewFrame} from '../lib/edit-mark-dialog.mjs';
import {fileParam} from './watermark.mjs';

const countOf = ctx => (ctx.doc?.pages ?? []).length;

function fresh(count) {
  const d = defaultBackground();
  return {source: 'From color', color: hexOf(d.color), file: '', 'file-page': 1, scale: Math.round(d.scale * 100), opacity: Math.round(d.opacity * 100),
    ...rangeValues(count), __replace: false, __preview: null};
}

/** Dialog values → edit.background params. */
export function valuesToParams(v) {
  const out = {...rangeParams(v), opacity: Math.min(1, Math.max(0, (Number(v.opacity) || 0) / 100)), ...(v.__replace ? {replace: true} : {})};
  if (v.source === 'File') Object.assign(out, {file: fileParam(v.file, v['file-page']), scale: Math.min(1, Math.max(0.05, (Number(v.scale) || 100) / 100))});
  else out.color = rgbOf(v.color, [1, 0.95, 0.7]);
  return out;
}

export default defineDialog({
  id: 'dialog.background',
  title: 'Add Background',
  command: 'edit.background',
  init(ctx) {
    const count = countOf(ctx);
    const kept = draftOf('Background');
    const v = kept ? {...kept, to: Math.min(Math.max(1, Number(kept.to) || count), Math.max(1, count))} : fresh(count);
    return {...v, __replace: false, __preview: null, __count: count};
  },
  derive(v, changed) {
    return changed.some(f => ['scope', 'from', 'to', 'subset'].includes(f)) ? {__preview: null} : {};
  },
  validate(v) {
    const out = [];
    if (v.source === 'File' && !String(v.file ?? '').trim()) out.push({field: 'file', message: 'Choose a file first'});
    if (!(Number(v.opacity) >= 0 && Number(v.opacity) <= 100)) out.push({field: 'opacity', message: 'Type an opacity from 0% to 100%'});
    out.push(...rangeProblems(v, Number(v.__count) || 1));
    return out;
  },
  preview(ctx, v) {
    return {...previewFrame(ctx, v), kind: 'Background', color: v.source === 'File' ? null : v.color, opacity: (Number(v.opacity) || 0) / 100,
      file: v.source === 'File' ? (String(v.file ?? '').startsWith('data:') ? 'picture' : String(v.file ?? '').split(/[\\/]/).pop()) || null : null,
      scale: (Number(v.scale) || 100) / 100, replace: !!v.__replace};
  },
  toCommand(v) {
    keepDraft('Background', v);
    return {command: 'edit.background', params: valuesToParams(v)};
  },
});
