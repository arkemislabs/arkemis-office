// Layout (Picture Format › Size launcher, Arrange › Position and Wrap Text › More Layout Options…): the Position, Text Wrapping and
// Size tabs of Word's Layout dialog for the selected picture, shape, text box or group. Submit: arrange.layout (position, wrapping
// and distances), picture.size, and arrange.rotation when the angle changed, in one undo step.
//
// Over wordcraft crates/engine/src/cmd/objects/{arrange,picture}.rs (`arrange.wrap`, `arrange.wrapText`, `arrange.position`,
// `picture.size`, `arrange.rotation`) at aadb077e072b7de05f724e359d8db82e151f125c (the dialog: crates/ui-egui/src/dialogs/
// dialogs_layout/page.rs has the Size tab; Position and Text Wrapping are Word's, not checked against upstream). MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Not offered: relative (percent) positions and sizes, Move object with text and
// Lock anchor (the float model has no such fields), left and right distances apart (one distance for both sides).
// No DOM, no Node built-ins.

import {defineDialog} from '../../kernel/dialog.mjs';
import {selectedIn} from '../lib/object-edit.mjs';
import {croppedOriginalSize, fitSize} from '../commands/objects/picture.mjs';
import {normalizeDegrees} from '../lib/geom.mjs';

const round2 = x => Math.round(x * 100) / 100;
const H_ALIGN = {start: 'left', center: 'center', end: 'right', inside: 'inside', outside: 'outside'};
const V_ALIGN = {start: 'top', center: 'center', end: 'bottom', inside: 'inside', outside: 'outside'};
const back = map => Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
const H_RELS = ['margin', 'page', 'column', 'character', 'leftMargin', 'rightMargin', 'insideMargin', 'outsideMargin'];
const V_RELS = ['margin', 'page', 'paragraph', 'line', 'topMargin', 'bottomMargin', 'insideMargin', 'outsideMargin'];
const pick = (v, list, d) => (list.includes(v) ? v : d);

function selected(ctx) {
  const d = ctx.model.open(ctx);
  const all = ctx.model.selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  const hit = selectedIn(d, {anchor: r.anchor, focus: r.focus});
  return {d, obj: hit?.obj ?? null};
}

