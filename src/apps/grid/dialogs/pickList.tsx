// Pick From Drop-down List: the column's distinct entries (the model's `items`); a click picks
// one, a double-click enters it at once, as choosing from Excel's list under the cell does.
// Translated from gridcraft crates/ui-egui/src/dialogs/show.rs (the pick list) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const items = (Array.isArray(d.values.items) ? d.values.items : []) as string[];
  const picked = typeof d.values.value === 'string' ? d.values.value : null;
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  return <div className="gd-fields">
    <div className="sf" data-field-id="value" data-kind="list">
      <span className="sf-label">Pick from the column</span>
      <div className="sf-control">
        <div className="sf-list" role="listbox" tabIndex={0} data-autofocus style={{height: 190, overflowY: 'auto'}}
          onKeyDown={e => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const i = picked === null ? -1 : items.indexOf(picked);
            const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next !== undefined) setValue('value', next);
          }}>
          {items.length ? items.map((x, i) => <div key={i} role="option" aria-selected={x === picked}
            className={`sf-list-item${x === picked ? ' is-selected' : ''}`}
            onClick={() => setValue('value', x)}
            onDoubleClick={() => { setValue('value', x); void controller.submitDialog(d.key).catch(fail); }}>{x}</div>)
            : <div className="sf-list-empty">No text entries above or below this cell</div>}
        </div>
      </div>
    </div>
  </div>;
}

export default {Body};
