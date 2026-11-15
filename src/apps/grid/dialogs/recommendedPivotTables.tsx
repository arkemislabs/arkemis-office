// Recommended PivotTables as Excel draws it: the layouts that suit the data in a list on the left, a preview of the one picked
// on the right. Excel's dialog over gridcraft's cmd/pivot/charts.rs (`suggestions`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {Icon} from '../../../shell/icons/Icon';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Rows, type SetValue} from './dataKit';
import {PrimSvg} from './recommendedCharts';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, session, docId} = useEngine();
  const titles = (Array.isArray(d.values.list) ? d.values.list : []) as string[];
  const selected = Math.min(Math.max(0, Number(d.values.pick) || 0), Math.max(0, titles.length - 1));
  const preview = useMemo(() => {
    const model = controller.dialogModel(d.id);
    try { return model?.preview ? (model.preview(session.readContext(docId) as any, d.values) as {w: number; h: number; prims: any[]} | null) : null; } catch { return null; }
  }, [controller, session, docId, d.id, d.values]);
  const error = d.errors.find(e => e.field === 'list')?.message ?? null;
  if (!titles.length) return <div className="gd-fields insert-chart"><p className="sf-note" style={{margin: 0}} data-field-id="list">Select a cell in a range with labeled columns first; Excel then lists the PivotTable layouts that suit the data.</p></div>;
  return <div className="gd-fields insert-chart">
    <div className="insert-chart-body">
      <div data-field-id="list">
        <Rows label="Recommended PivotTables" id="pick" height={250} selected={selected} onPick={i => setValue('pick', i)} empty="Select a cell in a range with labeled columns first."
          items={titles.map(l => <span key={l} className="insert-chart-item"><Icon id="pivot-table" size={24}/><span>{l}</span></span>)}/>
      </div>
      <div className="insert-chart-side" data-field-id="preview">
        {preview && preview.prims.length ? <PrimSvg prims={preview.prims} w={preview.w} h={preview.h} label={`Preview of ${titles[selected] ?? 'the PivotTable'}`}/> : <div className="sf-list-empty">No preview</div>}
      </div>
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
