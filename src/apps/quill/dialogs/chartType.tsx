// Insert Chart and Change Chart Type views (Insert › Chart, Chart Design › Change Chart Type): PowerPoint's chooser (the categories down the
// left, each type of the chosen category drawn as a thumbnail of its sample chart, and a preview below), imported from Prism's view and
// type table (src/apps/prism/surface/ChartChooser.tsx, core/prism/lib/chart.mjs; not edited) and kept on Word's own `type` (the label of
// core/quill/dialogs/chartType.mjs CHART_LIST) so OK still runs insert.chart / chart.type with Word's types. The preview is the chart on
// its sample data drawn by the renderer Grid uses, so it is the chart that goes in. Word's 100% Stacked Area and Scatter with Lines have no
// thumbnail in Prism's table: they are in the lists by name only (the commands take them).

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {BodyProps} from './font';
import {PrimSvg} from '../../grid/dialogs/recommendedCharts';
import {ChartSvg} from '../../prism/surface/ChartPrims';
import {CATEGORIES, TYPES, typesIn, typeCategory, typePrims} from '../../../../core/prism/lib/chart.mjs';
import {CHART_LIST} from '../../../../core/quill/dialogs/chartType.mjs';
import '../../prism/surface/chart.css';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Prism's type id → Word's type (its engine kind; Word names the clustered ones column and bar). */
const wordType = (id: string): string | null => {
  const kind = (TYPES as readonly string[][]).find(t => t[0] === id)?.[2];
  if (!kind || kind === 'bubble') return null;
  return kind === 'columnClustered' ? 'column' : kind === 'barClustered' ? 'bar' : kind;
};
const labelOfWord = (type: string) => (CHART_LIST as readonly string[][]).find(([, t]) => t === type)?.[0] ?? null;
/** Prism ids whose Word type the list offers, with the label to store. */
const OFFERED = (TYPES as readonly string[][]).map(t => t[0]).filter(id => { const w = wordType(id); return !!w && !!labelOfWord(w); });
const idOfLabel = (label: string) => OFFERED.find(id => labelOfWord(wordType(id)!) === label) ?? 'column';
const thumbs = new Map<string, Any>();
const thumb = (id: string) => { let t = thumbs.get(id); if (!t) { t = typePrims(id, 132, 92); thumbs.set(id, t); } return t; };
const inCategory = (c: string) => (typesIn(c) as string[]).filter(id => OFFERED.includes(id));
const categories = (CATEGORIES as readonly string[]).filter(c => inCategory(c).length);

function Body({dialog: d, setValue}: BodyProps) {
  const {controller, session, docId} = useEngine();
  const label = String(d.values.type ?? 'Clustered Column');
  const id = idOfLabel(label);
  const [picked, setPicked] = useState<string | null>(null);
  const category = picked ?? (typeCategory(id) as string);
  const preview = useMemo(() => {
    const model = controller.dialogModel(d.id);
    try { return model?.preview ? (model.preview(session.readContext(docId) as Any, d.values) as {w: number; h: number; prims: Any[]} | null) : null; } catch { return null; }
  }, [controller, session, docId, d.id, d.values]);
  const pick = (type: string) => setValue('type', labelOfWord(wordType(type)!));
  return <div className="chc" data-field-id="type" data-dialog-page="All Charts">
    <ul className="chc-cats" role="listbox" aria-label="Chart category">
      {categories.map(c => <li key={c}><button type="button" role="option" aria-selected={c === category} className={c === category ? 'is-on' : ''} title={c} aria-label={c}
        onClick={() => { setPicked(c); if (typeCategory(id) !== c) pick(inCategory(c)[0]); }}><ChartSvg chart={thumb(inCategory(c)[0])} label="" className="chc-cat-art"/><span>{c}</span></button></li>)}
    </ul>
    <div className="chc-main">
      <div className="chc-types" role="listbox" aria-label="Chart type">
        {inCategory(category).map(t => <button key={t} type="button" role="option" aria-selected={t === id} className={t === id ? 'is-on' : ''}
          title={labelOfWord(wordType(t)!) ?? ''} aria-label={labelOfWord(wordType(t)!) ?? ''} onClick={() => pick(t)}
          onDoubleClick={() => { pick(t); void controller.submitDialog(d.key).catch(() => {}); }}><ChartSvg chart={thumb(t)} label=""/></button>)}
      </div>
      <div className="chc-preview" data-field-id="preview">
        {preview && preview.prims.length ? <PrimSvg prims={preview.prims} w={preview.w} h={preview.h} label={`Preview of ${label}`}/> : <div className="sf-list-empty">No preview</div>}
        <div className="chc-name">{label}</div>
      </div>
    </div>
  </div>;
}

export default {Body};
