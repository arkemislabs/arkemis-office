// Fill Across Worksheets as Excel draws it (Fill: All, Contents, Formats), with the list of the other worksheets Excel takes from the
// grouped tabs. Not in gridcraft (not checked against upstream).

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const others = (d.values.others ?? []) as string[];
  const targets = (d.values.targets ?? []) as string[];
  const err = d.errors.find(e => e.field === 'targets')?.message ?? null;
  const toggle = (name: string) => setValue('targets', targets.includes(name) ? targets.filter(n => n !== name) : others.filter(n => n === name || targets.includes(n)));
  return <div className="gd-fields">
    <Fld d={d} set={setValue} id="fill" kind="radio" label="Fill"
      options={[{value: 'All', label: 'All'}, {value: 'Contents', label: 'Contents'}, {value: 'Formats', label: 'Formats'}]}/>
    <div className="sf" data-field-id="targets" data-kind="list">
      <span className="sf-label">Worksheets to fill:</span>
      <div className="data-checks" role="group" aria-label="Worksheets to fill">
        {others.map(n => <div key={n} className="sf sf-check"><label>
          <input type="checkbox" checked={targets.includes(n)} onChange={() => toggle(n)}/><span className="sf-check-box" aria-hidden="true"/><span>{n}</span>
        </label></div>)}
      </div>
      {err ? <small className="sf-error" role="alert">{err}</small> : null}
    </div>
  </div>;
}

export default {Body};
