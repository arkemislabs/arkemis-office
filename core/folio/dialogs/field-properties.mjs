// Field Properties (spec dialog.field-properties; one field, or Shared Field Properties when several
// fields are selected): the tabs General, Appearance, Position, Options, Format, Validate, Calculate
// and Actions by field kind. OK applies every change as one edit (form.field.properties).
//
// Translated from printcraft crates/ui-egui/src/tools/prepare/{draft,properties,tabs}.rs (FieldDraft,
// tabs by kind, Options per kind, Locked) and tools/bulk_fields.rs (Draft::new: only the properties
// changed apply) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The body is src/apps/folio/dialogs/field-properties.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {draftOf, propsOf, problemsOf, bulkInit, bulkProps} from '../lib/form-dialog.mjs';

const fieldsOf = ctx => (Array.isArray(ctx.doc?.fields) ? ctx.doc.fields : []);

/** The fields the window acts on: the selection (view.formSel), else the calculation order's pick. */
export function targetsOf(ctx) {
  const all = fieldsOf(ctx);
  const sel = (Array.isArray(ctx.view?.formSel) ? ctx.view.formSel : []).filter(s => all.some(f => f.name === s.name && s.widget < f.widgets.length));
  if (!sel.length && ctx.view?.calcSel && all.some(f => f.name === ctx.view.calcSel)) return [{name: ctx.view.calcSel, widget: 0}];
  return sel;
}

export default defineDialog({
  id: 'dialog.field-properties',
  title: 'Field Properties',
  command: 'form.field.properties',
  init(ctx) {
    const all = fieldsOf(ctx);
    const sel = targetsOf(ctx);
    if (!sel.length) throw new CommandError('invalid_params', 'Select a field first.', {path: '/name'});
    const names = [...new Set(sel.map(s => s.name))];
    if (names.length > 1) {
      const v = bulkInit(names.map(n => all.find(f => f.name === n)));
      return {...v, __bulk: true, __title: 'Shared Field Properties', __orig: structuredClone(v)};
    }
    const f = all.find(x => x.name === names[0]);
    const d = draftOf(f, sel[0].widget, all.filter(x => x.name !== f.name).map(x => x.name));
    return {...d, __orig: structuredClone(d), __tab: ctx.view?.calcOrder ? 'Calculate' : 'General'};
  },
  validate(v) {
    if (v.__bulk) return [];
    return problemsOf(v, v.__orig);
  },
  toCommand(v) {
    if (v.__bulk) return {command: 'form.field.properties', params: {names: v.names, props: bulkProps(v, v.__orig)}};
    return {command: 'form.field.properties', params: {name: v.field, props: propsOf(v, v.__orig)}};
  },
});
