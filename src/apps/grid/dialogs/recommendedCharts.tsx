// Insert Chart as Excel draws it: Recommended Charts and All Charts tabs, a drawn thumbnail beside
// each chart type, and a preview of the chart on the selected data (the chart renderer's own
// primitives, so the preview is the chart that gets inserted).
// Excel's Insert Chart on gridcraft's chart dialog (crates/ui-egui/src/dialogs/charts.rs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {Icon} from '../../../shell/icons/Icon';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Tabs, Rows, type SetValue} from './dataKit';
import {CATEGORIES} from '../../../../core/grid/dialogs/recommendedCharts.mjs';
import './recommendedCharts.css';

const ICON: Record<string, string> = {
  'Clustered Column': 'insert-chart-column-clustered', 'Stacked Column': 'insert-chart-column-stacked', '100% Stacked Column': 'insert-chart-column-100',
  'Clustered Bar': 'insert-chart-bar-clustered', 'Stacked Bar': 'insert-chart-bar-stacked', '100% Stacked Bar': 'insert-chart-bar-100',
  Line: 'insert-chart-line', 'Line with Markers': 'insert-chart-line-markers', 'Stacked Line': 'insert-chart-line-stacked',
  Pie: 'insert-chart-pie', 'Pie of Pie': 'insert-chart-pie-of-pie', 'Bar of Pie': 'insert-chart-bar-of-pie', '3-D Pie': 'insert-chart-pie-3d', Doughnut: 'insert-chart-doughnut',
  'Scatter with Smooth Lines and Markers': 'insert-chart-scatter-smooth-markers', 'Scatter with Straight Lines and Markers': 'insert-chart-scatter-straight-markers', '3-D Bubble': 'insert-chart-bubble-3d', Pareto: 'insert-chart-pareto', Area: 'insert-chart-area', 'Stacked Area': 'insert-chart-area-stacked', '100% Stacked Area': 'insert-chart-area-100',
  Scatter: 'insert-chart-scatter', 'Scatter with Lines': 'insert-chart-scatter-lines', Bubble: 'insert-chart-bubble', Radar: 'insert-chart-radar', Histogram: 'insert-chart-histogram',
  Waterfall: 'insert-chart-waterfall', Funnel: 'insert-chart-funnel', Combo: 'insert-chart-combo', Stock: 'insert-chart-stock', Treemap: 'insert-chart-treemap',
  Sunburst: 'insert-chart-sunburst', 'Box & Whisker': 'insert-chart-box-whisker',
};

const rgba = (c: number[]) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;
const stroke = (s: [number[], number] | null) => (s ? {stroke: rgba(s[0]), strokeWidth: s[1]} : {});

