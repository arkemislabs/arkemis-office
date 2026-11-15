// Solver Results as Excel draws it: the outcome, Keep Solver Solution / Restore Original Values, the reports to write
// (Answer, Limits) and Return to Solver Parameters Dialog. The cells keep their original values until OK, so Cancel leaves them.
// Excel's dialog over gridcraft's crates/ui-egui/src/dialogs/analysis.rs `solver_results` at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {hasSolution} from '../../../../core/grid/dialogs/solverResults.mjs';
import {limitsAvailable} from '../../../../core/grid/lib/solver-dialog.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, type SetValue} from './dataKit';
import './solver.css';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const solved = hasSolution(d.values);
  const limits = solved && limitsAvailable(d.values.model as {method?: string; constraints?: string[]} | null);
  return <div className="gd-fields">
    <p className="solver-results-message" role="status" data-field-id="message">{String(d.values.message ?? '')}</p>
    <div className="solver-results-grid">
      <Fld d={d} set={setValue} id="restore" kind="radio" label=" "
        options={solved ? [{value: false, label: 'Keep Solver Solution'}, {value: true, label: 'Restore Original Values'}] : [{value: true, label: 'Restore Original Values'}]}/>
      <div className="sf" data-field-id="reports" data-kind="list">
        <span className="sf-label">Reports</span>
        <div className="solver-reports" role="group" aria-label="Reports">
          <Fld d={d} set={setValue} id="answerReport" kind="checkbox" label="Answer" disabled={!solved}/>
          <Fld d={d} set={setValue} id="limitsReport" kind="checkbox" label="Limits" disabled={!limits}/>
        </div>
      </div>
    </div>
    <Fld d={d} set={setValue} id="returnToParams" kind="checkbox" label="Return to Solver Parameters Dialog"/>
  </div>;
}

export default {Body};
