// Add / Update Watermark (submit: edit.watermark; Update collects it through host.openDialog).
// Source Text or File (a picture, its page number and scale relative to the page); Text, Fit to
// page or a size, colour; Rotation −45° / None / 45° or any angle; Opacity; Location behind or on
// top; Offset from centre; Page Range Options; the preview.
//
// Translated from printcraft crates/ui-egui/src/dialogs/marks_ui.rs (`body` for Watermark,
// `file_source`, `edit`: Fit to page sends size 0; MAX_OFFSET) and crates/edit/src/marks.rs
// (Watermark defaults) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {defaultWatermark} from '../lib/edit-marks.mjs';
import {draftOf, keepDraft, rangeValues, rangeParams, rangeProblems, hexOf, rgbOf, previewFrame} from '../lib/edit-mark-dialog.mjs';

const ROTATIONS = {'-45°': -45, None: 0, '45°': 45};
const MAX_OFFSET = 20000;
const countOf = ctx => (ctx.doc?.pages ?? []).length;

function fresh(count) {
  const d = defaultWatermark();
  return {source: 'Text', file: '', 'file-page': 1, scale: Math.round(d.scale * 100), text: '', fit: true, size: 72, color: hexOf(d.color),
    rotation: '45°', degrees: d.rotation, opacity: Math.round(d.opacity * 100), location: 'Appear on top of page', 'offset-h': 0, 'offset-v': 0,
    ...rangeValues(count), __replace: false, __preview: null};
}

/** A picked file (a data: URL from the picture picker, or a path) → the command's `file` param. */
export function fileParam(value, page) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(s);
  const pg = Math.max(1, Math.round(Number(page) || 1));
  if (m) return {base64: m[2], name: /png/i.test(m[1] ?? '') ? 'picture.png' : /pdf/i.test(m[1] ?? '') ? 'picture.pdf' : 'picture.jpg', page: pg};
  return {path: s, page: pg};
}

/** Dialog values → edit.watermark params. */
export function valuesToParams(v) {
  const useFile = v.source === 'File';
  const out = {
    ...rangeParams(v),
    color: rgbOf(v.color, [0.6, 0.6, 0.6]),
    opacity: Math.min(1, Math.max(0, (Number(v.opacity) || 0) / 100)),
    rotation: Number.isFinite(Number(v.degrees)) ? Number(v.degrees) : (ROTATIONS[v.rotation] ?? 45),
    behind: v.location === 'Appear behind page',
    offset: [Number(v['offset-h']) || 0, Number(v['offset-v']) || 0],
    ...(v.__replace ? {replace: true} : {}),
  };
  if (useFile) Object.assign(out, {file: fileParam(v.file, v['file-page']), scale: Math.min(1, Math.max(0.05, (Number(v.scale) || 50) / 100))});
  else Object.assign(out, {text: String(v.text ?? ''), fontSize: v.fit ? 0 : Number(v.size) || 72});
  return out;
}

export default defineDialog({
  id: 'dialog.watermark',
  title: 'Add Watermark',
  command: 'edit.watermark',
  init(ctx) {
    const count = countOf(ctx);
    const kept = draftOf('Watermark');
    const v = kept ? {...kept, to: Math.min(Math.max(1, Number(kept.to) || count), Math.max(1, count))} : fresh(count);
    return {...v, __replace: false, __preview: null, __count: count};
  },
  derive(v, changed) {
    const out = {};
    // The radio picks −45°, None or 45°; the number beside it takes any angle.
    if (changed.includes('rotation') && v.rotation in ROTATIONS) out.degrees = ROTATIONS[v.rotation];
    if (changed.includes('degrees')) {
      const d = Number(v.degrees);
      out.rotation = Object.keys(ROTATIONS).find(k => ROTATIONS[k] === d) ?? v.rotation;
    }
    if (changed.some(f => ['scope', 'from', 'to', 'subset'].includes(f))) out.__preview = null;
    return out;
  },
  validate(v) {
    const out = [];
    if (v.source === 'File') {
      if (!String(v.file ?? '').trim()) out.push({field: 'file', message: 'Choose a file first'});
    } else {
      if (!String(v.text ?? '').trim()) out.push({field: 'text', message: 'Type the watermark text first'});
      if (!v.fit && !(Number(v.size) >= 6 && Number(v.size) <= 300)) out.push({field: 'size', message: 'Type a size from 6 to 300 points'});
    }
    if (!(Number(v.degrees) >= -180 && Number(v.degrees) <= 180)) out.push({field: 'degrees', message: 'Type an angle from -180° to 180°'});
    if (!(Number(v.opacity) >= 0 && Number(v.opacity) <= 100)) out.push({field: 'opacity', message: 'Type an opacity from 0% to 100%'});
    for (const k of ['offset-h', 'offset-v']) if (!(Math.abs(Number(v[k])) <= MAX_OFFSET)) out.push({field: k, message: `Type an offset from -${MAX_OFFSET} to ${MAX_OFFSET} points`});
    out.push(...rangeProblems(v, Number(v.__count) || 1));
    return out;
  },
  preview(ctx, v) {
    const p = valuesToParams(v);
    return {...previewFrame(ctx, v), kind: 'Watermark', text: v.source === 'File' ? null : (String(v.text ?? '').trim() || 'CONFIDENTIAL'),
      file: v.source === 'File' ? (String(v.file ?? '').startsWith('data:') ? 'picture' : String(v.file ?? '').split(/[\\/]/).pop()) || null : null,
      fit: !!v.fit, size: Number(v.size) || 72, scale: (Number(v.scale) || 50) / 100, color: v.color, opacity: p.opacity, rotation: p.rotation,
      behind: p.behind, offset: p.offset, replace: !!v.__replace};
  },
  toCommand(v) {
    keepDraft('Watermark', v);
    return {command: 'edit.watermark', params: valuesToParams(v)};
  },
});
