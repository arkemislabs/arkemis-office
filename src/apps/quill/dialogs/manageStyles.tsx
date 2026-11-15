// Manage Styles view (Styles pane › Manage Styles, Edit page): Sort order, the style list (each
// name with its type), the description, Show in the Styles gallery / Hide from style lists, and
// Modify… / New Style… / Delete, over core/quill/dialogs/manageStyles.mjs. Modify… opens Modify
// Style on the picked style. Translated from wordcraft crates/ui-egui/src/dialogs/styles.rs
// `manage_styles` at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {modifyValues} from '../../../../core/quill/dialogs/modifyStyle.mjs';
import {Field, grid, type BodyProps} from './font';

type Info = Record<string, {name: string; type: string; builtIn: boolean; gallery: boolean; hidden: boolean; description: string}>;
const TYPE_MARK: Record<string, string> = {paragraph: '¶', character: 'a', linked: '¶a', table: '▦'};

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller, session, docId} = useEngine();
  const info = (d.values._info ?? {}) as Info;
  const order = (d.values._order ?? {}) as Record<string, string[]>;
  const ids = order[String(d.values.sortOrder ?? 'recommended')] ?? Object.keys(info);
  const picked = typeof d.values.style === 'string' ? d.values.style : null;
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const modify = () => {
    if (!picked) return;
    try {
      const sheet = (session.readContext(docId) as unknown as {doc: {styles: unknown}}).doc.styles;
      controller.openDialog('dialog.modifyStyle', {parent: d.key, init: modifyValues(sheet, picked)});
    } catch (e) { fail(e); }
  };
  return <div className="gd-fields">
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginBottom: 10})}><Field d={d} id="sortOrder" set={set}/><div/></div>
    <div className="sf" data-field-id="style" data-kind="list">
      <span className="sf-label">Select a style to edit:</span>
      <div className="sf-list" role="listbox" aria-label="Styles" tabIndex={0} style={{height: 196}}
        onKeyDown={e => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const i = picked ? ids.indexOf(picked) : -1;
          const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
          if (next) set('style', next);
        }}>
        {ids.map(id => <div key={id} role="option" aria-selected={id === picked} className={`sf-list-item${id === picked ? ' is-selected' : ''}`}
          onClick={() => set('style', id)} onDoubleClick={() => { set('style', id); modify(); }}>
          <span style={{width: 22, flex: 'none', color: '#9fa1a9', fontSize: 11}}>{TYPE_MARK[info[id]?.type] ?? ''}</span>
          <span>{info[id]?.name ?? id}{info[id]?.hidden ? ' (Hide)' : ''}</span>
        </div>)}
      </div>
    </div>
    <div className="sf" data-field-id="description" data-kind="preview" style={{marginTop: 10}}>
      <span className="sf-label">Preview:</span>
      <p style={{margin: 0, minHeight: 48, padding: '8px 10px', borderRadius: 9, background: 'rgba(0,0,0,.2)', color: '#e8e8ec', fontSize: 12, whiteSpace: 'pre-wrap'}}>
        {picked ? info[picked]?.description ?? '' : ''}</p>
    </div>
    <div style={grid('repeat(2, max-content)', {gap: '6px 22px', margin: '10px 0'})}><Field d={d} id="showInGallery" set={set}/><Field d={d} id="hide" set={set}/></div>
    <div className="gd-buttons" style={{display: 'flex', gap: 8}}>
      <button type="button" className="sf-button" data-field-id="modifyButton" disabled={!picked} onClick={modify}>Modify…</button>
      <button type="button" className="sf-button" data-field-id="newStyleButton" onClick={() => { try { controller.openDialog('dialog.newStyle', {parent: d.key}); } catch (e) { fail(e); } }}>New Style…</button>
      <button type="button" className="sf-button" data-field-id="deleteButton" disabled={!picked || !!info[picked ?? '']?.builtIn}
        onClick={() => { void controller.pressField(d.key, 'deleteButton').catch(fail); }}>Delete</button>
    </div>
  </div>;
}

export default {Body};
