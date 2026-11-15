// Paste Name as gridcraft and Excel draw it: "Paste name" over the list of names (arrow keys move,
// a double-click pastes), Paste List under it, OK / Cancel.
// Translated from gridcraft crates/ui-egui/src/dialogs/names.rs (`paste_name`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import './insertFunction.css';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const items = (Array.isArray(d.values.items) ? d.values.items : []) as string[];
  const name = String(d.values.name ?? '');
  return <div className="gd-fields">
    <div className="sf" data-field-id="name" data-kind="list">
      <span className="sf-label">Paste name</span>
      <div className="sf-control">
        <div className="sf-list grid-pn-list" role="listbox" tabIndex={0} data-autofocus aria-label="Paste name"
          onKeyDown={e => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const i = items.indexOf(name);
            const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next) setValue('name', next);
          }}>
          {items.length ? items.map(x => <div key={x} role="option" aria-selected={x === name} className={`sf-list-item${x === name ? ' is-selected' : ''}`}
            onClick={() => setValue('name', x)} onDoubleClick={() => { setValue('name', x); void controller.submitDialog(d.key).catch(fail); }}>{x}</div>)
            : <div className="sf-list-empty">No names defined</div>}
        </div>
      </div>
    </div>
  </div>;
}

export default {Body};
