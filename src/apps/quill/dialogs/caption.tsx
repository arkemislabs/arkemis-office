// Caption view (References › Captions › Insert Caption): Caption (the label and number shown before
// the text, as Word shows them), Options (Label, Position, Exclude label from caption), New Label… /
// Delete Label, and Numbering… (Format, Include chapter number, Chapter starts with style, Use
// separator, the example), over core/quill/dialogs/caption.mjs. Layout from wordcraft
// crates/ui-egui/src/dialogs/dialogs_refs/caption.rs (`caption_ui`, `numbering_ui`, `new_label_ui`)
// at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import {Field, Group, grid, type BodyProps} from './font';
import {captionPreview, BUILT_IN_LABELS} from '../../../../core/quill/dialogs/caption.mjs';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as Record<string, any>;
  const [numbering, setNumbering] = useState(false);
  const [adding, setAdding] = useState(false);
  const labels = (Array.isArray(v.labels) ? v.labels as string[] : BUILT_IN_LABELS).map(l => ({value: l, label: l}));
  const lead = captionPreview(v);
  return <div className="gd-fields" data-dialog-page="Caption">
    <div className="sf" data-field-id="text">
      <label className="sf-label" htmlFor="cap-text">Caption:</label>
      <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
        <span aria-hidden="true" style={{whiteSpace: 'nowrap', fontSize: 13}}>{lead}</span>
        <input id="cap-text" className="sf-text" style={{flex: 1, minWidth: 0}} value={String(v.text ?? '')}
          placeholder=": caption text" onChange={e => set('text', e.target.value)}/>
      </div>
    </div>
    <Group title="Options" style={{marginTop: 10}}>
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
        <Field d={d} id="label" set={set} options={labels}/>
        <Field d={d} id="position" set={set}/>
      </div>
      <div style={{marginTop: 8}}><Field d={d} id="excludeLabel" set={set}/></div>
    </Group>
    <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
      <button type="button" className="sf-button" data-field-id="newLabelButton" aria-expanded={adding} onClick={() => setAdding(a => !a)}>New Label…</button>
      <Field d={d} id="deleteLabel" set={set}/>
      <button type="button" className="sf-button" data-field-id="numbering" aria-expanded={numbering} onClick={() => setNumbering(n => !n)}>Numbering…</button>
    </div>
    {adding ? <Group title="New Label" style={{marginTop: 10}}>
      <div style={grid('minmax(0, 1fr) auto')}><Field d={d} id="newLabel" set={set}/><Field d={d} id="addLabel" set={set}/></div>
    </Group> : null}
    {numbering ? <Group title="Caption Numbering" style={{marginTop: 10}}>
      <Field d={d} id="format" set={set}/>
      <div style={{marginTop: 8}}><Field d={d} id="chapter" set={set}/></div>
      {v.chapter ? <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 6})}>
        <Field d={d} id="chapterLevel" set={set}/><Field d={d} id="separator" set={set}/>
      </div> : null}
      <div style={{marginTop: 8, fontSize: 12.5}}>Examples: {lead}</div>
    </Group> : null}
  </div>;
}

export default {Body};
