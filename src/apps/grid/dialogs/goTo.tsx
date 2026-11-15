// Go To as gridcraft and Excel draw it: "Go to:" lists the defined names of every sheet and then
// the references gone to before (newest first); picking one puts it in Reference, double-clicking
// one goes there; Special… opens Go To Special.
// Translated from gridcraft crates/ui-egui/src/dialogs/find.rs (`go_to`, `go_to_entries`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const entries = (Array.isArray(d.values.entries) ? d.values.entries : []) as string[];
  const reference = String(d.values.reference ?? '');
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const error = d.errors.find(e => e.field === 'reference')?.message ?? null;
  return <div className="gd-fields">
    <div className="sf" data-field-id="entries" data-kind="list">
      <span className="sf-label">Go to:</span>
      <div className="sf-control">
        <div className="sf-list" role="listbox" tabIndex={0} style={{height: 170, overflowY: 'auto'}}
          onKeyDown={e => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const i = entries.indexOf(reference);
            const next = entries[Math.max(0, Math.min(entries.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next) setValue('reference', next);
          }}>
          {entries.length ? entries.map((x, i) => <div key={i} role="option" aria-selected={x === reference}
            className={`sf-list-item${x === reference ? ' is-selected' : ''}`}
            onClick={() => setValue('reference', x)}
            onDoubleClick={() => { setValue('reference', x); void controller.submitDialog(d.key).catch(fail); }}>{x}</div>)
            : null}
        </div>
      </div>
    </div>
    <div className={`sf${error ? ' has-error' : ''}`} data-field-id="reference" data-kind="text">
      <label className="sf-label" htmlFor="grid-goto-reference">Reference:</label>
      <div className="sf-control">
        <input id="grid-goto-reference" className="sf-text" type="text" data-autofocus value={reference} spellCheck={false}
          onChange={e => setValue('reference', e.target.value)}/>
      </div>
      {error ? <small className="sf-error" role="alert">{error}</small> : null}
    </div>
    <div className="gd-buttons">
      <button type="button" className="gd-button" onClick={() => { void controller.pressField(d.key, 'special').catch(fail); }}>Special…</button>
    </div>
  </div>;
}

export default {Body};
