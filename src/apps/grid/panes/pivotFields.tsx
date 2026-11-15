// The PivotTable Fields pane (PivotTable Analyze > Field List): "Choose fields to add to report" with a check box per source field, the
// four areas (Filters, Columns, Rows, Values) as chips you drag between, each with Excel's field menu (Move Up/Down, to Beginning/End,
// to another area, Remove Field, Value Field Settings), Refresh and the report layout.
// Translated from gridcraft crates/ui-egui/src/pivot_pane.rs at fb1e59f (field list, areas, add/remove/move through the pivot.*
// commands), with Excel's search box and drag and drop. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fromKernelSelection} from '../../../../core/grid/model/workbook.mjs';
import {pivotAt, describe} from '../../../../core/grid/lib/pivot.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './pivotFields.css';

type Any = any;
type Area = 'filters' | 'columns' | 'rows' | 'values';
const AREAS: [Area, string][] = [['filters', 'Filters'], ['columns', 'Columns'], ['rows', 'Rows'], ['values', 'Values']];
const LAYOUTS: [string, string][] = [['compact', 'Compact'], ['outline', 'Outline'], ['tabular', 'Tabular']];
const DRAG = 'application/x-arkemis-pivot-field';

const Glyph = ({d}: {d: string}) => <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true" focusable="false"><path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"/></svg>;
const CHEVRON = 'M4.5 6.5L8 10l3.5-3.5';
const TO_AREA: [Area, string][] = [['filters', 'Move to Report Filter'], ['rows', 'Move to Row Labels'], ['columns', 'Move to Column Labels'], ['values', 'Move to Values']];
const REFRESH = 'M13 8a5 5 0 11-1.6-3.7M13 2.5v3h-3';

interface Item { field: string; label: string; area: Area; index: number; valueIndex?: number }

