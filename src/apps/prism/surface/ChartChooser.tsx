// The chart type chooser of Insert Chart and Change Chart Type: the categories down the left, each type of the chosen
// category drawn as a thumbnail of its sample chart, and a preview of the chosen type below. Pictures, not names: a
// type's name is its tooltip and the caption under the preview.

import {useMemo} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {CATEGORIES, typesIn, typeLabel, typePrims} from '../../../../core/prism/lib/chart.mjs';
import {ChartSvg} from './ChartPrims';
import './chart.css';

type Any = any;
const thumbs = new Map<string, Any>();
const thumb = (id: string) => { let t = thumbs.get(id); if (!t) { t = typePrims(id, 132, 92); thumbs.set(id, t); } return t; };

export function ChartChooser({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller, session, docId} = useEngine();
  const type = String(d.values.type ?? 'column');
  const category = String(d.values.category ?? 'Column');
  const preview = useMemo(() => {
    const model = controller.dialogModel(d.id);
    try { return model?.preview ? (model.preview(session.readContext(docId) as Any, d.values) as Any) : null; } catch { return null; }
  }, [controller, session, docId, d.id, d.values]);
  // No chart behind the dialog (or a preview that did not draw): the type's own sample chart, large, with its legend.
  const shown = preview && preview.prims?.length ? preview : typePrims(type, 360, 240, true);
  return <div className="chc" data-field-id="type">
    <ul className="chc-cats" role="listbox" aria-label="Chart category">
      {CATEGORIES.map((c: string) => {
        const first = typesIn(c)[0];
        return <li key={c}><button type="button" role="option" aria-selected={c === category} className={c === category ? 'is-on' : ''} title={c} aria-label={c}
          onClick={() => setValue('category', c)}><ChartSvg chart={thumb(first)} label="" className="chc-cat-art"/><span>{c}</span></button></li>;
      })}
    </ul>
    <div className="chc-main">
      <div className="chc-types" role="listbox" aria-label="Chart type">
        {typesIn(category).map((id: string) => <button key={id} type="button" role="option" aria-selected={id === type} className={id === type ? 'is-on' : ''}
          title={typeLabel(id)} aria-label={typeLabel(id)} onClick={() => setValue('type', id)}><ChartSvg chart={thumb(id)} label=""/></button>)}
      </div>
      <div className="chc-preview" data-field-id="preview">
        <ChartSvg chart={shown} label={`Preview of ${typeLabel(type)}`}/>
        <div className="chc-name">{typeLabel(type)}</div>
      </div>
    </div>
  </div>;
}
