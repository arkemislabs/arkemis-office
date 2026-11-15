// Shared Field Properties (spec dialog.bulk-field-properties): several fields at once; only the
// properties changed apply (printcraft tools/bulk_fields.rs). Field Properties (dialog.field-properties)
// opens this form's body itself when several fields are selected.
// Translated from printcraft crates/ui-egui/src/tools/bulk_fields.rs at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {bulkInit, bulkProps} from '../lib/form-dialog.mjs';
import {targetsOf} from './field-properties.mjs';

export default defineDialog({
  id: 'dialog.bulk-field-properties',
  title: 'Shared Field Properties',
  command: 'form.field.properties',
  init(ctx) {
    const all = Array.isArray(ctx.doc?.fields) ? ctx.doc.fields : [];
    const names = [...new Set(targetsOf(ctx).map(s => s.name))];
    if (names.length < 2) throw new CommandError('invalid_params', 'Select two or more fields first.', {path: '/names'});
    const v = bulkInit(names.map(n => all.find(f => f.name === n)));
    return {...v, __bulk: true, __title: 'Shared Field Properties', __orig: structuredClone(v)};
  },
  validate: () => [],
  toCommand: v => ({command: 'form.field.properties', params: {names: v.names, props: bulkProps(v, v.__orig)}}),
});