export default function PivotFieldsPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [search, setSearch] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const sel = fromKernelSelection(content, d.selection);
      const hit = pivotAt(content, sel.sheet, sel.active, undefined);
      if (!hit) return null;
      return describe(content, hit[0], content.sheets[hit[0]].pivots[hit[1]]) as Any;
    } catch { return null; }
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, {...params, ...(model ? {pivot: model.name} : {})}, {origin: 'dialog'}).catch(fail);
  if (!model) return <div className="pf"><small className="pf-empty">Select a cell in a PivotTable, or choose Insert &gt; PivotTable.</small></div>;

  const areaItems = (a: Area): Item[] => {
    if (a === 'values') return model.values.map((v: Any, i: number) => ({field: v.field, label: v.name, area: a, index: i, valueIndex: i}));
    const list = a === 'filters' ? model.filters.filter((f: Any) => f.report) : model[a];
    return list.map((f: Any, i: number) => ({field: f.field, label: f.field, area: a, index: i}));
  };
  const fields: Any[] = (model.fields ?? []).filter((f: Any) => f.name.toLowerCase().includes(search.trim().toLowerCase()));
  const toggle = (f: Any, on: boolean) => {
    if (on) void run('pivot.addField', {field: f.name, area: f.numeric ? 'values' : 'rows'});
    else void run('pivot.removeField', {field: f.name});
  };
  const drop = (to: Area, position: number | undefined, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    let p: Any = null;
    try { p = JSON.parse(e.dataTransfer.getData(DRAG)); } catch { /* not ours */ }
    if (!p) return;
    const extra = position === undefined ? {} : {position};
    if (p.from) void run('pivot.moveField', {field: p.field, from: p.from, to, ...extra});
    else void run('pivot.addField', {field: p.field, area: to, ...extra});
  };
  const dragStart = (payload: Record<string, unknown>) => (e: React.DragEvent) => { e.dataTransfer.setData(DRAG, JSON.stringify(payload)); e.dataTransfer.effectAllowed = 'move'; };

  return <div className="pf" data-pivot={model.name}>
    <input className="pf-search" type="search" value={search} placeholder="Search" aria-label="Search fields" onChange={e => setSearch(e.target.value)}/>
    <p className="pf-title">Choose fields to add to report:</p>
    <div className="pf-fields" role="group" aria-label="Fields">
      {fields.map((f: Any) => <div key={f.name} className="sf sf-check pf-field" data-kind="checkbox" data-field={f.name} draggable onDragStart={dragStart({field: f.name})}>
        <label><input type="checkbox" checked={f.areas.length > 0} onChange={e => toggle(f, e.target.checked)}/><span className="sf-check-box" aria-hidden="true"/><span className="pf-name">{f.name}</span></label>
      </div>)}
      {!fields.length ? <small className="pf-empty">No field matches.</small> : null}
    </div>
    <p className="pf-title">Drag fields between areas below:</p>
    <div className="pf-areas">
      {AREAS.map(([a, title]) => <div key={a} className={`pf-area${over === a ? ' is-over' : ''}`} data-area={a} role="group" aria-label={title}
        onDragOver={e => { e.preventDefault(); setOver(a); }} onDragLeave={() => setOver(o => (o === a ? null : o))} onDrop={e => drop(a, undefined, e)}>
        <span className="pf-area-title">{title}</span>
        <div className="pf-chips">
          {areaItems(a).map(it => <div key={`${a}:${it.index}:${it.label}`} className="pf-chip" data-chip={it.label} draggable
            onDragStart={dragStart({field: a === 'values' ? it.label : it.field, from: a})} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.stopPropagation(); drop(a, it.index, e); }}>
            <span className="pf-chip-name" title={it.label}>{it.label}</span>
            <button type="button" className="pf-icon" aria-label={`${it.label} field menu`} aria-haspopup="menu" aria-expanded={menu === `${a}:${it.index}`}
              onClick={() => setMenu(m => (m === `${a}:${it.index}` ? null : `${a}:${it.index}`))}><Glyph d={CHEVRON}/></button>
            {menu === `${a}:${it.index}` ? <FieldMenu area={a} item={it} count={areaItems(a).length} close={() => setMenu(null)} run={run}
              settings={() => { try { controller.openDialog('dialog.valueFieldSettings', {args: {index: it.valueIndex}}); } catch (e) { fail(e); } }}/> : null}
          </div>)}
        </div>
      </div>)}
    </div>
    <div className="pf-foot">
      <button type="button" className="sf-button pf-refresh" aria-label="Refresh" title="Refresh" onClick={() => void run('pivot.refresh')}><Glyph d={REFRESH}/></button>
      <div className="pf-layouts" role="radiogroup" aria-label="Report layout">
        {LAYOUTS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={model.layout === k} className={`sf-button pf-layout${model.layout === k ? ' is-on' : ''}`}
          onClick={() => void run('pivot.reportLayout', {layout: k})}>{label}</button>)}
      </div>
    </div>
  </div>;
}

/** Excel's field menu on an area's chip: moves within the area, to another area, Remove Field and (values) Value Field Settings. */
function FieldMenu({area, item, count, close, run, settings}: {area: Area; item: Item; count: number; close: () => void; run: (id: string, p?: Record<string, unknown>) => Promise<unknown>; settings: () => void}) {
  const field = area === 'values' ? item.label : item.field;
  const go = (f: () => unknown) => () => { close(); void f(); };
  const move = (position: number) => go(() => run('pivot.moveField', {field, from: area, to: area, position}));
  const entries: ([string, (() => void) | null] | null)[] = [
    ['Move Up', item.index > 0 ? move(item.index - 1) : null], ['Move Down', item.index < count - 1 ? move(item.index + 1) : null],
    ['Move to Beginning', item.index > 0 ? move(0) : null], ['Move to End', item.index < count - 1 ? move(count - 1) : null], null,
    ...TO_AREA.map(([to, label]) => [label, to === area ? null : go(() => run('pivot.moveField', {field, from: area, to}))] as [string, (() => void) | null]), null,
    ['Remove Field', go(() => run('pivot.removeField', {field, area}))],
    ...(area === 'values' ? [null, ['Value Field Settings…', go(settings)] as [string, () => void]] : []),
  ];
  return <div className="pf-menu" role="menu" aria-label={`${item.label} field menu`} onKeyDown={e => { if (e.key === 'Escape') close(); }}>
    {entries.map((e, i) => e === null ? <div key={i} className="pf-menu-sep" role="separator"/>
      : <button key={e[0]} type="button" role="menuitem" className="pf-menu-item" disabled={!e[1]} onClick={e[1] ?? undefined}>{e[0]}</button>)}
  </div>;
}
