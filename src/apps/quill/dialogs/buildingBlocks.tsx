// Building Blocks Organizer view (Insert › Quick Parts): Word's box. A table of the building blocks (Name, Gallery, Category,
// Template) that sorts by a column heading, the preview of the selected block on the right with its name and description under it,
// and the buttons Edit Properties… (Modify Building Block, the fields of Create New Building Block), Delete and Insert (OK), over
// core/quill/dialogs/buildingBlocks.mjs. With none it says how to make one.

import {useEffect} from 'react';
import {type BodyProps} from './font';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {COLUMNS, orderRows} from '../../../../core/quill/dialogs/buildingBlocks.mjs';
import {LOCATIONS} from '../../../../core/quill/dialogs/newBuildingBlock.mjs';
import './buildingBlocks.css';

type Row = {name: string; gallery: string; category: string; description: string; where: string; template: string; text: string};

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const v = d.values as {blocks?: Row[]; name?: string; sort?: string; desc?: boolean};
  const sort = String(v.sort ?? 'name');
  const desc = !!v.desc;
  const rows: Row[] = orderRows(v.blocks, sort, desc);
  const selected = rows.find(r => r.name === v.name) ?? null;
  // A block deleted from under the selection: the first one is selected.
  useEffect(() => { if (!selected && rows.length) { set('name', rows[0].name); set('list', rows[0].name); } }, [selected, rows.length]);  // eslint-disable-line react-hooks/exhaustive-deps
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const heading = (key: string) => { if (key === sort) set('desc', !desc); else { set('sort', key); set('desc', false); } };
  const edit = () => {
    if (!selected) return;
    try {
      controller.openDialog('dialog.modifyBuildingBlock', {parent: d.key, init: {
        name: selected.name, gallery: selected.gallery, category: selected.category, description: selected.description,
        location: selected.where === 'Document' ? LOCATIONS[1] : LOCATIONS[0], _name: selected.name, _from: selected.where === 'Document' ? 'document' : 'settings', _gallery: selected.gallery,
      }});
    } catch (e) { fail(e); }
  };
  return <div className="gd-fields bb-organizer" data-dialog-page="Building Blocks">
    <div className="bb-main">
      <div className="bb-left">
        <div className="sf-label">Click a building block to see its preview</div>
        <div className="bb-table" role="grid" aria-label="Building blocks" data-field-id="list">
          <div className="bb-head" role="row">
            {COLUMNS.map(([key, label]) => <button key={key} type="button" role="columnheader" className="bb-th" data-sort={key} aria-sort={key === sort ? (desc ? 'descending' : 'ascending') : 'none'} onClick={() => heading(key)}>
              <span>{label}</span>{key === sort ? <span className="bb-arrow" aria-hidden="true">{desc ? '▼' : '▲'}</span> : null}
            </button>)}
          </div>
          <div className="bb-body">
            {rows.map(r => <div key={`${r.gallery}:${r.name}`} role="row" className={`bb-row${r === selected ? ' is-selected' : ''}`} aria-selected={r === selected} data-block={r.name}
              onClick={() => { set('name', r.name); set('list', r.name); }}>
              <span role="gridcell">{r.name}</span><span role="gridcell">{r.gallery}</span><span role="gridcell">{r.category}</span><span role="gridcell">{r.template}</span>
            </div>)}
                      </div>
        </div>
      </div>
      <div className="bb-right">
        <div className={`bb-page${selected ? "" : " is-blank"}`} role="note" aria-label="Preview">
          {selected ? (selected.text || <span className="bb-muted">(empty)</span>) : <span className="bb-muted">No preview available</span>}
        </div>
        {selected ? null : <div className="bb-caption bb-hint">{rows.length ? "Click a building block to preview it." : "None yet. Select content, then Insert › Quick Parts › Save Selection to Quick Part Gallery."}</div>}
        {selected ? <div className="bb-caption"><b>{selected.name}</b><div>{selected.description || <span className="bb-muted">No description</span>}</div></div> : null}
      </div>
    </div>
    <div className="bb-buttons">
      <button type="button" className="sf-button" data-field-id="editProperties" disabled={!selected} onClick={edit}>Edit Properties…</button>
      <button type="button" className="sf-button" data-field-id="delete" disabled={!selected} onClick={() => { void controller.pressField(d.key, 'delete').catch(fail); }}>Delete</button>
    </div>
  </div>;
}

export default {Body};
