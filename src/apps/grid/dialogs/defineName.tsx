// New Name / Edit Name as Excel draws it: Name, Scope (Workbook or a sheet; fixed while editing,
// as Excel keeps a name's scope), Comment (several lines), Refers to.
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:712 (`defineName`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import './insertFunction.css';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const editing = typeof d.values.oldName === 'string' && d.values.oldName !== '';
  const scopes = (Array.isArray(d.values.scopes) ? d.values.scopes : ['Workbook']) as string[];
  const err = (f: string) => d.errors.find(e => e.field === f)?.message ?? null;
  const text = (id: string, label: string, extra: Record<string, unknown> = {}) => <div className={`sf${err(id) ? ' has-error' : ''}`} data-field-id={id} data-kind="text">
    <label className="sf-label" htmlFor={`grid-dn-${id}`}>{label}</label>
    <div className="sf-control">
      <input id={`grid-dn-${id}`} className="sf-text" type="text" spellCheck={false} value={String(d.values[id] ?? '')} {...extra}
        onChange={e => setValue(id, e.target.value)}/>
    </div>
    {err(id) ? <small className="sf-error" role="alert">{err(id)}</small> : null}
  </div>;
  return <div className="gd-fields grid-dn">
    {editing ? <div className="grid-dn-title">Edit Name</div> : null}
    {text('name', 'Name:', {'data-autofocus': true})}
    <div className="sf" data-field-id="scope" data-kind="select">
      <label className="sf-label" htmlFor="grid-dn-scope">Scope:</label>
      <div className="sf-control"><span className="sf-select">
        <select id="grid-dn-scope" disabled={editing} value={String(d.values.scope ?? 'Workbook')} onChange={e => setValue('scope', e.target.value)}>
          {scopes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </span></div>
    </div>
    <div className="sf" data-field-id="comment" data-kind="text">
      <label className="sf-label" htmlFor="grid-dn-comment">Comment:</label>
      <div className="sf-control">
        <textarea id="grid-dn-comment" className="sf-textarea" rows={4} maxLength={255} value={String(d.values.comment ?? '')} onChange={e => setValue('comment', e.target.value)}/>
      </div>
    </div>
    {text('refersTo', 'Refers to:')}
  </div>;
}

export default {Body};
