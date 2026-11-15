// The Series dialog as Excel and gridcraft lay it out: "Series in", "Type" and "Date unit" side by
// side, Trend under them, then Step value and Stop value on one row. Date unit is available only
// for the Date type; Step value is not used by AutoFill or with Trend.
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:452 (Series) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {realOptions, allFields} from '../../../shell/dialogs/dialogState';

type Opt = {value: unknown; label: string};

function Group({d, id, setValue, disabled = false}: {d: DialogState; id: string; setValue: (f: string, v: unknown) => void; disabled?: boolean}) {
  const field = allFields(d.spec).find(f => f.id === id);
  if (!field) return null;
  const options = realOptions(field) as Opt[];
  return <fieldset className="sf sf-radio" data-field-id={id} data-kind="radio" disabled={disabled}>
    <legend className="sf-label">{field.label}</legend>
    <div className="sf-radio-options" role="radiogroup">
      {options.map((o, i) => <label key={i}>
        <input type="radio" name={`series-${id}`} checked={o.value === d.values[id]} onChange={() => setValue(id, o.value)}/>
        <span className="sf-radio-dot" aria-hidden="true"/>
        <span>{o.label}</span>
      </label>)}
    </div>
  </fieldset>;
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const type = d.values.type;
  const errorOf = (id: string) => d.errors.find(e => e.field === id)?.message ?? null;
  const stepOff = type === 'autoFill';
  return <div className="gd-fields">
    <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16}}>
      <Group d={d} id="direction" setValue={setValue}/>
      <Group d={d} id="type" setValue={setValue}/>
      <Group d={d} id="dateUnit" setValue={setValue} disabled={type !== 'date'}/>
    </div>
    <div className="sf sf-check" data-field-id="trend" data-kind="checkbox">
      <label className={type !== 'linear' && type !== 'growth' ? 'is-disabled' : undefined}>
        <input type="checkbox" checked={d.values.trend === true} disabled={type !== 'linear' && type !== 'growth'} onChange={e => setValue('trend', e.target.checked)}/>
        <span className="sf-check-box" aria-hidden="true"/>
        <span>Trend</span>
      </label>
    </div>
    <div className="gd-grid" style={{gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'}}>
      <div className={`sf${errorOf('step') ? ' has-error' : ''}`} data-field-id="step" data-kind="number">
        <label className="sf-label" htmlFor="grid-series-step">Step value:</label>
        <div className="sf-control">
          <input id="grid-series-step" className="sf-text" type="text" inputMode="decimal" disabled={stepOff || d.values.trend === true}
            value={d.values.step === null || d.values.step === undefined ? '' : String(d.values.step)}
            onChange={e => { const t = e.target.value.trim(); const n = Number(t); setValue('step', t === '' ? null : Number.isFinite(n) ? n : t); }}/>
        </div>
        {errorOf('step') ? <small className="sf-error" role="alert">{errorOf('step')}</small> : null}
      </div>
      <div className={`sf${errorOf('stop') ? ' has-error' : ''}`} data-field-id="stop" data-kind="text">
        <label className="sf-label" htmlFor="grid-series-stop">Stop value:</label>
        <div className="sf-control">
          <input id="grid-series-stop" className="sf-text" type="text" inputMode="decimal" disabled={stepOff}
            value={String(d.values.stop ?? '')} onChange={e => setValue('stop', e.target.value)}/>
        </div>
        {errorOf('stop') ? <small className="sf-error" role="alert">{errorOf('stop')}</small> : null}
      </div>
    </div>
  </div>;
}

export default {Body};
