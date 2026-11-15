// The lists of View > Unhide ("Unhide workbook:") and View Side by Side ("Compare side by side with:"): the open
// windows by title, a double-click answers at once. Over core/grid/dialogs/unhideWindow.mjs and
// compareSideBySide.mjs.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';

export function WindowListBody({dialog: d, setValue, field, label, empty}: {dialog: DialogState; setValue: (field: string, value: unknown) => void; field: 'window' | 'with'; label: string; empty: string}) {
  const {controller} = useEngine();
  const items = (Array.isArray(d.values.windows) ? d.values.windows : []) as {id: number; title: string}[];
  const picked = typeof d.values[field] === 'number' ? (d.values[field] as number) : null;
  return <div className="gd-fields">
    <div className="sf" data-field-id={field} data-kind="list">
      <span className="sf-label">{label}</span>
      <div className="sf-control">
        <div className="sf-list" role="listbox" tabIndex={0} data-autofocus style={{height: 150, overflowY: 'auto'}}>
          {items.map(x => <div key={x.id} role="option" aria-selected={x.id === picked} className={`sf-list-item${x.id === picked ? ' is-selected' : ''}`}
            onClick={() => setValue(field, x.id)}
            onDoubleClick={() => { setValue(field, x.id); void controller.submitDialog(d.key).catch(e => controller.notify(toCommandError(e).message, 'error')); }}>{x.title}</div>)}
          {items.length ? null : <div className="sf-list-empty">{empty}</div>}
        </div>
      </div>
    </div>
  </div>;
}
