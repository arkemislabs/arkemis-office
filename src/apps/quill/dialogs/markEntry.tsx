// Mark Index Entry view (References › Index › Mark Entry, Alt+Shift+X): Index (Main entry, Subentry),
// Options (Cross-reference with its text, Current page, Page range with its bookmark), Page number
// format (Bold, Italic) and Mark All; Mark is the dialog's OK. Over core/quill/dialogs/markEntry.mjs.
// Layout from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/index.rs (`mark_entry_ui`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, type BodyProps} from './font';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {option?: string; bookmarks?: string[]};
  const marks = (v.bookmarks ?? []).map(b => ({value: b, label: b}));
  return <div className="gd-fields" data-dialog-page="Mark Index Entry">
    <Group title="Index">
      <Field d={d} id="entry" set={set}/>
      <div style={{marginTop: 6}}><Field d={d} id="subentry" set={set}/></div>
    </Group>
    <Group title="Options">
      <div style={grid('150px minmax(0, 1fr)', {alignItems: 'start'})}>
        <Field d={d} id="option" set={set}/>
        <div style={{display: 'grid', gap: 6}}>
          <Field d={d} id="crossReference" set={set} style={{opacity: v.option === 'see' ? 1 : 0.5}}/>
          <div style={{height: 24}}/>
          <Field d={d} id="bookmark" set={set} options={marks} style={{opacity: v.option === 'range' ? 1 : 0.5}}/>
        </div>
      </div>
    </Group>
    <Group title="Page number format">
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr) auto', {alignItems: 'center'})}>
        <Field d={d} id="bold" set={set}/><Field d={d} id="italic" set={set}/><Field d={d} id="markAll" set={set}/>
      </div>
    </Group>
  </div>;
}

export default {Body};
