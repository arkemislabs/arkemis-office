// Insert Calculated Field as Excel draws it: Name, Formula, the Fields list with Insert Field, and Add / Delete
// for the calculated fields the PivotTable already has.
// Excel's dialog over gridcraft's cmd/pivot/fields.rs (`calculated_field`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fieldText, formulaProblem} from '../../../../core/grid/dialogs/pivotCalculatedField.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, Rows, type SetValue} from './dataKit';

interface Calc { name: string; formula: string }

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  const fields = (d.values.fields ?? []) as string[];
  const calculated = (d.values.calculated ?? []) as Calc[];
  const selected = Number(d.values.selected ?? -1);
  const name = String(d.values.name ?? '').trim();
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const insertField = () => {
    const f = fields[selected];
    if (f === undefined) return;
    const cur = String(d.values.formula ?? '');
    setValue('formula', `${cur}${/[\s(*/+\-^,=<>&]$/.test(cur) || !cur ? '' : ' '}${fieldText(f)}`);
  };
  const exists = calculated.some(c => c.name.toLowerCase() === name.toLowerCase());
  const problem = !name ? 'Enter a name for the field.' : formulaProblem(String(d.values.formula ?? ''), fields, calculated, name);
  // Add and Delete change the PivotTable now and keep the dialog open, as Excel's do.
  const add = () => {
    if (problem) { fail(new Error(problem)); return; }
    void controller.run('pivot.calculatedField', {pivot: d.values.pivot, name, formula: String(d.values.formula ?? '').trim()}).then(() => {
      const formula = String(d.values.formula ?? '').trim();
      setValue('calculated', exists ? calculated.map(c => (c.name.toLowerCase() === name.toLowerCase() ? {...c, formula} : c)) : [...calculated, {name, formula}]);
    }).catch(fail);
  };
  const del = () => {
    void controller.run('pivot.calculatedField', {pivot: d.values.pivot, name, delete: true}).then(() => setValue('calculated', calculated.filter(c => c.name.toLowerCase() !== name.toLowerCase()))).catch(fail);
  };
  return <div className="gd-fields">
    <Fld d={d} set={setValue} id="name" kind="text" label="Name:"/>
    <Fld d={d} set={setValue} id="formula" kind="text" label="Formula:"/>
    <div className="gd-buttons"><Btn disabled={!!problem} onClick={add}>Add</Btn><Btn disabled={!exists} onClick={del}>Delete</Btn></div>
    <div className="sf" data-field-id="fields" data-kind="list">
      <span className="sf-label">Fields:</span>
      <Rows label="Fields" items={fields} selected={selected} onPick={i => setValue('selected', i)} height={130} empty="The PivotTable has no fields" onDouble={i => { setValue('selected', i); const f = fields[i]; if (f !== undefined) setValue('formula', `${String(d.values.formula ?? '')}${fieldText(f)}`); }}/>
    </div>
    <div className="gd-buttons"><Btn disabled={selected < 0} onClick={insertField}>Insert Field</Btn></div>
  </div>;
}

export default {Body};
