// Design › Watermark › Custom Watermark…: Word's Printed Watermark dialog for a text watermark
// (No watermark / Picture watermark with Select Picture, Scale and Washout / Text watermark, Text, Font, Color, Semitransparent, Layout Diagonal/Horizontal).
// OK runs one design.watermark (or its remove).
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs `watermark_dialog` (Text, Diagonal /
// Horizontal) at aadb077e072b7de05f724e359d8db82e151f125c, MIT, see
// assets/third-party-licenses/artcraft-reference.txt, with Word's No watermark choice, Font, Color
// and Semitransparent, which the model's watermark carries and the page view draws, and the Picture watermark
// (Select Picture through the system Open dialog, Scale, Washout; drawn by src/apps/quill/dialogs/watermark.tsx). Language and Size
// stay out (the text always fills Word's box, which is Word's Auto size).

import {defineDialog} from '../../kernel/dialog.mjs';
import {defaultWatermark} from '../model/content.mjs';
import {rgbHex} from '../model/props.mjs';

export const WATERMARK_TEXTS = Object.freeze(['ASAP', 'CONFIDENTIAL', 'COPY', 'DO NOT COPY', 'DRAFT', 'ORIGINAL', 'PERSONAL', 'SAMPLE', 'TOP SECRET', 'URGENT']);

export function readWatermark(ctx) {
  const wm = ctx.doc?.settings?.watermark ?? null;
  const w = {...defaultWatermark(), ...(wm ?? {})};
  const picture = !!wm?.picture;
  return {kind: !wm ? 'none' : picture ? 'picture' : 'text', hasPicture: picture, imageName: picture ? 'Current picture' : '', image: '', scale: picture ? String(wm.scale > 0 ? wm.scale : 0) : '0', washout: picture ? wm.washout !== false : true, text: picture ? defaultWatermark().text : w.text, font: w.font, color: `#${rgbHex(w.color)}`, semitransparent: w.semitransparent !== false,
    layout: w.diagonal ? 'diagonal' : 'horizontal'};
}

export function watermarkParams(v) {
  if (v.kind === 'none') return {remove: true};
  if (v.kind === 'picture') {
    const out = {scale: Math.max(0, Math.min(500, Number(v.scale) || 0)), washout: v.washout !== false};
    if (typeof v.image === 'string' && v.image) out.image = v.image;
    return out;
  }
  const out = {text: String(v.text ?? ''), diagonal: v.layout !== 'horizontal', semitransparent: v.semitransparent !== false};
  if (typeof v.color === 'string' && /^#?[0-9a-f]{6}$/i.test(v.color.trim())) out.color = v.color.trim().replace(/^#/, '').toUpperCase();
  if (typeof v.font === 'string' && v.font.trim()) out.font = v.font.trim();
  return out;
}

export default defineDialog({
  id: 'dialog.watermark',
  title: 'Printed Watermark',
  command: 'design.watermark',
  init: ctx => readWatermark(ctx),
  derive(v, changed) {
    // Typing or picking a text chooses Text watermark, as in Word.
    if ((changed.includes('text') || changed.includes('font') || changed.includes('color')) && v.kind === 'none') return {kind: 'text'};
    // Selecting a picture chooses Picture watermark.
    if (changed.includes('image') && v.image) return {kind: 'picture'};
    return {};
  },
  validate(v) {
    if (v.kind === 'text' && !String(v.text ?? '').trim()) return [{field: 'text', message: 'Type the watermark text.'}];
    if (v.kind === 'picture' && !v.image && !v.hasPicture) return [{field: 'image', message: 'Select a picture.'}];
    return [];
  },
  toCommand: v => ({batch: [{command: 'design.watermark', params: watermarkParams(v)}]}),
});
