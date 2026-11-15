// Tabs dialog view (Paragraph › Tabs…): Word's Tab stop position box over the stop list, Default tab
// stops and Tab stops to be cleared beside it, Alignment and Leader radios, Set / Clear / Clear All.
// The buttons edit the form through core/quill/dialogs/tabs.mjs (`setStop`, `clearStop`,
// `clearAll`); OK sends one para.tabs. Translated from wordcraft
// crates/ui-egui/src/dialogs/dialogs_para.rs `tabs` at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import {Field, grid, type BodyProps} from './font';
import {setStop, clearStop, clearAll, ALIGNS, LEADERS} from '../../../../core/quill/dialogs/tabs.mjs';
import {parseNumber, formatNumber} from '../../../shell/dialogs/dialogState';
import {RadioGroup} from '../../../shell/fields';
import type {SpecField} from '../../../generated/spec-types';

type Stop = {pos: number; align: string; leader: string};
type Form = {stops: Stop[]; cleared: number[]; clearAll: boolean; selected: number | null};

const ALIGN_LABEL: Record<string, string> = {left: 'Left', center: 'Center', right: 'Right', decimal: 'Decimal', bar: 'Bar'};
const LEADER_LABEL: Record<string, string> = {none: '1 None', dot: '2 .......', hyphen: '3 -------', underscore: '4 _______', middleDot: '5 ·······'};
const ALIGN_FIELD = {id: 'align', label: 'Alignment', kind: 'radio', options: ALIGNS.map(a => ({value: a, label: ALIGN_LABEL[a]}))} as unknown as SpecField;
const LEADER_FIELD = {id: 'leader', label: 'Leader', kind: 'radio', options: LEADERS.map(l => ({value: l, label: LEADER_LABEL[l]}))} as unknown as SpecField;
const inches = (pt: number) => formatNumber(Math.round((pt / 72) * 100) / 100, 'in');

function Body({dialog: d, setValue: set}: BodyProps) {
  const form = (d.values.stops ?? {stops: [], cleared: [], clearAll: false, selected: null}) as Form;
  const sel = form.selected !== null ? form.stops[form.selected] : null;
  const [text, setText] = useState<string>(sel ? inches(sel.pos) : '');
  const [align, setAlign] = useState<string>(sel?.align ?? 'left');
  const [leader, setLeader] = useState<string>(sel?.leader ?? 'none');
  const pick = (i: number) => {
    const t = form.stops[i];
    set('stops', {...form, selected: i});
    setText(inches(t.pos)); setAlign(t.align); setLeader(t.leader);
  };
  const typedPt = () => { const v = parseNumber(text, 'in'); return v === null ? null : v * 72; };
  const doSet = () => { const pt = typedPt(); if (pt !== null) set('stops', setStop(form, pt, align, leader)); };
  const doClear = () => {
    const pt = typedPt();
    const i = pt === null ? form.selected ?? -1 : form.stops.findIndex(t => Math.abs(t.pos - pt) < 0.05);
    if (i >= 0) { set('stops', clearStop(form, i)); setText(''); }
  };
  return <div className="gd-fields" data-dialog-page="Tabs">
    <div style={grid('minmax(0, 1.2fr) minmax(0, 1fr)', {alignItems: 'start'})}>
      <div className="sf" data-field-id="stops" data-kind="list">
        <label className="sf-label" htmlFor="tabs-pos">Tab stop position:</label>
        <input id="tabs-pos" className="sf-text" value={text} onChange={e => setText(e.target.value)} aria-label="Tab stop position"
          onKeyDown={e => { if (e.key === 'Enter' && text.trim()) { e.preventDefault(); e.stopPropagation(); doSet(); } }}/>
        <div className="sf-list" role="listbox" aria-label="Tab stops" style={{height: 112}}>
          {form.stops.length ? form.stops.map((t, i) => <div key={i} role="option" aria-selected={form.selected === i}
            className={`sf-list-item${form.selected === i ? ' is-selected' : ''}`} onClick={() => pick(i)}>{inches(t.pos)}</div>)
            : <div className="sf-list-empty">(none)</div>}
        </div>
      </div>
      <div style={{display: 'grid', gap: 12}}>
        <Field d={d} id="defaultTab" set={set}/>
        {form.cleared.length || form.clearAll ? <Field d={d} id="toBeCleared" set={set}/> : null}
      </div>
    </div>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'start', margin: '12px 0'})}>
      <RadioGroup field={ALIGN_FIELD} value={align} onChange={v => setAlign(String(v))}/>
      <RadioGroup field={LEADER_FIELD} value={leader} onChange={v => setLeader(String(v))}/>
    </div>
    <div className="gd-buttons" style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
      <button type="button" className="sf-button" data-field-id="set" disabled={!text.trim()} onClick={doSet}>Set</button>
      <button type="button" className="sf-button" data-field-id="clear" disabled={!form.stops.length} onClick={doClear}>Clear</button>
      <button type="button" className="sf-button" data-field-id="clearAll" disabled={!form.stops.length} onClick={() => { set('stops', clearAll(form)); setText(''); }}>Clear All</button>
    </div>
  </div>;
}

export default {Body};
