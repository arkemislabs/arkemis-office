// Series dialog model (submit: edit.fillSeries).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (Series: Series in Rows/Columns, Type
// Linear/Growth/Date, Date unit, Step value, Stop value) at 146161b4b450a56e5e59a083ba0478582d1e602b,
// with Excel's AutoFill type and Trend. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {currentArea, fromKernelSelection} from '../model/workbook.mjs';

const num = v => (v === '' || v === null || v === undefined ? null : Number(String(v).trim()));

export default defineDialog({
  id: 'dialog.series',
  title: 'Series',
  command: 'edit.fillSeries',
  init(ctx) {
    // Excel proposes Rows when the selection is wider than tall.
    let rows = false;
    try {
      const r = currentArea(fromKernelSelection(ctx.doc, ctx.selection));
      rows = r.end.col - r.start.col > r.end.row - r.start.row;
    } catch { rows = false; }
    return {direction: rows ? 'rows' : 'columns', type: 'linear', dateUnit: 'day', trend: false, step: 1, stop: ''};
  },
  validate(v) {
    const out = [];
    if (!v.trend && v.type !== 'autoFill' && (v.step === null || v.step === undefined || !Number.isFinite(Number(v.step)))) out.push({field: 'step', message: 'Enter a step value'});
    const stop = num(v.stop);
    if (stop !== null && !Number.isFinite(stop)) out.push({field: 'stop', message: 'The stop value must be a number'});
    return out;
  },
  toCommand(v) {
    const type = v.type === 'autoFill' ? 'autofill' : (v.type ?? 'linear');
    const stop = num(v.stop);
    return {command: 'edit.fillSeries', params: {
      direction: v.direction === 'rows' ? 'rows' : 'columns', type, dateUnit: v.dateUnit ?? 'day',
      ...(type !== 'autofill' ? {step: Number(v.step ?? 1)} : {}),
      ...(stop !== null ? {stop} : {}),
      ...(v.trend && (type === 'linear' || type === 'growth') ? {trend: true} : {}),
    }};
  },
});
