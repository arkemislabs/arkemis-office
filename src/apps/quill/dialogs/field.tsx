// Field view (Insert › Quick Parts › Field…): Categories and Field names on the left, the field's
// description, options and the field code on the right, Preserve formatting below, over
// core/quill/dialogs/field.mjs (wordcraft dialogs_insert/field.rs `field_ui`).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, type BodyProps} from './font';
import {FIELDS, DATE_FORMATS, fieldKind} from '../../../../core/quill/dialogs/field.mjs';

// List heights are whole rows (24 px each plus the 3 px padding) so no row is cut in half.
const NAMES_H = {height: 3 + 8 * 24 + 3};
const FORMATS_H = {height: 3 + 6 * 24 + 3};

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {categories?: string; names?: string; description?: string};
  const names = (FIELDS as [string, string, string][]).filter(([, cat]) => v.categories === '(All)' || cat === v.categories).map(([n]) => ({value: n, label: n}));
  const kind = fieldKind(v.names ?? '');
  return <div className="gd-fields" style={grid('220px minmax(0, 1fr)', {alignItems: 'start'})}>
    <Group title="Please choose a field">
      <Field d={d} id="categories" set={set}/>
      <div style={{marginTop: 8}}><Field d={d} id="names" set={set} options={names} patch={NAMES_H}/></div>
    </Group>
    <div>
      <Group title="Field properties">
        <p className="sf-static" style={{margin: '0 0 8px'}}>{v.description}</p>
        {kind === 'date' ? <Field d={d} id="dateFormat" set={set} options={(DATE_FORMATS as string[]).map(f => ({value: f, label: f}))} patch={FORMATS_H}/> : null}
        {kind === 'number' || kind === 'sequence' ? <Field d={d} id="numberFormat" set={set}/> : null}
        {['bookmark', 'sequence', 'merge', 'style'].includes(kind) ? <Field d={d} id="target" set={set}/> : null}
      </Group>
      <Field d={d} id="codes" set={set}/>
      <div style={{marginTop: 8}}><Field d={d} id="preserve" set={set}/></div>
    </div>
  </div>;
}

export default {Body};