/** The chart renderer's primitives as SVG. */
export function PrimSvg({prims, w, h, label}: {prims: any[]; w: number; h: number; label: string}) {
  return <svg className="insert-chart-preview" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={label}>
    {prims.map((p, i) => {
      switch (p.t) {
        case 'rect': return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.radius || undefined} fill={p.fill ? rgba(p.fill) : 'none'} {...stroke(p.stroke)}/>;
        case 'line': return <polyline key={i} points={p.pts.map((q: number[]) => q.join(',')).join(' ')} fill="none" stroke={rgba(p.color)} strokeWidth={p.width} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={p.dash ? '4 3' : undefined}/>;
        case 'poly': return <polygon key={i} points={p.pts.map((q: number[]) => q.join(',')).join(' ')} fill={rgba(p.fill)} {...stroke(p.stroke)}/>;
        case 'wedge': {
          const pt = (r: number, a: number) => `${p.cx + r * Math.sin(a)} ${p.cy - r * Math.cos(a)}`;
          const large = p.a1 - p.a0 > Math.PI ? 1 : 0;
          const d = p.ri > 0 ? `M${pt(p.ro, p.a0)}A${p.ro} ${p.ro} 0 ${large} 1 ${pt(p.ro, p.a1)}L${pt(p.ri, p.a1)}A${p.ri} ${p.ri} 0 ${large} 0 ${pt(p.ri, p.a0)}Z`
            : `M${p.cx} ${p.cy}L${pt(p.ro, p.a0)}A${p.ro} ${p.ro} 0 ${large} 1 ${pt(p.ro, p.a1)}Z`;
          return <path key={i} d={d} fill={rgba(p.fill)} {...stroke(p.stroke)}/>;
        }
        case 'circle': return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill ? rgba(p.fill) : 'none'} {...stroke(p.stroke)}/>;
        case 'text': {
          const anchor = p.align === 'center' ? 'middle' : p.align === 'right' ? 'end' : 'start';
          const base = p.valign === 'middle' ? 'central' : p.valign === 'bottom' ? 'text-after-edge' : 'text-before-edge';
          return <text key={i} x={p.x} y={p.y} fontSize={p.size} fill={rgba(p.color)} textAnchor={anchor} dominantBaseline={base} fontFamily="Segoe UI, Calibri, sans-serif"
            transform={p.rotation ? `rotate(${(p.rotation * 180) / Math.PI} ${p.x} ${p.y})` : undefined}>{p.text}</text>;
        }
        default: return null;
      }
    })}
  </svg>;
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, session, docId} = useEngine();
  const tab = Number(d.values.tab) === 1 ? 1 : 0;
  const setTab = (i: number) => setValue('tab', i);
  const recommended = (Array.isArray(d.values.list) ? d.values.list : []) as string[];
  const key = tab === 0 ? 'recommendations' : 'types';
  const chosen = String(d.values[key] ?? '');
  const catOf = (label: string) => Math.max(0, (CATEGORIES as unknown as [string, string[], string][]).findIndex(c => c[1].includes(label)));
  const [cat, setCat] = useState(catOf(String(d.values.types ?? '')));
  const preview = useMemo(() => {
    const model = controller.dialogModel(d.id);
    try { return model?.preview ? (model.preview(session.readContext(docId) as any, {...d.values, pick: key}) as {w: number; h: number; prims: any[]} | null) : null; } catch { return null; }
  }, [controller, session, docId, d.id, d.values, key]);
  const pick = (label: string) => { setValue('pick', key); setValue(key, label); };
  const error = d.errors.find(e => e.field === 'recommendations')?.message ?? null;
  const categories = CATEGORIES as unknown as [string, string[], string][];
  const about = categories[catOf(chosen)]?.[2] ?? '';
  const previewBox = <div className="insert-chart-side" data-field-id="preview">
    {preview && preview.prims.length ? <PrimSvg prims={preview.prims} w={preview.w} h={preview.h} label={`Preview of ${chosen || 'the chart'}`}/> : <div className="sf-list-empty">No preview</div>}
    <div className="insert-chart-name">{chosen}</div>
    <div className="insert-chart-about">{about}</div>
  </div>;
  return <div className="gd-fields insert-chart rc">
    <Tabs names={['Recommended Charts', 'All Charts']} current={tab} onPick={i => { setTab(i); setValue('pick', i === 0 ? 'recommendations' : 'types'); if (i === 1) setCat(catOf(String(d.values.types ?? ''))); }} label="Chart dialog"/>
    {tab === 0 ? <div className="insert-chart-body" data-field-id="recommendations">
      <Rows label="Recommended charts" id="recommendations" height={250} selected={Math.max(0, recommended.indexOf(chosen))} onPick={i => pick(recommended[i])}
        empty="Select data for the chart first." items={recommended.map(l => <span key={l} className="insert-chart-item"><Icon id={ICON[l] ?? 'chart'} size={24}/><span>{l}</span></span>)}/>
      {previewBox}
    </div> : <div className="rc-all" data-field-id="types">
      <ul className="rc-rail" role="listbox" aria-label="Chart categories">
        {categories.map(([name, labels], i) => <li key={name} role="option" aria-selected={i === cat} className={`rc-cat${i === cat ? ' is-on' : ''}`}
          onClick={() => { setCat(i); if (!labels.includes(chosen)) pick(labels[0]); }}><Icon id={ICON[labels[0]] ?? 'chart'} size={20}/><span>{name}</span></li>)}
      </ul>
      <div className="rc-main">
        <div className="rc-tiles" role="group" aria-label={`${categories[cat][0]} charts`}>
          {categories[cat][1].map(l => <button key={l} type="button" className={`rc-tile${l === chosen ? ' is-on' : ''}`} title={l} aria-label={l} aria-pressed={l === chosen} onClick={() => pick(l)}><Icon id={ICON[l] ?? 'chart'} size={32}/></button>)}
        </div>
        {previewBox}
      </div>
    </div>}
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
