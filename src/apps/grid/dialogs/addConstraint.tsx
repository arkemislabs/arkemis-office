// Add Constraint (and Change Constraint) as Excel draws it: Cell Reference, the relation, Constraint, with Add to enter the
// constraint and stay open for the next. OK hands the constraint to Solver Parameters (its `constraintEdit` value).
// Excel's dialog over gridcraft's constraint syntax (cmd/solver/model.rs) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import addConstraint, {handOver} from '../../../../core/grid/dialogs/addConstraint.mjs';
import {RELATIONS, takesValue} from '../../../../core/grid/lib/solver-dialog.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, type SetValue} from './dataKit';
import './solver.css';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  const op = String(d.values.op ?? '<=');
  const rhsError = d.errors.find(e => e.field === 'rhs')?.message ?? null;
  // Add enters the constraint in Solver Parameters and clears the boxes for the next one.
  const add = () => {
    const problems = (addConstraint.validate(d.values as any) ?? []) as {field: string; message: string}[];
    if (problems.length) { controller.notify(problems[0].message, 'error'); return; }
    const value = handOver(d.values as any);
    if (!value || !d.parent) return;
    try {
      controller.setDialogValue(d.parent, 'constraintEdit', value);
      setValue('lhs', ''); setValue('rhs', ''); setValue('index', -1);
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  return <div className="gd-fields">
    <div className="solver-add">
      <Fld d={d} set={setValue} id="lhs" kind="text" label="Cell Reference:"/>
      <Fld d={d} set={setValue} id="op" kind="select" label=" " options={RELATIONS}/>
      {takesValue(op) ? <Fld d={d} set={setValue} id="rhs" kind="text" label="Constraint:"/>
        : <div className="sf" data-field-id="rhs" data-kind="text">
          <label className="sf-label" htmlFor="solver-rhs-fixed">Constraint:</label>
          <div className="sf-control"><input id="solver-rhs-fixed" className="sf-text" disabled value={op === 'bin' ? 'binary' : 'integer'} readOnly/></div>
          {rhsError ? <small className="sf-error" role="alert">{rhsError}</small> : null}
        </div>}
    </div>
    {Number(d.values.index ?? -1) < 0 ? <div className="solver-add-actions"><Btn onClick={add}>Add</Btn></div> : null}
  </div>;
}

export default {Body};
