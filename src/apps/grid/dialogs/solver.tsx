// Solver Parameters as Excel draws it: Set Objective, To (Max, Min, Value Of), By Changing Variable Cells, the constraint
// list with Add, Change, Delete and Reset All, Make Unconstrained Variables Non-Negative, the solving method with Options
// and the sentence under it. Add and Change open Add Constraint, Options opens Solver Options; they hand their result back
// through the dialog's `constraintEdit` and `optionsEdit` values (core/grid/dialogs/solver.mjs `derive`). Solve is the
// dialog's OK (core/grid/dialogs/solver.mjs `toCommand`).
// Excel's dialog over gridcraft's crates/ui-egui/src/dialogs/analysis.rs `solver` at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fromKernelSelection} from '../../../../core/grid/model/workbook.mjs';
import {solverValues} from '../../../../core/grid/dialogs/solver.mjs';
import {splitLine, METHODS, METHOD_HELP} from '../../../../core/grid/lib/solver-dialog.mjs';
import {openMessageBox} from '../../../shell/dialogs/MessageBox';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, Rows, type SetValue} from './dataKit';
import './solver.css';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, session, docId} = useEngine();
  const list = (d.values.constraints ?? []) as string[];
  const selected = Math.min(Number(d.values.selected ?? -1), list.length - 1);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const nested = (id: string, field: string, init: Record<string, unknown>) => {
    try { controller.openDialog(id, {parent: d.key, target: {dialog: d.key, field}, init}); } catch (e) { fail(e); }
  };
  const change = (i: number) => {
    const c = splitLine(list[i]);
    const text = list[i];
    nested('dialog.addConstraint', 'constraintEdit', {lhs: c.lhs, op: c.op, rhs: c.rhs, index: i, value: {text, index: i}});
  };
  const resetAll = async () => {
    const pick = await openMessageBox({title: 'Solver Parameters', type: 'question', message: 'Reset all Solver options and cell selections?', buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1});
    if (pick !== 0) return;
    try {
      const doc = (session as any).get(docId);
      const sel = fromKernelSelection(doc.file.content, doc.selection);
      const blank = solverValues(doc.file.content, sel.sheet, sel.active, true) as Record<string, unknown>;
      for (const k of ['objective', 'goal', 'value', 'variables', 'constraints', 'selected', 'nonNegative', 'method', 'options']) setValue(k, blank[k]);
      setValue('objective', '');
    } catch (e) { fail(e); }
  };
  return <div className="gd-fields solver-body">
    <Fld d={d} set={setValue} id="objective" kind="text" label="Set Objective:"/>
    <div className="solver-goal">
      <Fld d={d} set={setValue} id="goal" kind="radio" label="To:" options={[{value: 'max', label: 'Max'}, {value: 'min', label: 'Min'}, {value: 'value', label: 'Value Of:'}]}/>
      <Fld d={d} set={setValue} id="value" kind="text" disabled={d.values.goal !== 'value'}/>
    </div>
    <Fld d={d} set={setValue} id="variables" kind="text" label="By Changing Variable Cells:"/>
    <div className="solver-constraints">
      <div className="sf" data-field-id="constraints" data-kind="list">
        <span className="sf-label">Subject to the Constraints:</span>
        <Rows label="Subject to the Constraints" items={list} selected={selected} onPick={i => setValue('selected', i)} height={150} onDouble={change}
          empty="No constraints. Choose Add to enter one."/>
      </div>
      <div className="gd-buttons" role="group" aria-label="Constraint actions">
        <Btn onClick={() => nested('dialog.addConstraint', 'constraintEdit', {index: -1})}>Add</Btn>
        <Btn disabled={selected < 0} onClick={() => change(selected)}>Change</Btn>
        <Btn disabled={selected < 0} onClick={() => { setValue('constraints', list.filter((_, i) => i !== selected)); setValue('selected', Math.min(selected, list.length - 2)); }}>Delete</Btn>
        <Btn onClick={() => void resetAll()}>Reset All</Btn>
      </div>
    </div>
    <Fld d={d} set={setValue} id="nonNegative" kind="checkbox" label="Make Unconstrained Variables Non-Negative"/>
    <div className="solver-method">
      <Fld d={d} set={setValue} id="method" kind="select" label="Select a Solving Method:" options={METHODS}/>
      <Btn onClick={() => nested('dialog.solverOptions', 'optionsEdit', {...(d.values.options as Record<string, unknown>), value: d.values.options})}>Options</Btn>
    </div>
    <fieldset className="solver-help"><legend>Solving Method</legend><p>{METHOD_HELP}</p></fieldset>
  </div>;
}

export default {Body};
