// The Watch Window (Formulas > Formula Auditing > Watch Window): the cells being watched, one row each with Book, Sheet, Name, Cell, Value and
// Formula, and the Add Watch and Delete Watch buttons. A click on a row picks it, a double click selects the cell. Behaviour from gridcraft's `watch_window`
// (cmd/extra/window.rs, panes.rs: Add Watch for the active cell, a delete button for each watch) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. The list is read from formulas.watchList after every change of the workbook.

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './watch.css';

type Row = {cell: string; sheet: string; name: string; address: string; value: string; formula: string};

export default function WatchPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [rows, setRows] = useState<Row[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [book, setBook] = useState('');
  useEffect(() => {
    let live = true;
    Promise.resolve(session.execute(docId, 'formulas.watchList', {}, {origin: 'ui'})).then((r: any) => { if (live) setRows(Array.isArray(r?.result?.watches) ? r.result.watches : []); }).catch(() => {});
    try { const t = (session.get(docId) as any)?.title ?? (session.get(docId) as any)?.file?.name ?? ''; if (live) setBook(String(t)); } catch { /* none */ }
    return () => { live = false; };
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, p: Record<string, unknown> = {}) => controller.run(id, p, {origin: 'ui'}).catch(fail);
  return <div className="wt" data-watch-window>
    <div className="wt-bar">
      <button type="button" className="sf-button" onClick={() => { try { controller.openDialog('dialog.addWatch'); } catch (e) { fail(e); } }}>Add Watch{'…'}</button>
      <button type="button" className="sf-button" disabled={!picked} onClick={() => { if (picked) void run('formulas.watchWindow', {remove: picked, on: true}).then(() => setPicked(null)); }}>Delete Watch</button>
    </div>
    <div className="wt-table" role="grid" aria-label="Watched cells">
      <div className="wt-row wt-head" role="row"><span>Book</span><span>Sheet</span><span>Name</span><span>Cell</span><span>Value</span><span>Formula</span></div>
      {rows.length ? rows.map(r => <div key={r.cell} role="row" aria-selected={picked === r.cell} data-watch={r.cell} className={`wt-row${picked === r.cell ? ' is-picked' : ''}`}
        onClick={() => setPicked(r.cell)} onDoubleClick={() => void run('selection.set', {range: r.address, sheet: r.sheet})}>
        <span title={book}>{book}</span><span>{r.sheet}</span><span>{r.name}</span><span>{r.address}</span><span>{r.value}</span><span title={r.formula}>{r.formula}</span>
      </div>) : <div className="wt-empty">No cells are being watched. Choose Add Watch to watch a cell.</div>}
    </div>
  </div>;
}
