// Date and Time view (Insert › Text › Date & Time): Available formats (today in each picture),
// Language, Update automatically, over core/quill/dialogs/dateTime.mjs.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, grid, type BodyProps} from './font';

function Body({dialog: d, setValue: set}: BodyProps) {
  const opts = (d.values as {formatOptions?: {value: string; label: string}[]}).formatOptions ?? [];
  return <div className="gd-fields" style={grid('minmax(0, 1fr) 200px', {alignItems: 'start'})}>
    <Field d={d} id="formats" set={set} options={opts}/>
    <div><Field d={d} id="language" set={set}/></div>
    <Field d={d} id="updateAuto" set={set}/>
  </div>;
}

export default {Body};
