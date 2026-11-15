// Value Field Settings as Excel draws it: Source Name, Custom Name, then two pages. Summarize Values By is a list box of the
// functions under "Choose the type of calculation…"; Show Values As is the calculation drop-down. Number Format sits at the foot.
// Over gridcraft's cmd/pivot/fields.rs (`value_settings`: func, name, show_as, number_format) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Base field and Base item are not drawn: gridcraft's Running Total runs over the first row field and Rank ranks among sibling
// items, so the page says which field they use instead of offering a choice that would do nothing.

import {useState} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, Tabs, Rows, type SetValue} from './dataKit';

const FUNCS: [string, string][] = [['sum', 'Sum'], ['count', 'Count'], ['average', 'Average'], ['max', 'Max'], ['min', 'Min'], ['product', 'Product'],
  ['countNumbers', 'Count Numbers'], ['stdDev', 'StdDev'], ['stdDevP', 'StdDevp'], ['var', 'Var'], ['varP', 'Varp']];
const SHOW_AS: [string, string][] = [['normal', 'No Calculation'], ['percentOfGrandTotal', '% of Grand Total'], ['percentOfColumnTotal', '% of Column Total'],
  ['percentOfRowTotal', '% of Row Total'], ['runningTotal', 'Running Total In'], ['rank', 'Rank Largest to Smallest']];
/** Format Cells' number categories as codes ('' keeps the source column's format). */
const FORMATS: [string, string][] = [['', 'General (as the source)'], ['0', 'Number'], ['0.00', 'Number, 2 decimals'], ['#,##0', 'Number with separator'],
  ['#,##0.00', 'Number with separator, 2 decimals'], ['"$"#,##0.00', 'Currency'], ['_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)', 'Accounting'],
  ['0%', 'Percentage'], ['0.00%', 'Percentage, 2 decimals'], ['m/d/yyyy', 'Short Date'], ['0.00E+00', 'Scientific']];

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const [page, setPage] = useState(0);
  const func = String(d.values.func ?? 'sum');
  const showAs = String(d.values.showAs ?? 'normal');
  const code = String(d.values.numberFormat ?? '');
  const formats = FORMATS.some(([c]) => c === code) ? FORMATS : [...FORMATS, [code, code] as [string, string]];
  const base = String(d.values.baseField ?? '');
  return <div className="gd-fields">
    <div className="sf" data-kind="label"><span className="sf-label">Source Name: <b>{String(d.values.source ?? '')}</b></span></div>
    <Fld d={d} set={setValue} id="name" kind="text" label="Custom Name:"/>
    <Tabs names={['Summarize Values By', 'Show Values As']} current={page} onPick={setPage} label="Value Field Settings pages"/>
    {page === 0 ? <div className="sf" data-field-id="func" data-kind="list">
      <span className="sf-label">Summarize value field by</span>
      <small className="sf-note">Choose the type of calculation that you want to use to summarize data from selected field</small>
      <Rows id="func" label="Summarize value field by" height={190} items={FUNCS.map(([, l]) => l)} selected={Math.max(0, FUNCS.findIndex(([v]) => v === func))}
        onPick={i => setValue('func', FUNCS[i][0])}/>
    </div> : <>
      <Fld d={d} set={setValue} id="showAs" kind="select" label="Show values as" options={SHOW_AS.map(([value, label]) => ({value, label}))}/>
      {showAs === 'runningTotal' || showAs === 'rank' ? <small className="sf-note">
        {showAs === 'runningTotal' ? 'Base field: ' : 'Ranked within: '}<b>{base || '(no row field)'}</b>{showAs === 'runningTotal' ? ', the first row field.' : ', among the items of the same parent.'}
      </small> : null}
    </>}
    <Fld d={d} set={setValue} id="numberFormat" kind="select" label="Number Format" options={formats.map(([value, label]) => ({value, label}))}/>
  </div>;
}

export default {Body};
