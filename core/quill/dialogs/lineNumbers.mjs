// Layout › Line Numbers › Line Numbering Options… (and Page Setup › Layout › Line Numbers…): Word's
// Line Numbers dialog over the section of the selection. OK runs one layout.lineNumbers.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/text.rs (`LineNumbersForm`
// `read`, `params`, `line_numbers_ui`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. From text is in inches.

import {defineDialog} from '../../kernel/dialog.mjs';
import {caretSection} from '../commands/page.mjs';

const IN = 72;
const RESTART = {page: 'restartPage', section: 'restartSection', continuous: 'continuous'};
const isNum = v => typeof v === 'number' && Number.isFinite(v);

export function readLineNumbers(ctx) {
  const {x} = caretSection(ctx);
  const l = x.lineNumbers;
  const cur = {countBy: 1, start: 1, distance: 0, restart: 'page', ...(l ?? {})};
  return {
    on: !!l,
    start: Math.max(1, cur.start),
    auto: !(cur.distance > 0),
    fromText: cur.distance > 0 ? Math.round((cur.distance / IN) * 100) / 100 : 0.25,
    countBy: Math.max(1, cur.countBy),
    restart: RESTART[cur.restart] ?? 'restartPage',
  };
}

/** `layout.lineNumbers` parameters (params). */
export function lineNumbersParams(v) {
  if (!v.on) return {value: 'none'};
  const distance = v.auto ? 0 : Math.max(0, (isNum(v.fromText) ? v.fromText : 0) * IN);
  return {value: v.restart, start: v.start, countBy: v.countBy, distance};
}

export default defineDialog({
  id: 'dialog.lineNumbers',
  title: 'Line Numbers',
  command: 'layout.lineNumbers',
  init: ctx => readLineNumbers(ctx),
  validate(v) {
    const out = [];
    if (!v.on) return out;
    if (!Number.isInteger(v.start) || v.start < 1 || v.start > 32_767) out.push({field: 'start', message: 'Enter a number from 1 to 32767.'});
    if (!Number.isInteger(v.countBy) || v.countBy < 1 || v.countBy > 100) out.push({field: 'countBy', message: 'Enter a number from 1 to 100.'});
    if (!v.auto && (!isNum(v.fromText) || v.fromText < 0 || v.fromText > 22)) out.push({field: 'fromText', message: 'The measurement must be between 0" and 22".'});
    if (!['restartPage', 'restartSection', 'continuous'].includes(v.restart)) out.push({field: 'restart', message: 'Choose how to number.'});
    return out;
  },
  toCommand: v => ({batch: [{command: 'layout.lineNumbers', params: lineNumbersParams(v)}]}),
});
