// Create Forecast Worksheet as Excel draws it: the preview of the forecast chart with the line and
// column chart buttons beside it, Forecast End, and the Options part (Forecast Start, Confidence
// Interval, Seasonality detected automatically or set manually, Include forecast statistics, Timeline
// Range, Values Range, Fill Missing Points Using, Aggregate Duplicates Using).
// Excel's dialog over gridcraft's cmd/forecast.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {Icon} from '../../../shell/icons/Icon';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, type SetValue} from './dataKit';
import {PrimSvg} from './recommendedCharts';
import './forecastSheet.css';

const OPTION_FIELDS = ['forecastStart', 'confidence', 'seasonality', 'timeline', 'values'];

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, session, docId} = useEngine();
  const optionError = d.errors.some(e => OPTION_FIELDS.includes(e.field));
  const [more, setMore] = useState(false);
  const open = more || optionError;
  const preview = useMemo(() => {
    const model = controller.dialogModel(d.id);
    try { return model?.preview ? (model.preview(session.readContext(docId) as any, d.values) as {w: number; h: number; prims: any[]} | null) : null; } catch { return null; }
  }, [controller, session, docId, d.id, d.values]);
  const chart = d.values.chart === 'column' ? 'column' : 'line';
  const manual = d.values.seasonalityMode === 'manual';
  const interval = d.values.confidenceInterval !== false;
  const kind = (id: 'line' | 'column', icon: string, label: string) =>
    <button type="button" className={`fc-kind${chart === id ? ' is-on' : ''}`} role="radio" aria-checked={chart === id} aria-label={label} title={label} onClick={() => setValue('chart', id)}>
      <Icon id={icon} size={24}/>
    </button>;
  return <div className="gd-fields fc">
    <div className="fc-top">
      <div className="fc-preview" data-field-id="preview">
        {preview && preview.prims.length ? <PrimSvg prims={preview.prims} w={preview.w} h={preview.h} label="Preview of the forecast chart"/> : <div className="sf-list-empty" style={{padding: 12, textAlign: 'center'}}>{(preview as {error?: string} | null)?.error ?? 'Select a timeline and a values column to preview the forecast.'}</div>}
      </div>
      <div className="fc-kinds" role="radiogroup" aria-label="Chart" data-field-id="chart">
        {kind('line', 'insert-chart-line', 'Create a line chart')}
        {kind('column', 'insert-chart-column-clustered', 'Create a column chart')}
      </div>
    </div>
    <Fld d={d} set={setValue} id="end" kind="text" label="Forecast End"/>
    <div className="fc-options">
      <button type="button" className="fc-toggle" aria-expanded={open} onClick={() => setMore(!more)}>
        <Icon id="chevron-right" size={16}/><span>Options</span>
      </button>
      {open ? <>
        <div className="fc-row">
          <Fld d={d} set={setValue} id="forecastStart" kind="text" label="Forecast Start"/>
          <div className="fc-season">
            <Fld d={d} set={setValue} id="confidenceInterval" kind="checkbox" label="Confidence Interval"/>
            <Fld d={d} set={setValue} id="confidence" kind="text" label="Confidence level (%)" disabled={!interval}/>
          </div>
        </div>
        <div className="fc-row">
          <div className="fc-season">
            <Fld d={d} set={setValue} id="seasonalityMode" kind="radio" label="Seasonality" options={[{value: 'auto', label: 'Detect Automatically'}, {value: 'manual', label: 'Set Manually'}]}/>
            <Fld d={d} set={setValue} id="seasonality" kind="text" label="Season length (points, 0 for none)" disabled={!manual}/>
          </div>
          <Fld d={d} set={setValue} id="statistics" kind="checkbox" label="Include forecast statistics"/>
        </div>
        <div className="fc-row">
          <Fld d={d} set={setValue} id="timeline" kind="text" label="Timeline Range"/>
          <Fld d={d} set={setValue} id="values" kind="text" label="Values Range"/>
        </div>
        <div className="fc-row">
          <Fld d={d} set={setValue} id="fillMissing" kind="select" label="Fill Missing Points Using" options={[{value: 'interpolate', label: 'Interpolation'}, {value: 'zeros', label: 'Zeros'}]}/>
          <Fld d={d} set={setValue} id="aggregate" kind="select" label="Aggregate Duplicates Using"
            options={[['average', 'Average'], ['count', 'Count'], ['counta', 'CountA'], ['max', 'Max'], ['median', 'Median'], ['min', 'Min'], ['sum', 'Sum']].map(([value, label]) => ({value, label}))}/>
        </div>
      </> : null}
    </div>
  </div>;
}

export default {Body};
