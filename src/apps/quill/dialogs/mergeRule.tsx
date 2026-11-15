// Merge rule view (Mailings › Rules › If…Then…Else… / Skip Record If… / Next Record If…): a sentence
// saying what the rule does, the Field (from the recipient list, or typed when there is no list),
// Equals, and for If the Then insert and Otherwise insert texts, over core/quill/dialogs/mergeRule.mjs.
// The rule is the one the opening control named (dialog.args.rule). Layout from wordcraft
// crates/ui-egui/src/dialogs/dispatch.rs (`merge_rule_dialog`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Field} from './font';

function Body({dialog: d, setValue: set}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const rule = String(d.args?.rule ?? 'IF').toUpperCase();
  const fields = (d.values.fields as string[]) ?? [];
  const text = rule === 'SKIPIF' ? 'Leave a recipient out of the merge when a field has this value.'
    : rule === 'NEXTIF' ? 'Go on to the next recipient in this document when a field has this value.'
      : 'Insert one text or another, depending on a field\'s value.';
  return <div className="gd-fields" data-dialog-page="Rule" data-rule={rule}>
    <p className="sf sf-static">{text}</p>
    {fields.length ? <Field d={d} id="field" set={set} options={fields.map(f => ({value: f, label: f}))}/> : <Field d={d} id="field" set={set} override="text"/>}
    <Field d={d} id="value" set={set}/>
    {rule === 'IF' ? <>
      <Field d={d} id="then" set={set}/>
      <Field d={d} id="else" set={set}/>
    </> : null}
  </div>;
}

export default {Body};
