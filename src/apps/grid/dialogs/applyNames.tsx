// Apply Names as Excel draws it: the defined names in a list (several can be picked), Ignore Relative/Absolute and Use row and column names, and
// the Options >> part with Omit column name if same column, Omit row name if same row and Name order. Not in gridcraft (not checked against upstream).

import {useState} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, Buttons, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const list = (d.values.list ?? []) as {name: string; refersTo: string}[];
  const picked = (d.values.names ?? []) as string[];
  const [more, setMore] = useState(false);
  const error = d.errors.find(e => e.field === 'names')?.message ?? null;
  const toggle = (name: string) => setValue('names', list.map(x => x.name).filter(n => (n === name ? !picked.includes(n) : picked.includes(n))));
  const on = (id: string) => d.values[id] !== false;
  const check = (id: string, label: string) => <div className="sf sf-check" data-kind="checkbox" data-field-id={id}>
    <label><input type="checkbox" checked={on(id)} onChange={e => setValue(id, e.target.checked)}/><span className="sf-check-box" aria-hidden="true"/><span>{label}</span></label>
  </div>;
  return <div className="gd-fields">
    <span className="sf-label">Apply names:</span>
    <div className="sf-list" role="listbox" aria-multiselectable="true" aria-label="Names" data-field-id="names" style={{height: 150, overflowY: 'auto'}}>
      {list.map(x => <div key={x.name} role="option" aria-selected={picked.includes(x.name)} className={`sf-list-item${picked.includes(x.name) ? ' is-selected' : ''}`} onClick={() => toggle(x.name)} title={x.refersTo}>{x.name}</div>)}
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
    {check('ignoreRelAbs', 'Ignore Relative/Absolute')}
    {check('useRowColumn', 'Use row and column names')}
    <Buttons><Btn onClick={() => setMore(!more)}>{more ? 'Options <<' : 'Options >>'}</Btn></Buttons>
    {more ? <>
      {check('omitColumn', 'Omit column name if same column')}
      {check('omitRow', 'Omit row name if same row')}
      <Fld d={d} set={setValue} id="nameOrder" kind="select" label="Name order" options={[{value: 'rowColumn', label: 'Row Column'}, {value: 'columnRow', label: 'Column Row'}]}/>
    </> : null}
  </div>;
}

export default {Body};
