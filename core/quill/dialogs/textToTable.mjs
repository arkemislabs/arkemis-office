// Insert › Table › Convert Text to Table (submit: table.fromText).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/table.rs (`TextToTableForm`:
// read (tabs when the text has them, else paragraphs), sep, guess_columns, count_rows, width_pt,
// check ("The measurement must be between 0" and 22"."), params) at
// aadb077e072b7de05f724e359d8db82e151f125c. Inches are the measure. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {textTableCells, textTableLines} from '../commands/table.mjs';

const SEP = {comma: ',', tab: '\t'};
const sepOf = v => (v.separator === 'other' ? (String(v.other ?? '')[0] ?? '-') : SEP[v.separator] ?? null);
const int = v => (typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v ?? ''), 10));

/** The initial column width in points: 0 for Auto, null when it isn't 0 to 22 inches (width_pt). */
export function widthPt(text) {
  const s = String(text ?? '').trim();
  if (!s || /^auto$/i.test(s)) return 0;
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(in|"|cm|mm|pt|pi)?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const k = {in: 72, '"': 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1, pi: 12}[(m[2] ?? 'in').toLowerCase()];
  const pt = n * k;
  return pt >= 0 && pt <= 22 * 72 ? pt : null;
}

/** The column count the text gives with the separator (guess_columns) and the row count (count_rows). */
function counted(v, guess) {
  const lines = v.lines ?? [];
  if (guess) {
    const cols = Math.max(1, Math.min(textTableCells(lines, sepOf(v), null)[1], 63));
    return {cols, rows: textTableCells(lines, sepOf(v), cols)[0].length};
  }
  return {rows: textTableCells(lines, sepOf(v), Math.max(1, int(v.cols) || 1))[0].length};
}

export default defineDialog({
  id: 'dialog.textToTable',
  title: 'Convert Text to Table',
  command: 'table.fromText',
  init(ctx) {
    const lines = textTableLines(T.open(ctx));
    const v = {lines, cols: 1, rows: 0, autofit: 'initial', width: 'Auto', separator: lines.some(l => l.includes('\t')) ? 'tab' : 'paragraph', other: '-'};
    return {...v, ...counted(v, true)};
  },
  derive(v, changed) {
    if (changed.includes('other') && v.separator !== 'other') return {separator: 'other', ...counted({...v, separator: 'other'}, true)};
    if (changed.includes('separator') || changed.includes('other')) return counted(v, true);
    if (changed.includes('cols')) return counted(v, false);
    return {};
  },
  validate(v) {
    const out = [];
    const c = int(v.cols);
    if (!(c >= 1 && c <= 63)) out.push({field: 'cols', message: 'The number must be between 1 and 63.'});
    if (v.autofit === 'initial' && widthPt(v.width) === null) out.push({field: 'width', message: 'The measurement must be between 0" and 22".'});
    if (v.separator === 'other' && !String(v.other ?? '')) out.push({field: 'other', message: 'Type the character that separates the text.'});
    return out;
  },
  toCommand(v) {
    const params = {separator: v.separator, columns: int(v.cols), autofit: v.autofit};
    if (v.separator === 'other') params.char = String(v.other)[0];
    const w = v.autofit === 'initial' ? widthPt(v.width) : null;
    if (w) params.width = w;
    return {command: 'table.fromText', params};
  },
});
