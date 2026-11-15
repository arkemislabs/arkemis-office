// Home › Paragraph › Numbering › Set Numbering Value… (submit: para.setNumberingValue).
// Word's Set Numbering Value (office source: Start new list, Set value to, Preview) over wordcraft
// crates/engine/src/cmd/tools/specs.rs `para.setNumberingValue {value}` (a new list instance from
// the caret's paragraph) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {peek, focusOf} from '../lib/format-target.mjs';
import {levelOf} from '../lib/para-lists.mjs';
import {formatNumber} from '../model/numfmt.mjs';

export default defineDialog({
  id: 'dialog.setNumberingValue',
  title: 'Set Numbering Value',
  command: 'para.setNumberingValue',
  init(ctx) {
    const d = peek(ctx);
    const n = d.paraAt(focusOf(ctx, d))?.props?.numbering ?? null;
    const lvl = n && n.num ? levelOf(d.numbering, n.num, n.level) : null;
    return {value: lvl?.start ?? 1, _format: lvl?.format ?? 'decimal', _text: lvl?.text ?? '%1.', _level: n?.level ?? 0};
  },
  validate(v) {
    return Number.isInteger(v.value) && v.value >= 0 && v.value <= 100_000 ? [] : [{field: 'value', message: 'The number must be between 0 and 100000.'}];
  },
  preview(ctx, v) {
    const k = (v._level ?? 0) + 1;
    const label = String(v._text ?? '%1.').replace(new RegExp(`%${k}`, 'g'), formatNumber(v._format ?? 'decimal', Number.isInteger(v.value) ? v.value : 1)).replace(/%[1-9]/g, '1');
    return {kind: 'numbers', labels: [label]};
  },
  toCommand(v) { return {command: 'para.setNumberingValue', params: {value: v.value}}; },
});
