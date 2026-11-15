// Add Scenario (and Edit Scenario) as Excel draws it: Scenario name, Changing cells, Comment, then
// Scenario Values with a box per changing cell, filled with the cells' current values.
// Excel's dialog over gridcraft's cmd/whatif/scenarios.rs (`scenario_add`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useRef} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {a1} from '../../../../core/grid/lib/addr.mjs';
import {cellList, valueOf} from '../../../../core/grid/lib/data-common.mjs';
import {engineFor} from '../../../../core/grid/model/calc.mjs';
import {fromKernelSelection} from '../../../../core/grid/model/workbook.mjs';
import {display} from '../../../../core/grid/lib/value.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {session, docId} = useEngine();
  const changing = String(d.values.changing ?? '');
  const vals = d.values.vals as string[] | null;
  // The cells the box names, in the order the scenario lists them, with their current values.
  const cells = useMemo(() => {
    try {
      const doc = (session as any).get(docId);
      const content = doc.file.content;
      const active = fromKernelSelection(content, doc.selection).sheet;
      const r = cellList(content, changing, 'data.scenarioAdd', 32, active);
      const engine = engineFor(content);
      return r.cells.map((c: {row: number; col: number}) => ({ref: a1(c.row, c.col), now: (() => { const v = valueOf(engine, r.sheet, c.row, c.col); return v === null || v === undefined ? '' : display(v); })()}));
    } catch { return [] as {ref: string; now: string}[]; }
  }, [session, docId, changing]);
  // Values start as the cells' own and start over when the box names other cells (an edited scenario keeps its own at first).
  const key = cells.map((c: {ref: string}) => c.ref).join(',');
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const fresh = cells.map((c: {now: string}) => c.now);
    const first = prev.current === null;
    prev.current = key;
    if (first && vals && vals.length === fresh.length) return;
    setValue('vals', fresh);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownVals = vals && vals.length === cells.length ? vals : cells.map((c: {now: string}) => c.now);
  return <div className="gd-fields">
    <Fld d={d} set={setValue} id="name" kind="text" label="Scenario name:"/>
    <Fld d={d} set={setValue} id="changing" kind="text" label="Changing cells:"/>
    <Fld d={d} set={setValue} id="comment" kind="text" label="Comment:" multiline/>
    <div className="sf" data-field-id="vals" data-kind="list">
      <span className="sf-label">Scenario Values{cells.length ? ` (${cells.length} cell${cells.length === 1 ? '' : 's'})` : ''}</span>
      <div className="data-values">
        {cells.length ? cells.map((c: {ref: string}, i: number) => <div key={c.ref} style={{display: 'contents'}}>
          <label htmlFor={`sv-${c.ref}`}>{c.ref}:</label>
          <input id={`sv-${c.ref}`} className="sf-text" value={shownVals[i] ?? ''} onChange={e => setValue('vals', shownVals.map((v, k) => (k === i ? e.target.value : v)))}/>
        </div>) : <span className="sf-note">Enter the cells that change.</span>}
      </div>
    </div>
  </div>;
}

export default {Body};
