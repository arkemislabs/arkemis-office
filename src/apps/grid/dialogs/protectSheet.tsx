// Protect Sheet as Excel draws it: the check box "Protect worksheet and contents of locked cells", the password, and one scrolling
// check list "Allow all users of this worksheet to:". On a protected sheet the same dialog is Unprotect Sheet with a password box.
// gridcraft's forms (crates/ui-egui/src/dialogs.rs `protectSheet`, `unprotectSheet`) in Excel's layout. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {ALLOWED} from '../../../../core/grid/dialogs/protectSheet.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  if (d.values.mode === 'unprotect') {
    return <div className="gd-fields">
      <p>{d.values.needsPassword ? 'This sheet is protected with a password.' : 'Unprotect this sheet?'}</p>
      {d.values.needsPassword ? <Fld d={d} set={setValue} id="unprotectPassword" label="Password:" kind="text" masked/> : null}
    </div>;
  }
  // PivotTables exist only where the engine does.
  const pivots = controller.hasCommand('insert.pivotTable');
  return <div className="gd-fields">
    <Fld d={d} set={setValue} id="protectContents" label="Protect worksheet and contents of locked cells" kind="checkbox"/>
    <Fld d={d} set={setValue} id="password" label="Password to unprotect sheet:" kind="text" masked disabled={d.values.protectContents === false}/>
    <span className="sf-label">Allow all users of this worksheet to:</span>
    <div className="data-checks" role="group" aria-label="Allow all users of this worksheet to" data-field-id="allowed">
      {(ALLOWED as unknown as [string, string, boolean][]).filter(([k]) => k !== 'pivotTables' || pivots).map(([k, label]) =>
        <Fld key={k} d={d} set={setValue} id={k} label={label} kind="checkbox" disabled={d.values.protectContents === false}/>)}
    </div>
  </div>;
}

export default {Body};
