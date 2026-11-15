// Consolidate as Excel draws it: Function, Reference with Add and Delete, All references, and the
// labels to use (Top row, Left column).
// Excel's dialog over gridcraft's cmd/whatif/consolidate.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, Rows, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const refs = (d.values.references ?? []) as string[];
  const selected = Number(d.values.selected ?? -1);
  const typed = String(d.values.reference ?? '').trim();
  const add = () => { if (typed && !refs.includes(typed)) { setValue('references', [...refs, typed]); setValue('reference', ''); setValue('selected', refs.length); } };
  const del = () => { if (selected >= 0) { setValue('references', refs.filter((_, i) => i !== selected)); setValue('selected', -1); } };
  return <div className="gd-fields">
    <Fld d={d} set={setValue} id="function" kind="select" label="Function:" options={[['sum', 'Sum'], ['count', 'Count'], ['average', 'Average'], ['max', 'Max'], ['min', 'Min'], ['product', 'Product'], ['countNums', 'Count Numbers']].map(([value, label]) => ({value, label}))}/>
    <Fld d={d} set={setValue} id="reference" kind="text" label="Reference (for example Sheet2!A1:C10):"/>
    <div className="gd-buttons"><Btn disabled={!typed} onClick={add}>Add</Btn><Btn disabled={selected < 0} onClick={del}>Delete</Btn></div>
    <div className="sf" data-field-id="references" data-kind="list">
      <span className="sf-label">All references:</span>
      <Rows label="All references" items={refs} selected={selected} onPick={i => setValue('selected', i)} height={120} empty="No references yet"/>
    </div>
    <div className="gd-section" style={{padding: '4px 0 0'}}>
      <span className="sf-label">Use labels in</span>
      <div className="data-two">
        <Fld d={d} set={setValue} id="topRow" kind="checkbox" label="Top row"/>
        <Fld d={d} set={setValue} id="leftColumn" kind="checkbox" label="Left column"/>
      </div>
    </div>
  </div>;
}

export default {Body};
