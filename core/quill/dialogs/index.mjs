// References › Index › Insert Index (submit: references.index). Translated from wordcraft
// crates/ui-egui/src/dialogs/dialogs_refs/index.rs (`IndexForm` read/params, `index_ui`) at
// aadb077e072b7de05f724e359d8db82e151f125c: it reads the INDEX field that is there.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {indexField} from '../lib/references-lists.mjs';
import {parseField, fieldHas, fieldArg} from '../lib/references-toc.mjs';
import {BODY} from '../model/document.mjs';

/** IndexForm::read. */
export function indexValues(ctx) {
  const d = T.open(ctx).d;
  const at = indexField(d);
  const f = at ? parseField(at[1]) : parseField('INDEX \\h "A"');
  const entry = at ? d.para(BODY, [at[0] + 1]) : null;
  const leader = entry?.props?.tabs?.at(-1)?.leader;
  return {type: fieldHas(f, 'r') ? 'runIn' : 'indented', columns: Math.min(4, Math.max(1, Number.parseInt(fieldArg(f, 'c') ?? '1', 10) || 1)),
    rightAlign: fieldHas(f, 'e'), tabLeader: ['none', 'hyphen', 'underscore'].includes(leader) ? leader : 'dot', headings: fieldHas(f, 'h')};
}

export default defineDialog({
  id: 'dialog.index',
  title: 'Index',
  command: 'references.index',
  init: indexValues,
  validate(v) {
    const n = Number(v.columns);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? [] : [{field: 'columns', message: 'Enter a number from 1 to 4.'}];
  },
  toCommand: v => ({command: 'references.index', params: {type: v.type === 'runIn' ? 'runIn' : 'indented', columns: Number(v.columns), rightAlign: !!v.rightAlign,
    tabLeader: v.tabLeader ?? 'dot', headings: !!v.headings}}),
});
