// Insert Merge Field view (Mailings › Write & Insert Fields): the recipient list's fields to pick
// from and the Field box (a name may be typed), over core/quill/dialogs/insertMergeField.mjs. With no
// recipients it says to select them first. Layout from wordcraft crates/ui-egui/src/dialogs/dispatch.rs
// (`insert_merge_field_dialog`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Field} from './font';
import './recipientList.css';

function Body({dialog: d, setValue: set}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const fields = (d.values.fields as string[]) ?? [];
  const current = String(d.values.field ?? '');
  return <div className="gd-fields" data-dialog-page="Insert Merge Field">
    {fields.length
      ? <div className="sf" data-field-id="fields">
        <span className="sf-label">Fields:</span>
        <div className="rl-list" role="listbox" aria-label="Fields" tabIndex={0}>
          {fields.map(f => <div key={f} role="option" aria-selected={f === current} className={`rl-item${f === current ? ' is-selected' : ''}`} data-option={f} onClick={() => set('field', f)}>{f}</div>)}
        </div>
      </div>
      : <p className="sf sf-static rl-weak" style={{marginBottom: 12}}>Select recipients first to choose from their fields.</p>}
    <div style={{marginTop: 10}}><Field d={d} id="field" set={set}/></div>
  </div>;
}

export default {Body};
