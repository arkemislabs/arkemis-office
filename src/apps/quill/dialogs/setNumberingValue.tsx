// Set Numbering Value view (Home › Paragraph › Numbering › Set Numbering Value…): Start new list,
// Set value to and the preview label, over core/quill/dialogs/setNumberingValue.mjs.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, usePreview, type BodyProps} from './font';

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) ?? {};
  const label = Array.isArray(p.labels) ? String(p.labels[0] ?? '') : '';
  return <div className="gd-fields">
    <p className="sf-static" style={{margin: '0 0 10px'}}>Start new list</p>
    <Field d={d} id="value" set={set}/>
    <div className="sf" data-field-id="preview" data-kind="preview" style={{marginTop: 12}}>
      <span className="sf-label">Preview:</span>
      <div role="img" aria-label={`Preview: ${label}`} style={{padding: '8px 12px', borderRadius: 9, background: '#fff', color: '#1b1b1d', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.25)'}}>{label}</div>
    </div>
  </div>;
}

export default {Body};
