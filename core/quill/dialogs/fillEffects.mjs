// Design › Page Color › Fill Effects… (submit: design.pageFill): the page background as a gradient, a texture or a pattern.
// Not checked against upstream; follows Word's Fill Effects box (Gradient, Texture and Pattern tabs). The Picture tab is the Page Color menu's Picture… item
// (the system Open dialog).

import {defineDialog} from '../../kernel/dialog.mjs';
import {parseRgb, rgbHex} from '../model/props.mjs';

const hex = c => (Array.isArray(c) ? rgbHex(c) : null);

export default defineDialog({
  id: 'dialog.fillEffects',
  title: 'Fill Effects',
  command: 'design.pageFill',
  init(ctx) {
    const pic = ctx.doc?.settings?.pagePicture;
    return {kind: 'gradient', color1: 'FFFFFF', color2: hex(ctx.doc?.settings?.pageColor) ?? '0070C0', style: 'horizontal', variant: '1', texture: 'papyrus', pattern: 'percent50', fg: '000000', bg: 'FFFFFF',
      current: pic?.title ?? ''};
  },
  validate(v) {
    const bad = k => (parseRgb(v[k]) ? [] : [{field: k, message: 'Pick a colour.'}]);
    return v.kind === 'gradient' ? [...bad('color1'), ...bad('color2')] : v.kind === 'pattern' ? [...bad('fg'), ...bad('bg')] : [];
  },
  toCommand(v) {
    if (v.kind === 'texture') return {command: 'design.pageFill', params: {kind: 'texture', texture: v.texture}};
    if (v.kind === 'pattern') return {command: 'design.pageFill', params: {kind: 'pattern', pattern: v.pattern, fg: v.fg, bg: v.bg}};
    return {command: 'design.pageFill', params: {kind: 'gradient', color1: v.color1, color2: v.color2, style: v.style, variant: Number(v.variant)}};
  },
});
