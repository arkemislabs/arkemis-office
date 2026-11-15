// AutoCorrect's replacement list as deckcraft draws it (crates/ui-egui/src/dialogs/body.rs, the
// AutoCorrect dialog's list at 1320, f893f6af7d36a5409fd804e81a34fd895cfefedf): one row per entry,
// Replace and With side by side, Delete on each row (text.autocorrect {remove}). MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import type {FieldProps} from '../../../shell/fields';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';

function Entries({field, value, onChange}: FieldProps) {
  const {session, docId, controller} = useEngine();
  const list = (Array.isArray(value) ? value : []) as [string, string][];
  const remove = (from: string) => {
    Promise.resolve(session.execute(docId, 'text.autocorrect', {remove: from}, {origin: 'dialog'}))
      .then((r: any) => onChange(r?.result?.entries ?? list.filter(e => e[0] !== from)))
      .catch((e: unknown) => controller.notify(toCommandError(e).message, 'error'));
  };
  return <div className="sf" data-field-id={field.id} data-kind="list">
    <span className="sf-label">{field.label}</span>
    <div className="sf-control">
      <div className="sf-list" role="listbox" tabIndex={0} style={{maxHeight: 200, overflowY: 'auto'}}>
        {list.map(([from, to]) => <div key={from} role="option" aria-selected={false} className="sf-list-item"
          style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) auto', gap: 12, alignItems: 'center'}}>
          <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{from}</span>
          <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{to}</span>
          <button type="button" className="gd-button" data-entry={from} onClick={() => remove(from)}>Delete</button>
        </div>)}
      </div>
    </div>
  </div>;
}

export default {fields: {entries: Entries}};
