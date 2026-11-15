// Insert Timelines as Excel draws it: a check list of the date fields of the PivotTable; each checked field gets its own timeline.
// Not in gridcraft: Excel's behaviour, not checked against upstream.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import type {SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const heads = (d.values.heads ?? []) as string[];
  const checked = (d.values.columns ?? []) as string[];
  const error = d.errors.find(e => e.field === 'columns')?.message ?? null;
  const toggle = (name: string, on: boolean) => setValue('columns', heads.filter(h => (h === name ? on : checked.includes(h))));
  return <div className="gd-fields">
    <div className="data-checks" role="group" aria-label="Date fields" data-field-id="columns">
      {heads.map(h => <div key={h} className="sf sf-check" data-kind="checkbox">
        <label><input type="checkbox" checked={checked.includes(h)} onChange={e => toggle(h, e.target.checked)}/><span className="sf-check-box" aria-hidden="true"/><span>{h}</span></label>
      </div>)}
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