export default defineDialog({
  id: 'dialog.pictureSize',
  title: 'Layout',
  command: 'picture.size',
  init(ctx) {
    const {d, obj} = selected(ctx);
    if (!obj) return {width: null, height: null, rotation: 0, scaleW: 100, scaleH: 100, lock: true, _ow: 0, _oh: 0, _w0: 0, _h0: 0, _rot0: 0};
    const f = obj.float ?? {};
    const orig = obj.type === 'image' ? croppedOriginalSize(d, obj) : null;
    const [ow, oh] = orig ?? [obj.w, obj.h];
    const rot = normalizeDegrees(f.rot ?? 0);
    const hAlign = f.hAlign ? H_ALIGN[f.hAlign] ?? 'left' : null, vAlign = f.vAlign ? V_ALIGN[f.vAlign] ?? 'top' : null;
    return {
      hMode: hAlign ? 'alignment' : 'absolute', hAlign: hAlign ?? 'left', hAlignRel: pick(f.hRel, H_RELS.filter(x => x !== 'character'), 'margin'), hPos: round2(Number.isFinite(f.x) ? f.x : 0), hPosRel: pick(f.hRel, H_RELS, 'column'),
      vMode: vAlign ? 'alignment' : 'absolute', vAlign: vAlign ?? 'top', vAlignRel: pick(f.vRel, V_RELS.filter(x => x !== 'paragraph' && x !== 'line'), 'margin'), vPos: round2(Number.isFinite(f.y) ? f.y : 0), vPosRel: pick(f.vRel, V_RELS, 'paragraph'),
      wrap: f.wrap ?? 'inline', wrapText: f.wrapText ?? 'bothSides', distTop: round2(f.distTop ?? 0), distBottom: round2(f.distBottom ?? 0), dist: round2(f.dist ?? 0),
      width: round2(obj.w), height: round2(obj.h), rotation: round2(rot), scaleW: round2((obj.w / ow) * 100), scaleH: round2((obj.h / oh) * 100), lock: true,
      _ow: ow, _oh: oh, _w0: obj.w, _h0: obj.h, _rot0: rot, _floating: (f.wrap ?? 'inline') !== 'inline',
    };
  },
  derive(v, changed) {
    const out = {};
    // The rest of Word's rules: choosing a wrapping gives the object the distance Word does when it was in line.
    if (changed.includes('wrap') && v.wrap !== 'inline' && !v._floating && !v.dist) Object.assign(out, {dist: 9, _floating: true});
    const [ow, oh, w0, h0] = [v._ow, v._oh, v._w0, v._h0];
    if (!(ow > 0 && oh > 0 && w0 > 0 && h0 > 0)) return out;
    const sides = ['width', 'height', 'scaleW', 'scaleH'];
    const f = changed.find(k => sides.includes(k));
    if (!f) return out;
    // Scales are relative to the original size; width and height to the points shown.
    const toW = f === 'width' ? v.width : f === 'scaleW' ? (v.scaleW / 100) * ow : null;
    const toH = f === 'height' ? v.height : f === 'scaleH' ? (v.scaleH / 100) * oh : null;
    let w = toW ?? v.width, h = toH ?? v.height;
    if (v.lock && Number.isFinite(w) && Number.isFinite(h)) {
      if (toW !== null && w0 > 0) h = (w / w0) * h0;
      else if (toH !== null && h0 > 0) w = (h / h0) * w0;
    }
    return {...out, width: round2(w), height: round2(h), scaleW: round2((w / ow) * 100), scaleH: round2((h / oh) * 100)};
  },
  validate(v) {
    const side = x => Number.isFinite(x) && x >= 1 && x <= 4000;
    const problems = [];
    if (!side(v.width)) problems.push({field: 'width', message: 'The width must be between 1 pt and 4000 pt.'});
    if (!side(v.height)) problems.push({field: 'height', message: 'The height must be between 1 pt and 4000 pt.'});
    if (!Number.isFinite(v.rotation)) problems.push({field: 'rotation', message: 'The rotation is an angle in degrees.'});
    const far = x => Number.isFinite(x) && Math.abs(x) <= 31680;
    if (v.hMode === 'absolute' && !far(v.hPos)) problems.push({field: 'hPos', message: 'The horizontal position must be within 31680 pt.'});
    if (v.vMode === 'absolute' && !far(v.vPos)) problems.push({field: 'vPos', message: 'The vertical position must be within 31680 pt.'});
    for (const k of ['distTop', 'distBottom', 'dist']) if (!(Number.isFinite(v[k]) && v[k] >= 0 && v[k] <= 1584)) problems.push({field: k, message: 'A distance from text is between 0 and 1584 pt.'});
    return problems;
  },
  toCommand(v) {
    const [w, h] = fitSize(v.width, v.height, false);
    const layout = {wrap: v.wrap, wrapText: v.wrapText, distTop: v.distTop, distBottom: v.distBottom, dist: v.dist};
    if (v.hMode === 'alignment') Object.assign(layout, {hRel: v.hAlignRel, hAlign: back(H_ALIGN)[v.hAlign]}); else Object.assign(layout, {hRel: v.hPosRel, x: v.hPos});
    if (v.vMode === 'alignment') Object.assign(layout, {vRel: v.vAlignRel, vAlign: back(V_ALIGN)[v.vAlign]}); else Object.assign(layout, {vRel: v.vPosRel, y: v.vPos});
    const batch = [{command: 'arrange.layout', params: layout}, {command: 'picture.size', params: {width: w, height: h, lockAspect: false}}];
    if (Math.abs(normalizeDegrees(v.rotation) - (v._rot0 ?? 0)) > 1e-6) batch.push({command: 'arrange.rotation', params: {degrees: v.rotation}});
    return {batch};
  },
});
