// The Format Chart Area pane (Chart Design > Format Pane, Format > Format Selection): the title, the type, the legend, the
// elements and axis titles, the series colours, the colour palettes and layouts, and the size of the selected chart.
// Translated from gridcraft crates/ui-egui/src/panes.rs `format_chart` at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {selectedObject} from '../../../../core/grid/lib/objects.mjs';
import {resolveChart} from '../../../../core/grid/lib/chart-resolve.mjs';
import {chartKind} from '../../../../core/grid/lib/chart-build.mjs';
import {ALL_CHARTS} from '../../../../core/grid/dialogs/changeChartType.mjs';
import {PALETTES} from '../../../../core/grid/lib/chart-styles.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './formatChart.css';

type Any = any;
const rgbHex = (c: number[]) => `#${c.slice(0, 3).map(x => x.toString(16).padStart(2, '0')).join('')}`;
const LEGENDS: [string, string][] = [['none', 'None'], ['bottom', 'Bottom'], ['top', 'Top'], ['left', 'Left'], ['right', 'Right']];

function Section({title, children, open}: {title: string; children: React.ReactNode; open?: boolean}) {
  return <details className="fc-section" open={open}><summary>{title}</summary><div className="fc-body">{children}</div></details>;
}

function Text({value, placeholder, onCommit}: {value: string; placeholder?: string; onCommit: (v: string) => void}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <input className="fc-input" value={draft ?? value} placeholder={placeholder}
    onChange={e => setDraft(e.target.value)} onBlur={() => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); }}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); } }}/>;
}

export default function FormatChartPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const picked = selectedObject(content, d.selection);
      if (!picked || picked.kind !== 'chart') return null;
      const chart = (content.sheets[picked.si].charts ?? []).find((c: Any) => c.id === picked.id);
      if (!chart) return null;
      let series: Any[] = [];
      try { series = resolveChart(content, picked.si, chart).series; } catch { series = []; }
      return {chart, series};
    } catch { return null; }
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  if (!model) return <div className="fc"><small className="fc-empty">Select a chart to format it.</small></div>;
  const {chart, series} = model;
  const id = chart.id;
  const set = (params: Record<string, unknown>) => run('chart.set', {chart: id, ...params});
  return <div className="fc">
    <Section title="Chart Title" open><Text value={typeof chart.title === 'string' ? chart.title : ''} placeholder="Chart Title" onCommit={v => void set({title: v})}/></Section>
    <Section title="Chart Type">
      <div className="fc-wrap">{ALL_CHARTS.filter(([t]) => t !== 'histogram' && t !== 'waterfall' && t !== 'funnel' && t !== 'combo').map(([t, s, label]) => {
        return <button key={`${t}|${s}`} type="button" className={`sf-button fc-chip${chart.kind === chartKind(t, s) ? ' is-on' : ''}`} onClick={() => void run('chart.changeType', {chart: id, type: t, subtype: s})}>{label}</button>;
      })}</div>
    </Section>
    <Section title="Legend"><div className="fc-wrap">{LEGENDS.map(([v, label]) =>
      <button key={v} type="button" className={`sf-button fc-chip${(chart.legend ?? 'bottom') === v ? ' is-on' : ''}`} onClick={() => void set({legend: v})}>{label}</button>)}</div></Section>
    <Section title="Elements">
      <label className="fc-check"><input type="checkbox" checked={!!chart.dataLabels} onChange={e => void set({dataLabels: e.target.checked})}/> Data Labels</label>
      <label className="fc-check"><input type="checkbox" checked={chart.gridlines !== false} onChange={e => void set({gridlines: e.target.checked})}/> Gridlines</label>
      <label className="fc-field">Horizontal axis title<Text value={chart.xTitle ?? ''} onCommit={v => void set({xTitle: v || null})}/></label>
      <label className="fc-field">Vertical axis title<Text value={chart.yTitle ?? ''} onCommit={v => void set({yTitle: v || null})}/></label>
    </Section>
    <Section title="Series">{series.map((x, i) => <div key={i} className="fc-series">
      <input type="color" className="fc-swatch" aria-label={`Fill of ${x.name}`} value={rgbHex(x.color)} onChange={e => void run('chart.formatSelection', {chart: id, series: i, color: e.target.value})}/>
      <span className="fc-name">{x.name}</span>
      <button type="button" className="sf-button fc-small" onClick={() => void run('chart.formatSelection', {chart: id, series: i, color: null})}>Automatic</button>
    </div>)}</Section>
    <Section title="Colors & Layout">
      <div className="fc-wrap">{PALETTES.map(([p, label]) => <button key={p} type="button" className="sf-button fc-chip" onClick={() => void run('chart.changeColors', {chart: id, palette: p})}>{label}</button>)}</div>
      <div className="fc-wrap">{[1, 2, 3, 4, 5, 6].map(n => <button key={n} type="button" className="sf-button fc-chip" onClick={() => void run('chart.quickLayout', {chart: id, layout: n})}>Layout {n}</button>)}</div>
    </Section>
    <Section title="Size">
      <label className="fc-field">Width<Text value={String(Math.round(chart.anchor?.width ?? 0))} onCommit={v => { const n = Number(v); if (n >= 40) void set({width: n}); }}/></label>
      <label className="fc-field">Height<Text value={String(Math.round(chart.anchor?.height ?? 0))} onCommit={v => { const n = Number(v); if (n >= 40) void set({height: n}); }}/></label>
    </Section>
  </div>;
}
