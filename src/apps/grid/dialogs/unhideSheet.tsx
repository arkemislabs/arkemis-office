// Unhide as Excel lays it out: "Unhide sheet:" lists the hidden sheets; a double-click unhides
// one at once. Over core/grid/dialogs/unhideSheet.mjs. Translated from gridcraft
// crates/ui-egui/src/dialogs.rs:406 at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const items = (Array.isArray(d.values.hiddenSheets) ? d.values.hiddenSheets : []) as string[];
  const picked = typeof d.values.sheet === 'string' ? d.values.sheet : null;
  return <div className="gd-fields">
    <div className="sf" data-field-id="sheet" data-kind="list">
      <span className="sf-label">Unhide sheet:</span>
      <div className="sf-control">
        <div className="sf-list" role="listbox" tabIndex={0} data-autofocus style={{height: 150, overflowY: 'auto'}}>
          {items.map((x, i) => <div key={i} role="option" aria-selected={x === picked} className={`sf-list-item${x === picked ? ' is-selected' : ''}`}
            onClick={() => setValue('sheet', x)}
            onDoubleClick={() => { setValue('sheet', x); void controller.submitDialog(d.key).catch(e => controller.notify(toCommandError(e).message, 'error')); }}>{x}</div>)}
        </div>
      </div>
    </div>
  </div>;
}

export default {Body};
