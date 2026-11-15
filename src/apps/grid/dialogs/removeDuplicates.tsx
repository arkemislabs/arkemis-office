// Remove Duplicates as Excel draws it: "My data has headers" and a check list of the range's columns
// with Select All and Unselect All (gridcraft takes a comma list of columns).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (Remove Duplicates) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Buttons, Fld, columnLabel, indexToLetters, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const heads = (d.values.heads ?? []) as string[];
  const startCol = Number(d.values.startCol ?? 0);
  const header = d.values.header === true;
  const checked = (d.values.columns ?? []) as string[];
  const letters = heads.map((_, i) => indexToLetters(startCol + i));
  const error = d.errors.find(e => e.field === 'columns')?.message ?? null;
  const toggle = (l: string, on: boolean) => setValue('columns', letters.filter(x => (x === l ? on : checked.includes(x))));
  return <div className="gd-fields">
    <p className="sf-note" style={{margin: 0}}>To delete duplicate values, select one or more columns that contain duplicates.</p>
    <Buttons>
      <Btn onClick={() => setValue('columns', letters)}>Select All</Btn>
      <Btn onClick={() => setValue('columns', [])}>Unselect All</Btn>
    </Buttons>
    <Fld d={d} set={setValue} id="header" kind="checkbox" label="My data has headers"/>
    <div className="data-checks" role="group" aria-label="Columns" data-field-id="columns">
      {letters.map(l => <div key={l} className="sf sf-check" data-kind="checkbox">
        <label><input type="checkbox" checked={checked.includes(l)} onChange={e => toggle(l, e.target.checked)}/><span className="sf-check-box" aria-hidden="true"/><span>{columnLabel(l, heads, startCol, header)}</span></label>
      </div>)}
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
