// Error Checking Options dialog model (Error Checking > Options...; command formulas.resetIgnoredErrors): what Excel's Options has that this app can do: the number of
// errors ignored so far and Reset Ignored Errors. The background rules (which formulas are flagged) have no settings here. Not in gridcraft: not checked against upstream.
//
// Values: ignored (the cells ignored, "Sheet1!A1").

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {quoteSheet} from '../lib/addr.mjs';

export default defineDialog({
  id: 'dialog.errorCheckingOptions',
  title: 'Error Checking Options',
  command: 'formulas.resetIgnoredErrors',
  init: ctx => ({ignored: baseDoc(ctx).sheets.flatMap(sh => (sh.ignoredErrors ?? []).map(r => `${quoteSheet(sh.name)}!${r}`))}),
  validate: v => ((v.ignored ?? []).length ? [] : [{field: 'ignored', message: 'No errors are ignored.'}]),
  toCommand: () => ({command: 'formulas.resetIgnoredErrors', params: {}}),
});
