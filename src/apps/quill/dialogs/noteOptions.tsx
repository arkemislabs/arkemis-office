// Footnote and Endnote view (References › Footnotes launcher): Location (Footnotes / Endnotes with
// their position, Convert…), Format (Number format, Custom mark, Start at, Numbering), Apply changes
// (Apply changes to, Apply); Insert is the dialog's OK. Over core/quill/dialogs/noteOptions.mjs.
// Layout from wordcraft crates/ui-egui/src/dialogs/dialogs_notes.rs (`note_options`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import {Field, Group, grid, type BodyProps} from './font';

/** One of the Location radio buttons, drawn as the shell's radio fields are. */
function Radio({name, on, pick}: {name: string; on: boolean; pick: () => void}) {
  return <div className="sf sf-radio" data-field-id="kind" data-kind="radio">
    <div className="sf-radio-options" role="radiogroup" aria-label="Location">
      <label><input type="radio" name="note-kind" checked={on} onChange={pick}/><span className="sf-radio-dot" aria-hidden="true"/><span>{name}</span></label>
    </div>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {kind?: string};
  const [convert, setConvert] = useState(false);
  const endnote = v.kind === 'endnote';
  const numbering = [{value: 'continuous', label: 'Continuous'}, {value: 'eachSect', label: 'Restart each section'},
    ...(endnote ? [] : [{value: 'eachPage', label: 'Restart each page'}])];
  return <div className="gd-fields" data-dialog-page="Footnote and Endnote">
    <Group title="Location">
      <div style={grid('120px minmax(0, 1fr)', {alignItems: 'center'})}>
        <Radio name="Footnotes:" on={!endnote} pick={() => set('kind', 'footnote')}/>
        <Field d={d} id="footnotePos" set={set} style={{opacity: endnote ? 0.5 : 1, pointerEvents: endnote ? 'none' : undefined}}/>
        <Radio name="Endnotes:" on={endnote} pick={() => set('kind', 'endnote')}/>
        <Field d={d} id="endnotePos" set={set} style={{opacity: endnote ? 1 : 0.5, pointerEvents: endnote ? undefined : 'none'}}/>
      </div>
      <div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 8}}>
        <button type="button" className="sf-button" aria-expanded={convert} data-field-id="convert" onClick={() => setConvert(c => !c)}>Convert…</button>
      </div>
      {convert ? <div role="group" aria-label="Convert Notes" style={{display: 'grid', gap: 6, marginTop: 6}}>
        <Field d={d} id="convertEndnote" set={set}/><Field d={d} id="convertFootnote" set={set}/><Field d={d} id="convertSwap" set={set}/>
      </div> : null}
    </Group>
    <Group title="Format">
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
        <Field d={d} id="numFmt" set={set}/>
        <Field d={d} id="customMark" set={set}/>
        <Field d={d} id="startAt" set={set}/>
        <Field d={d} id="numbering" set={set} options={numbering}/>
      </div>
    </Group>
    <Group title="Apply changes">
      <div style={grid('minmax(0, 1fr) auto')}>
        <Field d={d} id="applyTo" set={set}/>
        <Field d={d} id="applyChanges" set={set}/>
      </div>
    </Group>
  </div>;
}

export default {Body};
