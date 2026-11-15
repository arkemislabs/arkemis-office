// Report Connections as Excel draws it: the workbook's PivotTables, each with a check box for the ones the slicer filters.
// Not in gridcraft (not checked against upstream).

import type {DialogState} from '../../../shell/dialogs/dialogState';
import type {SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const pivots = (d.values.pivots ?? []) as {name: string; sheet: string}[];
  const on = (d.values.connected ?? []) as string[];
  const error = d.errors.find(e => e.field === 'connected')?.message ?? null;
  const toggle = (name: string, v: boolean) => setValue('connected', pivots.map(p => p.name).filter(n => (n === name ? v : on.includes(n))));
  return <div className="gd-fields">
    <p className="sf-note" style={{margin: 0}}>Choose the PivotTables that {String(d.values.caption ?? 'the slicer')} filters.</p>
    <div className="data-checks" role="group" aria-label="PivotTables" data-field-id="connected">
      {pivots.map(p => <div key={p.name} className="sf sf-check" data-kind="checkbox">
        <label><input type="checkbox" checked={on.includes(p.name)} onChange={e => toggle(p.name, e.target.checked)}/><span className="sf-check-box" aria-hidden="true"/><span>{p.name} ({p.sheet})</span></label>
      </div>)}
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
