// The Selection pane (Layout, Picture Format and Shape Format › Arrange › Selection Pane): every picture, shape, text box and
// group of the body by name, the selected ones marked. A click selects one, Shift+click adds or takes one out of the
// selection, the eye hides or shows it, Show All and Hide All do it for every object.
//
// Translated from wordcraft crates/engine/src/cmd/objects/select.rs (`objects_list`, the `arrange.selectionPane` list) at
// aadb077e072b7de05f724e359d8db82e151f125c; the eye is Word's (object.hide). MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';

type Row = {index: number; kind: string; name: string; hidden: boolean; selected: boolean};

export default function SelectionPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const st = session.state(docId, 'arrange.objects') as {enabled: boolean; value?: Row[]};
  const rows = st.enabled ? st.value ?? [] : [];
  const run = (id: string, params: Record<string, unknown>) => controller.run(id, params, {origin: 'bridge-ui'}).catch(e => controller.notify(toCommandError(e).message, 'error'));
  return <div className="quill-selection-pane" style={{display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5}}>
    <div style={{display: 'flex', gap: 6}}>
      <button type="button" className="sf-button" disabled={!rows.some(r => r.hidden)} onClick={async () => { for (const r of rows) if (r.hidden) await run('object.hide', {index: r.index, value: false}); }}>Show All</button>
      <button type="button" className="sf-button" disabled={!rows.some(r => !r.hidden)} onClick={async () => { for (const r of rows) if (!r.hidden) await run('object.hide', {index: r.index, value: true}); }}>Hide All</button>
    </div>
    {!rows.length ? <small style={{color: '#b9bac1'}}>There are no pictures or shapes in the document.</small> : null}
    <div role="listbox" aria-label="Objects" aria-multiselectable="true" style={{display: 'flex', flexDirection: 'column'}}>
      {rows.map(r => <div key={r.index} role="option" aria-selected={r.selected} data-object-index={r.index} className={`sf-list-item${r.selected ? ' is-selected' : ''}`}
        style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, cursor: 'default', opacity: r.hidden ? 0.55 : 1}}
        onClick={e => void run(e.shiftKey || e.ctrlKey || e.metaKey ? 'select.addObject' : 'select.objects', {index: r.index})}>
        <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{r.name}</span>
        <button type="button" className="sf-button" aria-label={`${r.hidden ? 'Show' : 'Hide'} ${r.name}`} aria-pressed={r.hidden}
          onClick={e => { e.stopPropagation(); void run('object.hide', {index: r.index}); }}>{r.hidden ? 'Show' : 'Hide'}</button>
      </div>)}
    </div>
  </div>;
}
