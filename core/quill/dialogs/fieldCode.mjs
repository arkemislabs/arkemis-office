// Right-click a field › Edit Field…: the selected field's code (submit: fields.setCode, which then
// updates fields). Translated from wordcraft crates/engine/src/cmd/fields.rs (`selected`, `set_code`)
// at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {selectedFields} from '../commands/fields.mjs';

export default defineDialog({
  id: 'dialog.fieldCode',
  title: 'Edit Field',
  command: 'fields.setCode',
  init(ctx) {
    const S = T.open(ctx);
    return {code: selectedFields(S.d, S.sel)[0]?.instr?.trim() ?? ''};
  },
  validate: v => (String(v.code ?? '').trim() ? [] : [{field: 'code', message: 'Type a field code.'}]),
  toCommand: v => ({command: 'fields.setCode', params: {code: String(v.code).trim()}}),
});
