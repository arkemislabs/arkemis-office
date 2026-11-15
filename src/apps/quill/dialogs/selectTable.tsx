// Select Table view (Mailings › Select Recipients › Use an Existing List… with a workbook of several
// sheets): the sheets to choose from (a double-click picks one) and "First row of data contains column
// headers", over core/quill/dialogs/selectTable.mjs. Layout from wordcraft crates/ui-egui/src/dialogs/
// dispatch.rs (`select_table_dialog`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import './recipientList.css';

function Body({dialog: d, setValue: set}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const sheets = (d.values.sheets as string[]) ?? [];
  const selected = Number(d.values.selected ?? 0);
  return <div className="gd-fields" data-dialog-page="Select Table">
    <p className="sf sf-static">Choose the sheet that holds the recipients.</p>
    <div className="rl-list" data-field-id="sheets" role="listbox" aria-label="Sheets" tabIndex={0} style={{minHeight: 132, margin: "6px 0 10px"}}>
      {sheets.map((name, i) => <div key={i} role="option" aria-selected={i === selected} className={`rl-item${i === selected ? ' is-selected' : ''}`} data-option={name}
        onClick={() => set('selected', i)}
        onDoubleClick={() => { set('selected', i); void controller.submitDialog(d.key).catch(e => controller.notify(toCommandError(e).message, 'error')); }}>{name}</div>)}
    </div>
    <div className="sf sf-check" data-field-id="headers" data-kind="checkbox">
      <label>
        <input type="checkbox" checked={d.values.headers !== false} onChange={e => set('headers', e.target.checked)}/>
        <span className="sf-check-box" aria-hidden="true"/>
        <span>First row of data contains column headers</span>
      </label>
    </div>
  </div>;
}

export default {Body};
