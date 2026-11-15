// Mailings › Write & Insert Fields › Rules › If…Then…Else… / Skip Record If… / Next Record If…: the
// field, what it equals and (for If) the text to insert when it does and when it does not. OK runs
// mailings.rules with the rule the opening control named (args.rule).
//
// Translated from wordcraft crates/ui-egui/src/dialogs/mailings.rs (`rule_params`) and
// dispatch.rs (`merge_rule_dialog`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Not here: Word's other comparisons (the
// engine's rule is "equals"). Drawn by src/apps/quill/dialogs/mergeRule.tsx.

import {defineDialog} from '../../kernel/dialog.mjs';
import {mergeOf} from '../lib/mailings-merge.mjs';

export default defineDialog({
  id: 'dialog.mergeRule',
  title: 'Insert Field: If',
  command: 'mailings.rules',
  init(ctx) {
    const fields = mergeOf(ctx).headers;
    return {fields, field: fields[0] ?? '', value: '', then: '', else: ''};
  },
  validate: v => (String(v.field ?? '').trim() ? [] : [{field: 'field', message: 'Choose a field.'}]),
  // The rule (IF, SKIPIF, NEXTIF) comes from the opener's args, which the shell merges under these params.
  toCommand: v => ({command: 'mailings.rules', params: {field: String(v.field).trim(), value: v.value ?? '', then: v.then ?? '', else: v.else ?? ''}}),
});
