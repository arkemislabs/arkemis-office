// Formula view (Table Layout › Data › Formula): the formula, Number format, Paste function and Paste
// bookmark (the document's bookmarks), over core/quill/dialogs/tableFormula.mjs (wordcraft
// dialogs_layout/table.rs `formula_ui`). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, grid, type BodyProps} from './font';
import {FORMULA_FUNCTIONS, NUMBER_FORMATS} from '../../../../core/quill/dialogs/tableFormula.mjs';

function Body({dialog: d, setValue: set}: BodyProps) {
  const marks = [{value: '', label: (d.values as {bookmarks?: string[]}).bookmarks?.length ? 'Choose a bookmark' : '(no bookmarks)'}, ...((d.values as {bookmarks?: string[]}).bookmarks ?? []).map(n => ({value: n, label: n}))];
  const formats = [{value: '', label: '(none)'}, ...NUMBER_FORMATS.map(f => ({value: f, label: f}))];
  const functions = [{value: '', label: 'Choose a function'}, ...FORMULA_FUNCTIONS.map(f => ({value: f, label: f}))];
  return <div className="gd-fields">
    <Field d={d} id="formula" set={set}/>
    <div style={{marginTop: 10}}><Field d={d} id="numberFormat" set={set} options={formats}/></div>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 10})}>
      <Field d={d} id="pasteFunction" set={set} options={functions}/>
      <Field d={d} id="pasteBookmark" set={set} options={marks}/>
    </div>
  </div>;
}

export default {Body};
