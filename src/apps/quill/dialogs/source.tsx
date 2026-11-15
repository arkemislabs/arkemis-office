// Create Source / Edit Source view (References › Insert Citation › Add New Source…, Source Manager ›
// New… / Edit…): Type of Source, the bibliography fields that type has (every field with Show All
// Bibliography Fields), and the Tag name (made from author and year when empty; fixed while editing),
// over core/quill/dialogs/source.mjs. Layout from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/
// sources.rs (`source_ui`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, grid, type BodyProps} from './font';
import {sourceFields} from '../../../../core/quill/dialogs/source.mjs';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as Record<string, unknown>;
  const fields = sourceFields(String(v.kind ?? 'book'), !!v.showAll) as [string, string][];
  const row = (id: string, label: string, hint = '', readOnly = false) => <div key={id} style={grid('150px minmax(0, 1fr)', {alignItems: 'center', marginBottom: 6})} data-field-id={id}>
    <label htmlFor={`src-${id}`} style={{fontSize: 12.5}}>{label}</label>
    <input id={`src-${id}`} className="sf-text" value={String(v[id] ?? '')} placeholder={hint} readOnly={readOnly} onChange={e => set(id, e.target.value)}/>
  </div>;
  return <div className="gd-fields" data-dialog-page="Source">
    <div style={grid('150px minmax(0, 1fr)', {alignItems: 'center', marginBottom: 10})}>
      <span style={{fontSize: 12.5}}>Type of Source</span>
      <Field d={d} id="kind" set={set}/>
    </div>
    <div style={{fontSize: 12, fontWeight: 600, margin: '4px 0 8px'}}>Bibliography Fields for {v.edit ? 'the source' : 'a new source'}</div>
    {fields.map(([id, label]) => row(id, label, id === 'author' ? 'Last, First; Last, First' : ''))}
    <div style={{marginTop: 10}}><Field d={d} id="showAll" set={set}/></div>
    {row('tag', 'Tag name', 'Made from the author and year', !!v.edit)}
  </div>;
}

export default {Body};
