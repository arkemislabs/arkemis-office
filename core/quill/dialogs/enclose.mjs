// Home › Font › Enclose Characters (submit: format.enclose).
// Translated from wordcraft crates/ui-egui/src/dialogs.rs (the "enclose" opener: the selection's
// text and its enclosure, if it has one) and dispatch.rs `enclose_dialog` (None takes the
// enclosure off; otherwise shape, style and text) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {encloseTarget} from '../commands/format.mjs';
import {peek} from '../lib/format-target.mjs';
import {fitsEnclosure} from '../model/eq.mjs';

export default defineDialog({
  id: 'dialog.enclose',
  title: 'Enclose Characters',
  command: 'format.enclose',
  init(ctx) {
    let t = null;
    try { t = encloseTarget(ctx, peek(ctx)); } catch { t = null; }
    const cur = t?.current ?? null;
    return {style: cur?.style ?? 'shrink', enclosure: cur?.shape ?? 'circle', text: t?.text ?? ''};
  },
  validate(v) {
    if (v.style === 'none') return [];
    const out = [];
    if (typeof v.text !== 'string' || !v.text) out.push({field: 'text', message: 'Type the characters to enclose.'});
    else if (!fitsEnclosure(v.text)) out.push({field: 'text', message: 'Enclose one full-width character or up to two half-width characters.'});
    if (!['circle', 'square', 'triangle', 'diamond'].includes(v.enclosure)) out.push({field: 'enclosure', message: 'Choose an enclosure.'});
    return out;
  },
  preview(ctx, v) {
    return {kind: 'enclose', text: v.text ?? '', shape: v.style === 'none' ? null : v.enclosure, style: v.style};
  },
  toCommand(v) {
    if (v.style === 'none') return {command: 'format.enclose', params: {shape: null}};
    return {command: 'format.enclose', params: {shape: v.enclosure, style: v.style, text: v.text}};
  },
});
