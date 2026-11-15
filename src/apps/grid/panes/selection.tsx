// The Selection Pane (Page Layout > Selection Pane): the objects of the active sheet from front to back, each with its name (double-click
// renames it) and an eye that shows or hides it, Show All and Hide All, and the arrows that bring an object forward or send it back.
// Excel's pane over core/grid/commands/pagelayout/arrange.mjs (gridcraft's `selection_pane` list; the pane is not checked against
// upstream).

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fromKernelSelection} from '../../../../core/grid/model/workbook.mjs';
import {sheetObjects, selectedObjects} from '../../../../core/grid/lib/objects.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './selection.css';

type Any = any;

const defaultName = (kind: string, o: Any) => (kind === 'chart' ? `Chart ${o.id}` : kind === 'image' ? `Picture ${o.id}` : `${o.kind ?? 'Shape'} ${o.id}`);

export default function SelectionPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const sheet = content.sheets[fromKernelSelection(content, d.selection).sheet];
      const picked = new Set((selectedObjects(content, d.selection) as Any[]).map(o => `${o.kind}:${o.id}`));
      // Front first, as Excel lists them.
      const rows = (sheetObjects(sheet) as Any[]).slice().reverse().filter(o => o.kind !== 'slicer').map(({kind, object}) => ({
        kind, id: object.id as number, name: (object.name as string) || defaultName(kind, object), hidden: object.hidden === true, group: object.group as number | undefined, picked: picked.has(`${kind}:${object.id}`),
      }));
      return {rows};
    } catch { return null; }
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  const pick = (r: {kind: string; id: number}, e: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => run('object.select', {kind: r.kind, id: r.id, ...(e.shiftKey ? {mode: 'add'} : e.ctrlKey || e.metaKey ? {mode: 'toggle'} : {})});
  const commit = (r: {kind: string; id: number}) => { void run('arrange.rename', {kind: r.kind, id: r.id, name: draft}); setEditing(null); };
  const rows = model?.rows ?? [];
  return <div className="gsp" data-pane="selection">
    <div className="gsp-bar">
      <button type="button" className="sf-button gsp-small" disabled={!rows.length} onClick={() => void run('arrange.setVisible', {all: true})}>Show All</button>
      <button type="button" className="sf-button gsp-small" disabled={!rows.length} onClick={() => void run('arrange.setVisible', {all: false})}>Hide All</button>
    </div>
    {!rows.length ? <small className="gsp-empty">There are no charts, pictures or shapes on this sheet.</small> : <ul className="gsp-list" role="listbox" aria-label="Objects on this sheet" aria-multiselectable="true">
      {rows.map(r => {
        const key = `${r.kind}:${r.id}`;
        return <li key={key} role="option" aria-selected={r.picked} className={`gsp-row${r.picked ? ' is-picked' : ''}${r.hidden ? ' is-hidden' : ''}`} data-object={key} onClick={e => void pick(r, e)}>
          {editing === key
            ? <input className="gsp-input" autoFocus value={draft} aria-label="Object name" onChange={e => setDraft(e.target.value)} onClick={e => e.stopPropagation()} onBlur={() => commit(r)}
              onKeyDown={e => { if (e.key === 'Enter') commit(r); else if (e.key === 'Escape') setEditing(null); }}/>
            : <span className="gsp-name" onDoubleClick={() => { setEditing(key); setDraft(r.name); }}>{r.name}{r.group !== undefined ? <small className="gsp-group"> (group)</small> : null}</span>}
          <button type="button" className="gsp-eye" aria-label={r.hidden ? `Show ${r.name}` : `Hide ${r.name}`} aria-pressed={!r.hidden} title={r.hidden ? 'Show' : 'Hide'}
            onClick={e => { e.stopPropagation(); void run('arrange.setVisible', {kind: r.kind, id: r.id}); }}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 12S6 5.5 12 5.5S21.5 12 21.5 12S18 18.5 12 18.5S2.5 12 2.5 12Z"/>
              {r.hidden ? <path d="M4 4L20 20"/> : <path d="M9.5 12A2.5 2.5 0 1 0 14.5 12A2.5 2.5 0 1 0 9.5 12Z"/>}
            </svg>
          </button>
        </li>;
      })}
    </ul>}
    <div className="gsp-bar">
      <button type="button" className="sf-button gsp-small" disabled={!model?.rows.some(r => r.picked)} onClick={() => void run('arrange.bringForward', {})}>Bring Forward</button>
      <button type="button" className="sf-button gsp-small" disabled={!model?.rows.some(r => r.picked)} onClick={() => void run('arrange.sendBackward', {})}>Send Backward</button>
    </div>
  </div>;
}
