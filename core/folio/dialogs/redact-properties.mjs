// Redaction Tool Properties (submit: redact.properties): the box colour, the overlay text (custom text or
// redaction codes), its font, size, colour, alignment and repetition, and how an unapplied mark looks.
// Translated from printcraft crates/ui-egui/src/tools/redact_ui.rs (RedactPrefs, props_body) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {CODE_SETS} from '../lib/redact-patterns.mjs';
import {hexOf, rgbOf} from '../lib/edit-mark-dialog.mjs';
import {prefsOf} from '../commands/redact.mjs';

const FONTS = {Helvetica: 'Helv', 'Times Roman': 'TiRo', Courier: 'Cour'};
const ALIGN = ['Left', 'Center', 'Right'];
const codesOf = v => String(v.codes ?? '').split(/[,\s]+/).filter(Boolean);

export default defineDialog({
  id: 'dialog.redact-properties',
  title: 'Redaction Tool Properties',
  command: 'redact.properties',
  init(ctx) {
    const p = prefsOf(ctx);
    return {
      'no-fill': p.fill === null, fill: hexOf(p.fill ?? [0, 0, 0]), overlay: p.useOverlay, custom: p.overlay, 'use-code': p.useCode,
      code: (CODE_SETS.find(c => c.id === p.codeSet) ?? CODE_SETS[0]).name, codes: p.codes.join(', '),
      font: Object.keys(FONTS).find(k => FONTS[k] === p.look.font) ?? 'Helvetica', size: p.look.size > 0 ? p.look.size : 12, auto: p.look.size <= 0,
      'font-color': hexOf(p.look.color), repeat: p.look.repeat, align: ALIGN[p.look.align] ?? 'Center',
      outline: hexOf(p.outline), 'mark-fill': hexOf(p.hoverFill), opacity: Math.round(p.opacity * 100),
    };
  },
  validate(v) {
    const set = CODE_SETS.find(c => c.name === v.code) ?? CODE_SETS[0];
    const bad = codesOf(v).find(c => !set.codes.includes(c));
    if (v.overlay && v['use-code'] && bad !== undefined) return [{field: 'codes', message: `${bad} is not a code of ${set.name}`}];
    if (!v.auto && !(Number(v.size) >= 2 && Number(v.size) <= 144)) return [{field: 'size', message: 'Type a font size from 2 to 144 pt'}];
    return [];
  },
  preview(ctx, v) {
    const set = CODE_SETS.find(c => c.name === v.code) ?? CODE_SETS[0];
    const text = v.overlay ? (v['use-code'] ? set.codes.filter(c => codesOf(v).includes(c)).join(', ') : v.custom) : '';
    return {text: text ? `Overlay text: ${text}` : 'No overlay text: the redacted area is just a box.'};
  },
  toCommand(v) {
    const set = CODE_SETS.find(c => c.name === v.code) ?? CODE_SETS[0];
    return {command: 'redact.properties', params: {
      fill: v['no-fill'] ? null : rgbOf(v.fill, [0, 0, 0]), useOverlay: !!v.overlay, overlay: String(v.custom ?? ''), useCode: !!v['use-code'], codeSet: set.id,
      codes: codesOf(v), font: FONTS[v.font] ?? 'Helv', size: v.auto ? 0 : Number(v.size), color: rgbOf(v['font-color'], [1, 0, 0]),
      align: Math.max(0, ALIGN.indexOf(v.align)), repeat: !!v.repeat, outline: rgbOf(v.outline, [0.89, 0.13, 0.13]), hoverFill: rgbOf(v['mark-fill'], [0.89, 0.13, 0.13]),
      opacity: Math.min(1, Math.max(0, (Number(v.opacity) || 100) / 100))}};
  },
});
