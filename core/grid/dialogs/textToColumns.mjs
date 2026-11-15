// Convert Text to Columns Wizard model (submit: data.textToColumns).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (Text to Columns: the delimiters Tab,
// Semicolon, Comma, Space and Other, Destination) at 146161b4b450a56e5e59a083ba0478582d1e602b, with
// Excel's three steps: Delimited or Fixed width, the delimiters with Treat consecutive delimiters as
// one and a Text qualifier, and a Column data format per column with the Destination.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: range (the first column of the selection), lines (its first 100 texts), step 1..3,
// dataType delimited|fixed, tab/semicolon/comma/space, other, treatConsecutive, textQualifier,
// breaks (fixed-width break positions), formats (per output column: general|text|skip), destination.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1, rangeA1, rangeOf} from '../lib/addr.mjs';
import {display} from '../lib/value.mjs';
import {engineFor} from '../model/calc.mjs';
import {usedBounds} from '../model/store.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {valueOf, baseDoc} from '../lib/data-common.mjs';

export default defineDialog({
  id: 'dialog.textToColumns',
  title: 'Convert Text to Columns Wizard',
  command: 'data.textToColumns',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    const cur = sel.ranges[sel.ranges.length - 1];
    const u = usedBounds(content.sheets[sel.sheet]);
    const last = Math.min(cur.end.row, u ? u.r1 : cur.start.row);
    const range = rangeOf(cur.start.row, cur.start.col, Math.max(last, cur.start.row), cur.start.col);
    const engine = engineFor(content);
    const lines = [];
    for (let r = range.start.row; r <= range.end.row && lines.length < 100; r++) lines.push(display(valueOf(engine, sel.sheet, r, range.start.col)));
    return {range: rangeA1(range), lines, step: 1, dataType: 'delimited', tab: true, semicolon: false, comma: false, space: false, other: '',
      treatConsecutive: false, textQualifier: '"', breaks: [], formats: [], column: 0, destination: a1(range.start.row, range.start.col)};
  },
  validate(v) {
    const out = [];
    if (!String(v.destination ?? '').trim()) out.push({field: 'destination', message: 'Enter the destination cell.'});
    if (v.dataType !== 'fixed' && !(v.tab || v.semicolon || v.comma || v.space || String(v.other ?? '').length)) out.push({field: 'tab', message: 'Choose at least one delimiter.'});
    return out;
  },
  toCommand(v) {
    const p = {range: v.range, destination: String(v.destination).trim()};
    if (v.dataType === 'fixed') p.fixedWidths = [...(v.breaks ?? [])].sort((a, b) => a - b);
    else {
      p.delimiters = [v.tab ? '\t' : '', v.semicolon ? ';' : '', v.comma ? ',' : '', v.space ? ' ' : ''].filter(Boolean);
      if (String(v.other ?? '')) p.other = String(v.other);
      p.treatConsecutive = v.treatConsecutive === true;
      p.textQualifier = v.textQualifier === '{none}' ? 'none' : String(v.textQualifier || '"');
    }
    const formats = (v.formats ?? []).map(f => (f === 'text' || f === 'skip' ? f : 'general'));
    if (formats.some(f => f !== 'general')) p.columnFormats = formats;
    return {command: 'data.textToColumns', params: p};
  },
});
