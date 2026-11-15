// Filter Connections as Excel draws it: the PivotTable slicers, each with a check box for the ones that filter this PivotTable.
// Not in gridcraft (not checked against upstream).

import type {DialogState} from '../../../shell/dialogs/dialogState';
import type {SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const slicers = (d.values.slicers ?? []) as {id: number; caption: string; field: string; sheet: string}[];
  const on = (d.values.connected ?? []) as number[];
  const toggle = (id: number, v: boolean) => setValue('connected', slicers.map(s => s.id).filter(i => (i === id ? v : on.includes(i))));
  return <div className="gd-fields">
    <p className="sf-note" style={{margin: 0}}>Choose the slicers that filter {String(d.values.pivot ?? 'this PivotTable')}.</p>
    <div className="data-checks" role="group" aria-label="Slicers" data-field-id="connected">
      {slicers.map(s => <div key={s.id} className="sf sf-check" data-kind="checkbox">
        <label><input type="checkbox" checked={on.includes(s.id)} onChange={e => toggle(s.id, e.target.checked)}/><span className="sf-check-box" aria-hidden="true"/><span>{s.caption} ({s.sheet})</span></label>
      </div>)}
    </div>
  </div>;
}

export default {Body};
