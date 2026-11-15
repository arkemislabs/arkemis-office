// Apply Names dialog model (Formulas > Define Name > Apply Names; submit: formulas.applyNames): Excel's list of the defined names to pick from,
// Ignore Relative/Absolute, Use row and column names and (behind Options) Omit column name if same column, Omit row name if same row and
// Name order. Not in gridcraft: Excel's own behaviour, not checked against upstream.
//
// Values: list (the names that can be applied, [{name, refersTo}]), names (the ones picked), ignoreRelAbs, useRowColumn, omitColumn, omitRow,
// nameOrder (rowColumn | columnRow).

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc, failed} from '../lib/data-common.mjs';
import {pasteableNames} from '../lib/formulas-names.mjs';

export default defineDialog({
  id: 'dialog.applyNames',
  title: 'Apply Names',
  command: 'formulas.applyNames',
  init(ctx) {
    const list = pasteableNames(baseDoc(ctx), gridSel(ctx).sheet).map(([name, refersTo]) => ({name, refersTo}));
    if (!list.length) throw failed('This workbook has no names to apply.');
    return {list, names: [], ignoreRelAbs: true, useRowColumn: true, omitColumn: true, omitRow: true, nameOrder: 'rowColumn'};
  },
  validate: v => ((v.names ?? []).length ? [] : [{field: 'names', message: 'Select at least one name to apply.'}]),
  toCommand: v => ({command: 'formulas.applyNames', params: {names: v.names, ignoreRelAbs: v.ignoreRelAbs !== false, useRowColumn: v.useRowColumn !== false,
    omitColumn: v.omitColumn !== false, omitRow: v.omitRow !== false, nameOrder: v.nameOrder === 'columnRow' ? 'columnRow' : 'rowColumn'}}),
});
