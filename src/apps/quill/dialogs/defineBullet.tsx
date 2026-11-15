// Define New Bullet view (Home › Paragraph › Bullets › Define New Bullet…): the bullet characters,
// a typed one, and Word's preview of a bulleted list, over core/quill/dialogs/defineBullet.mjs.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, grid, usePreview, type BodyProps} from './font';

/** Word's list preview: three bulleted or numbered lines with grey text bars. */
export function ListLines({labels}: {labels: string[]}) {
  return <div className="sf" data-field-id="preview" data-kind="preview">
    <span className="sf-label">Preview</span>
    <div role="img" aria-label={`Preview: ${labels.join(' ')}`} style={{padding: '14px 18px', borderRadius: 10, background: '#fff', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.25)'}}>
      {labels.map((l, i) => <div key={i} style={{display: 'flex', alignItems: 'center', gap: 10, height: 22}}>
        <span style={{minWidth: 28, color: '#1b1b1d', fontSize: 13, fontFamily: 'Aptos, Segoe UI, sans-serif'}}>{l}</span>
        <i style={{display: 'block', flex: 1, height: 4, borderRadius: 1, background: '#cdcdcd'}}/>
      </div>)}
    </div>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) ?? {};
  const b = String(p.bullet ?? '•');
  return <div className="gd-fields">
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'start'})}>
      <div style={{display: 'grid', gap: 10}}>
        <Field d={d} id="char" set={set}/>
        <Field d={d} id="custom" set={set}/>
      </div>
      <ListLines labels={[b, b, b]}/>
    </div>
  </div>;
}

export default {Body};
