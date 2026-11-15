// Sort Text view (Home › Paragraph › Sort): Word's Sort by / Type / Using row with Ascending and
// Descending beside it, and My list has Header row / No header row, over core/quill/dialogs/sortText.mjs.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, type BodyProps} from './font';

function Body({dialog: d, setValue: set}: BodyProps) {
  return <div className="gd-fields">
    <Group title="Sort by">
      <div style={grid('minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)')}>
        <Field d={d} id="sortBy" set={set}/><Field d={d} id="type" set={set}/><Field d={d} id="using" set={set}/>
      </div>
      <div style={{marginTop: 10}}><Field d={d} id="order" set={set}/></div>
    </Group>
    <Field d={d} id="header" set={set}/>
  </div>;
}

export default {Body};
