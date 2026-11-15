// Data Validation as Excel draws it: Settings (Allow, Data, the bounds labelled by both, Ignore blank,
// In-cell dropdown), Input Message and Error Alert (Style, Title, message), and Clear All.
// Translated from gridcraft crates/ui-egui/src/dialogs/data.rs (`data_validation_fields`: the
// criterion boxes depend on both Allow and Data; formula1 is the sole source of a list or custom rule,
// formula2 a second bound only for between and not between) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useState} from 'react';
import {criterionLabels} from '../../../../core/grid/dialogs/dataValidation.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, Tabs, type SetValue} from './dataKit';

const TYPES = [['any', 'Any value'], ['whole', 'Whole number'], ['decimal', 'Decimal'], ['list', 'List'], ['date', 'Date'], ['time', 'Time'], ['textLength', 'Text length'], ['custom', 'Custom']];
const OPS = [['between', 'between'], ['notBetween', 'not between'], ['equal', 'equal to'], ['notEqual', 'not equal to'], ['greaterThan', 'greater than'], ['lessThan', 'less than'],
  ['greaterThanOrEqual', 'greater than or equal to'], ['lessThanOrEqual', 'less than or equal to']];
const opt = (list: string[][]) => list.map(([value, label]) => ({value, label}));

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const [tab, setTab] = useState(0);
  const v = d.values;
  const type = String(v.type ?? 'any'), operator = String(v.operator ?? 'between');
  const [l1, l2] = criterionLabels(type, operator);
  const bounded = type === 'whole' || type === 'decimal' || type === 'date' || type === 'time' || type === 'textLength';
  const two = bounded && (operator === 'between' || operator === 'notBetween');
  // OK finds a problem in the criteria: the Settings tab shows it.
  useEffect(() => { if (d.errors.length) setTab(0); }, [d.errors]);
  const shown = tab;
  return <div className="gd-fields">
    <Tabs names={['Settings', 'Input Message', 'Error Alert']} current={shown} onPick={setTab} label="Data Validation pages"/>
    {shown === 0 ? <div className="gd-fields">
      <p className="sf-note" style={{margin: 0}}>Validation criteria</p>
      <Fld d={d} set={setValue} id="type" kind="select" label="Allow:" options={opt(TYPES)}/>
      {/* As Excel's page: the rows a type does not use are not there (Any value shows Ignore blank only). */}
      <Fld d={d} set={setValue} id="operator" kind="select" label="Data:" options={opt(OPS)} hidden={!bounded}/>
      <Fld d={d} set={setValue} id="formula1" kind="text" label={l1} hidden={type === 'any'}/>
      <Fld d={d} set={setValue} id="formula2" kind="text" label={l2} hidden={!two}/>
      <Fld d={d} set={setValue} id="ignoreBlank" kind="checkbox" label="Ignore blank"/>
      <Fld d={d} set={setValue} id="dropdown" kind="checkbox" label="In-cell dropdown" hidden={type !== 'list'}/>
      <Fld d={d} set={setValue} id="applyToSame" kind="checkbox" label="Apply these changes to all other cells with the same settings"/>
    </div> : null}
    {shown === 1 ? <div className="gd-fields">
      <Fld d={d} set={setValue} id="showInput" kind="checkbox" label="Show input message when cell is selected"/>
      <p className="sf-note" style={{margin: 0}}>When cell is selected, show this input message:</p>
      <Fld d={d} set={setValue} id="inputTitle" kind="text" label="Title:" disabled={v.showInput === false}/>
      <Fld d={d} set={setValue} id="inputMessage" kind="text" label="Input message:" multiline disabled={v.showInput === false}/>
    </div> : null}
    {shown === 2 ? <div className="gd-fields">
      <Fld d={d} set={setValue} id="showError" kind="checkbox" label="Show error alert after invalid data is entered"/>
      <p className="sf-note" style={{margin: 0}}>When user enters invalid data, show this error alert:</p>
      <Fld d={d} set={setValue} id="errorStyle" kind="select" label="Style:" disabled={v.showError === false} options={opt([['stop', 'Stop'], ['warning', 'Warning'], ['information', 'Information']])}/>
      <Fld d={d} set={setValue} id="errorTitle" kind="text" label="Title:" disabled={v.showError === false}/>
      <Fld d={d} set={setValue} id="errorMessage" kind="text" label="Error message:" multiline disabled={v.showError === false}/>
    </div> : null}
  </div>;
}

export default {Body};
