// Size and Position… (submit: shape.sizePosition): Size (height, width, rotation, scale, lock
// aspect ratio) and Position (from the top-left corner of the slide), sizes shown in inches.
// Translated from deckcraft crates/ui-egui/src/dialogs/size_position.rs (`seed_size_position`,
// `reconcile_size_fields`, `size_position_value`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
// PowerPoint's Text Box and Alt Text tabs, picture-only fields and "from Center" positions are not
// offered: deckcraft's dialog has none of them (the Format Shape pane and the Alt Text dialog do).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findShape} from '../model/presentation.mjs';
import {currentSlideId, slideById, selectedShapeIds, xfrmOf} from '../model/doc.mjs';

const r4 = v => Math.round(v * 10000) / 10000;
const scaleOf = (pt, base) => (base > 0 ? pt / base * 100 : 100);
const finite = v => typeof v === 'number' && Number.isFinite(v);

/** The selected shape's box (deckcraft `selection_xfrm`). */
function selectionBox(ctx) {
  const c = ctx.doc;
  const sid = currentSlideId(c, ctx.selection);
  const sl = slideById(c, sid);
  const id = selectedShapeIds(c, ctx.selection)[0];
  const sh = sl && id ? findShape(sl.shapes, id) : null;
  return sh ? xfrmOf(c, sid, sh) : null;
}

/** `seed_size_position`: values in the dialog's units (inches, degrees, percent) plus the base size in points. */
export function seed(box, params = {}) {
  const num = k => (finite(params[k]) ? params[k] : undefined);
  const x = num('x') ?? box?.x ?? 0, y = num('y') ?? box?.y ?? 0;
  const w = num('w') ?? box?.w ?? 72, h = num('h') ?? box?.h ?? 72;
  const rot = num('rot') ?? box?.rot ?? 0;
  return {x: r4(x / 72), y: r4(y / 72), w: r4(w / 72), h: r4(h / 72), rot: r4(rot), scaleW: num('scaleW') ?? 100, scaleH: num('scaleH') ?? 100,
    lock: params.lockAspect === true, baseW: w, baseH: h, edited: []};
}

/** `reconcile_size_fields`: scale follows size, and with the aspect locked the other side follows too. */
export function reconcile(v, changed) {
  const out = {};
  const ar = v.baseH > 0 ? v.baseW / v.baseH : 1;
  const edited = [...new Set([...(v.edited ?? []), ...changed.filter(k => ['x', 'y', 'w', 'h', 'rot', 'scaleW', 'scaleH'].includes(k))])];
  out.edited = edited;
  const lock = !!v.lock;
  if (changed.includes('w') && finite(v.w)) {
    const wPt = v.w * 72;
    out.scaleW = r4(scaleOf(wPt, v.baseW));
    if (lock) { const hPt = ar > 0 ? wPt / ar : wPt; out.h = r4(hPt / 72); out.scaleH = r4(scaleOf(hPt, v.baseH)); }
  } else if (changed.includes('h') && finite(v.h)) {
    const hPt = v.h * 72;
    out.scaleH = r4(scaleOf(hPt, v.baseH));
    if (lock) { const wPt = hPt * ar; out.w = r4(wPt / 72); out.scaleW = r4(scaleOf(wPt, v.baseW)); }
  } else if (changed.includes('scaleW') && finite(v.scaleW)) {
    const wPt = v.baseW * v.scaleW / 100;
    out.w = r4(wPt / 72);
    if (lock) { const hPt = ar > 0 ? wPt / ar : wPt; out.h = r4(hPt / 72); out.scaleH = v.scaleW; }
  } else if (changed.includes('scaleH') && finite(v.scaleH)) {
    const hPt = v.baseH * v.scaleH / 100;
    out.h = r4(hPt / 72);
    if (lock) { const wPt = hPt * ar; out.w = r4(wPt / 72); out.scaleW = v.scaleH; }
  } else if (changed.includes('lock') && lock && finite(v.w)) {
    const wPt = v.w * 72;
    const hPt = ar > 0 ? wPt / ar : wPt;
    out.h = r4(hPt / 72);
    out.scaleH = r4(scaleOf(hPt, v.baseH));
    out.scaleW = r4(scaleOf(wPt, v.baseW));
  }
  return out;
}

/** `size_position_value`: the shape.sizePosition params, in points. */
export function sizePositionValue(v) {
  const ed = new Set(v.edited ?? []);
  const pt = k => v[k] * 72;
  let w = ed.has('w') ? pt('w') : ed.has('scaleW') ? v.baseW * v.scaleW / 100 : pt('w');
  let h = ed.has('h') ? pt('h') : ed.has('scaleH') ? v.baseH * v.scaleH / 100 : pt('h');
  // Untouched sides go back exactly as they were (inches are rounded for display).
  if (!ed.has('w') && !ed.has('scaleW') && Math.abs(w - v.baseW) < 0.01) w = v.baseW;
  if (!ed.has('h') && !ed.has('scaleH') && Math.abs(h - v.baseH) < 0.01) h = v.baseH;
  if (v.lock) {
    const ar = v.baseH > 0 ? v.baseW / v.baseH : 1;
    const widthDrives = ed.has('w') || ed.has('scaleW') || (!ed.has('h') && !ed.has('scaleH'));
    if (widthDrives) h = ar > 0 ? w / ar : h; else w = h * ar;
  }
  const out = {x: pt('x'), y: pt('y'), w, h, rot: v.rot, lockAspect: !!v.lock};
  if (!ed.has('x') && v.x0 !== undefined) out.x = v.x0;
  if (!ed.has('y') && v.y0 !== undefined) out.y = v.y0;
  return out;
}

export default defineDialog({
  id: 'dialog.sizePosition',
  title: 'Size and Position',
  command: 'shape.sizePosition',
  init(ctx) {
    const box = selectionBox(ctx);
    const v = seed(box, ctx.dialogArgs ?? {});
    return {...v, x0: box?.x, y0: box?.y};
  },
  derive(values, changed) { return reconcile(values, changed); },
  validate(v) {
    const out = [];
    for (const [k, label] of [['x', 'Horizontal'], ['y', 'Vertical'], ['w', 'Width'], ['h', 'Height'], ['rot', 'Rotation'], ['scaleW', 'Scale width'], ['scaleH', 'Scale height']]) {
      if (!finite(v[k])) out.push({field: k, message: `${label} must be a number`});
    }
    if (finite(v.w) && (v.w * 72 < 0.01 || v.w * 72 > 15840)) out.push({field: 'w', message: 'Width must be between 0 and 220 in'});
    if (finite(v.h) && (v.h * 72 < 0.01 || v.h * 72 > 15840)) out.push({field: 'h', message: 'Height must be between 0 and 220 in'});
    return out;
  },
  toCommand(v) { return {command: 'shape.sizePosition', params: sizePositionValue(v)}; },
});
