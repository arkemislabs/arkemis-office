// Check for Errors view (Mailings › Preview Results): "No errors found" or the merge fields that are not
// in the recipient list, and how many recipients there are, over core/quill/dialogs/checkErrors.mjs.
// Layout from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`check_errors_dialog`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import './recipientList.css';

function Body({dialog: d}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const unknown = (d.values.unknown as string[]) ?? [];
  const records = Number(d.values.records ?? 0);
  return <div className="gd-fields" data-dialog-page="Check for Errors">
    {unknown.length
      ? <>
        <p className="sf sf-static">These merge fields aren't in the recipient list:</p>
        <div className="rl-list" data-field-id="result" role="list">{unknown.map(f => <div key={f} className="rl-item rl-err" role="listitem">• {f}</div>)}</div>
      </>
      : <p className="sf sf-static" data-field-id="result">No errors found: every merge field is in the recipient list.</p>}
    <p className="rl-weak" data-field-id="count">Recipients: {records}</p>
  </div>;
}

export default {Body};
