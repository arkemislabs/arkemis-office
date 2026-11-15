// Subtotal as Excel draws it: At each change in (a column), Use function, Add subtotal to (a check list of the range's columns).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (Subtotal) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, columnLabel, indexToLetters, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const heads = (d.values.heads ?? []) as string[];
  const startCol = Number(d.values.startCol ?? 0);
  const header = d.values.header !== false;
  const checked = (d.values.columns ?? []) as string[];
  const letters = heads.map((_, i) => indexToLetters(startCol + i));
  const options = letters.map(l => ({value: l, label: columnLabel(l, heads, startCol, header)}));
  const error = d.errors.find(e => e.field === 'columns')?.message ?? null;
  const toggle = (l: string, on: boolean) => setValue('columns', letters.filter(x => (x === l ? on : checked.includes(x))));
  return <div className="gd-fields">
    <Fld d={d} set={setValue} id="groupBy" kind="select" label="At each change in:" options={options}/>
    <Fld d={d} set={setValue} id="function" kind="select" label="Use function:" options={[['sum', 'Sum'], ['count', 'Count'], ['average', 'Average'], ['max', 'Max'], ['min', 'Min'], ['product', 'Product']].map(([value, label]) => ({value, label}))}/>
    <div className="sf" data-field-id="columns" data-kind="list">
      <span className="sf-label">Add subtotal to:</span>
      <div className="data-checks" role="group" aria-label="Add subtotal to">
        {letters.map(l => <div key={l} className="sf sf-check" data-kind="checkbox">
          <label><input type="checkbox" checked={checked.includes(l)} onChange={e => toggle(l, e.target.checked)}/><span className="sf-check-box" aria-hidden="true"/><span>{columnLabel(l, heads, startCol, header)}</span></label>
        </div>)}
      </div>
      {error ? <small className="sf-error" role="alert">{error}</small> : null}
    </div>
  </div>;
}

export default {Body};
