// The Convert Text to Columns Wizard as Excel draws it, in three steps: Original data type (Delimited or
// Fixed width) with a preview; the delimiters (Tab, Semicolon, Comma, Space, Other), Treat consecutive
// delimiters as one, the Text qualifier, or for fixed width a ruler to click break lines onto; then a
// Column data format per column (General, Text, Do not import) and the Destination.
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (Text to Columns) and cmd/data/tools.rs
// (`split_delimited`, the fixed-width cuts) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {splitDelimited, splitFixed} from '../../../../core/grid/lib/data-split.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, type SetValue} from './dataKit';

const STEPS = ['Original data type', 'Delimiters', 'Column data format'];

function delimsOf(v: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (v.tab) out.push('\t'); if (v.semicolon) out.push(';'); if (v.comma) out.push(','); if (v.space) out.push(' ');
  if (String(v.other ?? '')) out.push([...String(v.other)][0]);
  return out;
}

/** Each preview line split as the settings say. */
function split(v: Record<string, unknown>, lines: string[]): string[][] {
  if (v.dataType === 'fixed') return lines.map(l => splitFixed(l, (v.breaks ?? []) as number[]));
  const q = v.textQualifier === '{none}' ? '' : String(v.textQualifier || '"');
  return lines.map(l => splitDelimited(l, delimsOf(v), v.treatConsecutive === true, q));
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const v = d.values;
  const step = Math.min(Math.max(Number(v.step ?? 1), 1), 3);
  const lines = ((v.lines ?? []) as string[]).slice(0, 12);
  const fixed = v.dataType === 'fixed';
  const breaks = (v.breaks ?? []) as number[];
  const formats = (v.formats ?? []) as string[];
  const column = Number(v.column ?? 0);
  const rows = split(v, lines);
  const width = Math.max(1, ...rows.map(r => r.length));
  const longest = Math.max(10, ...lines.map(l => [...l].length));
  const error = d.errors.find(e => e.field === 'tab')?.message ?? null;
  const setFormat = (f: string) => { const n = Array.from({length: width}, (_, i) => formats[i] ?? 'general'); n[column] = f; setValue('formats', n); };
  const toggleBreak = (pos: number) => { if (pos > 0 && pos < longest) setValue('breaks', breaks.includes(pos) ? breaks.filter(b => b !== pos) : [...breaks, pos].sort((a, b) => a - b)); };

  const table = (pick: boolean) => <div className="data-preview" aria-label="Data preview" data-field-id="preview"><table>
    <thead><tr>{Array.from({length: width}, (_, i) => <th key={i} className={`${pick && i === column ? 'is-on' : ''}${(formats[i] ?? 'general') === 'skip' ? ' is-skip' : ''}`}
      onClick={pick ? () => setValue('column', i) : undefined}>{pick ? (formats[i] === 'skip' ? 'Skip' : formats[i] === 'text' ? 'Text' : 'General') : `Column ${i + 1}`}</th>)}</tr></thead>
    <tbody>{rows.map((r, ri) => <tr key={ri}>{Array.from({length: width}, (_, i) => <td key={i} className={(formats[i] ?? 'general') === 'skip' ? 'is-skip' : undefined}>{r[i] ?? ''}</td>)}</tr>)}</tbody>
  </table></div>;

  const fixedPreview = <div className="data-preview" aria-label="Data preview" data-field-id="preview">
    <div className="data-fixed" role="group" aria-label="Fixed-width preview. Click to set a break line.">
      <div className="ruler">{Array.from({length: longest}, (_, i) => <span key={i} className="ch" onClick={() => toggleBreak(i)}>{i % 10 === 0 ? String((i / 10) % 10) : '·'}</span>)}</div>
      {lines.map((l, li) => <div key={li}>{Array.from({length: longest}, (_, i) => <span key={i} className={`ch${breaks.includes(i) ? ' is-break' : ''}`} onClick={() => toggleBreak(i)}>{[...l][i] ?? ' '}</span>)}</div>)}
    </div>
  </div>;

  return <div className="gd-fields data-wizard">
    <div className="data-wizard-steps" aria-label="Step">{STEPS.map((s, i) => <span key={s}>{i + 1 === step ? <b>Step {i + 1} of 3: {s}</b> : `${i + 1}`}</span>)}</div>
    {step === 1 ? <>
      <p className="sf-note" style={{margin: 0}}>The Text Wizard has determined that your data is Delimited. If this is correct, choose Next, or choose the data type that best describes your data.</p>
      <Fld d={d} set={setValue} id="dataType" kind="radio" label="Original data type" options={[{value: 'delimited', label: 'Delimited – Characters such as commas or tabs separate each field.'}, {value: 'fixed', label: 'Fixed width – Fields are aligned in columns with spaces between each field.'}]}/>
      <span className="sf-label">Preview of selected data:</span>
      {table(false)}
    </> : null}
    {step === 2 && !fixed ? <>
      <p className="sf-note" style={{margin: 0}}>This screen lets you set the delimiters your data contains. You can see how your text is affected in the preview below.</p>
      <div className="data-two">
        <Fld d={d} set={setValue} id="tab" kind="checkbox" label="Tab"/>
        <Fld d={d} set={setValue} id="semicolon" kind="checkbox" label="Semicolon"/>
        <Fld d={d} set={setValue} id="comma" kind="checkbox" label="Comma"/>
        <Fld d={d} set={setValue} id="space" kind="checkbox" label="Space"/>
      </div>
      <div className="data-two">
        <Fld d={d} set={setValue} id="other" kind="text" label="Other:"/>
        <Fld d={d} set={setValue} id="textQualifier" kind="select" label="Text qualifier:" options={[{value: '"', label: '"'}, {value: "'", label: "'"}, {value: '{none}', label: '{none}'}]}/>
      </div>
      <Fld d={d} set={setValue} id="treatConsecutive" kind="checkbox" label="Treat consecutive delimiters as one"/>
      {error ? <small className="sf-error" role="alert">{error}</small> : null}
      <span className="sf-label">Data preview:</span>
      {table(false)}
    </> : null}
    {step === 2 && fixed ? <>
      <p className="sf-note" style={{margin: 0}}>This screen lets you set field widths (column breaks). Click on the ruler or the data to create a break line; click a break line to delete it.</p>
      {fixedPreview}
    </> : null}
    {step === 3 ? <>
      <p className="sf-note" style={{margin: 0}}>Select each column in the preview and choose its data format. General converts numbers to numbers, dates to dates and everything else to text.</p>
      <fieldset className="sf sf-radio" data-field-id="format" data-kind="radio"><legend className="sf-label">Column data format</legend>
        <div className="sf-radio-options" role="radiogroup">
          {[['general', 'General'], ['text', 'Text'], ['skip', 'Do not import column (skip)']].map(([k, label]) => <label key={k}>
            <input type="radio" name="ttc-format" checked={(formats[column] ?? 'general') === k} onChange={() => setFormat(k)}/>
            <span className="sf-radio-dot" aria-hidden="true"/><span>{label}</span></label>)}
        </div>
      </fieldset>
      <Fld d={d} set={setValue} id="destination" kind="text" label="Destination:"/>
      <span className="sf-label">Data preview:</span>
      {table(true)}
    </> : null}
    <div className="data-wizard-nav">
      <Btn disabled={step <= 1} onClick={() => setValue('step', step - 1)}>{'< Back'}</Btn>
      <Btn disabled={step >= 3} onClick={() => setValue('step', step + 1)}>{'Next >'}</Btn>
    </div>
  </div>;
}

export default {Body};
