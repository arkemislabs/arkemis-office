// Create Custom Combo Chart as Excel draws its Custom Combination: a row for each series with a chart type list and a Secondary Axis
// box, and the chart's preview beside it. Over core/grid/dialogs/customCombo.mjs.

import {useMemo} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import type {SetValue} from './dataKit';
import {PrimSvg} from './recommendedCharts';
import {COMBO_KINDS} from '../../../../core/grid/commands/insert/charts3.mjs';
import './customCombo.css';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, session, docId} = useEngine();
  const names = (Array.isArray(d.values.names) ? d.values.names : []) as string[];
  const kinds = (Array.isArray(d.values.kinds) ? d.values.kinds : []) as string[];
  const secondary = (Array.isArray(d.values.secondary) ? d.values.secondary : []) as boolean[];
  const preview = useMemo(() => {
    const model = controller.dialogModel(d.id);
    try { return model?.preview ? (model.preview(session.readContext(docId) as any, d.values) as {w: number; h: number; prims: any[]} | null) : null; } catch { return null; }
  }, [controller, session, docId, d.id, d.values]);
  const error = d.errors.find(e => e.field === 'names')?.message ?? null;
  const setKind = (i: number, v: string) => setValue('kinds', kinds.map((k, j) => (j === i ? v : k)));
  const setSecondary = (i: number, v: boolean) => setValue('secondary', names.map((_, j) => (j === i ? v : secondary[j] === true)));
  return <div className="gd-fields insert-chart">
    <p className="sf-note" style={{margin: 0}}>Choose the chart type and axis for your data series:</p>
    <div className="insert-chart-body" style={{gridTemplateColumns: 'minmax(0, 1fr)'}}>
      <table className="combo-series" data-field-id="names" aria-label="Series">
        <thead><tr><th scope="col">Series Name</th><th scope="col">Chart Type</th><th scope="col">Secondary Axis</th></tr></thead>
        <tbody>
          {names.map((n, i) => <tr key={i}>
            <td>{n}</td>
            <td><select aria-label={`Chart type of ${n}`} value={kinds[i] ?? 'line'} onChange={e => setKind(i, e.target.value)}>{(COMBO_KINDS as string[][]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></td>
            <td><input type="checkbox" aria-label={`Secondary axis for ${n}`} checked={secondary[i] === true} onChange={e => setSecondary(i, e.target.checked)}/></td>
          </tr>)}
        </tbody>
      </table>
      <div className="insert-chart-side" data-field-id="preview">
        {preview && preview.prims.length ? <PrimSvg prims={preview.prims} w={preview.w} h={preview.h} label="Preview of the custom combination chart"/> : <div className="sf-list-empty">No preview</div>}
      </div>
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
