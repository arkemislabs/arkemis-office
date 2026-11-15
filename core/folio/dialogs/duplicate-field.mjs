// Duplicate Field (right-click a field, Duplicate…): which pages get a copy of the field.
// Translated from printcraft crates/ui-egui/src/dialogs.rs (DuplicateField: All pages or From / to,
// `DuplicateDraft { all: true, from: 1, to: pages }`) and canvas.rs:3209 at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {targetsOf} from './field-properties.mjs';

const countOf = ctx => (ctx.doc?.pages ?? []).length;

export default defineDialog({
  id: 'dialog.duplicate-field',
  title: 'Duplicate Field',
  command: 'form.field.duplicate',
  init(ctx) {
    const sel = targetsOf(ctx);
    if (!sel.length) throw new CommandError('invalid_params', 'Select a field first.', {path: '/name'});
    return {name: sel[0].name, scope: 'All pages', from: 1, to: countOf(ctx), __count: countOf(ctx)};
  },
  validate(v) {
    if (v.scope !== 'From') return [];
    const out = [];
    if (!(v.from >= 1 && v.from <= v.__count)) out.push({field: 'from', message: `Pages go from 1 to ${v.__count}`});
    if (!(v.to >= v.from && v.to <= v.__count)) out.push({field: 'to', message: `To must be from ${v.from} to ${v.__count}`});
    return out;
  },
  toCommand(v) {
    const from = v.scope === 'From' ? v.from : 1, to = v.scope === 'From' ? v.to : v.__count;
    return {command: 'form.field.duplicate', params: {name: v.name, pages: Array.from({length: to - from + 1}, (_, i) => from + i)}};
  },
});
