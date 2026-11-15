// Home › Paragraph › Numbering › Define New Number Format… (submit: para.defineNumber).
// Word's Define New Number Format (office source: Number style, Number format with the number
// shown in it, Preview) over wordcraft crates/engine/src/cmd/tools/specs.rs:320 `para.defineNumber
// {format, text, start}` at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {formatNumber} from '../model/numfmt.mjs';

/** The label `text` gives number `n` in `format` (%1 stands for the number). */
export const numberLabel = (format, text, n) => String(text ?? '%1.').replace(/%1/g, formatNumber(format ?? 'decimal', n));

export default defineDialog({
  id: 'dialog.defineNumber',
  title: 'Define New Number Format',
  command: 'para.defineNumber',
  init() { return {format: 'decimal', text: '%1.', start: 1}; },
  derive(v, changed) {
    // Word keeps the punctuation and puts the new style's number in place of %1.
    if (changed.includes('format') && !String(v.text ?? '').includes('%1')) return {text: `%1${v.text ?? '.'}`};
    return {};
  },
  validate(v) {
    const out = [];
    if (typeof v.text !== 'string' || !v.text.includes('%1')) out.push({field: 'text', message: 'The number format must include the number (%1).'});
    else if (v.text.length > 64) out.push({field: 'text', message: 'The number format is too long.'});
    if (!Number.isInteger(v.start) || v.start < 0 || v.start > 100_000) out.push({field: 'start', message: 'The number must be between 0 and 100000.'});
    return out;
  },
  preview(ctx, v) {
    const start = Number.isInteger(v.start) ? v.start : 1;
    return {kind: 'numbers', labels: [0, 1, 2].map(i => numberLabel(v.format, v.text, Math.max(1, start + i)))};
  },
  toCommand(v) { return {command: 'para.defineNumber', params: {format: v.format, text: v.text, start: v.start}}; },
});
