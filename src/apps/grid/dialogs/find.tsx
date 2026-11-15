// Find and Replace's results list, as gridcraft draws it under the buttons after Find All:
// "<n> cell(s) found", then one row per match (Sheet  Cell  Value); clicking a row goes to that
// cell (the sheet first), and the dialog stays open.
// Translated from gridcraft crates/ui-egui/src/dialogs/find.rs (`find`: the `results` list, its
// selectable rows running sheet.activate + selection.set) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Here the click runs edit.goTo with the match's canonical address, which does both in one step.

import type {FieldProps} from '../../../shell/fields';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';

type Hit = {sheet: string; cell: string; value: string; address: string};

function Results({field, value}: FieldProps) {
  const {session, docId, controller} = useEngine();
  const list = (Array.isArray(value) ? value : []) as Hit[];
  const go = (h: Hit) => {
    Promise.resolve(session.execute(docId, 'edit.goTo', {reference: h.address}, {origin: 'ui'}))
      .catch((e: unknown) => controller.notify(toCommandError(e).message, 'error'));
  };
  return <div className="sf" data-field-id={field.id} data-kind="list">
    <span className="sf-label">{list.length ? `${list.length} cell(s) found` : 'Find All lists the matches here'}</span>
    <div className="sf-control">
      <div className="sf-list" role="listbox" tabIndex={0} style={{maxHeight: 180, overflowY: 'auto'}}>
        {list.length ? list.map((h, i) => <div key={i} role="option" aria-selected={false} className="sf-list-item"
          style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) 64px minmax(0, 2fr)', gap: 12}}
          onClick={() => go(h)} title={`${h.sheet}!${h.cell}`}>
          <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{h.sheet}</span>
          <span>{h.cell}</span>
          <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{h.value}</span>
        </div>) : <div className="sf-list-empty">No matches listed</div>}
      </div>
    </div>
  </div>;
}

export default {fields: {results: Results}};
