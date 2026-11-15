// Define New Number Format view (Home › Paragraph › Numbering › Define New Number Format…):
// Number style, Number format, Start at and Word's numbered-list preview, over
// core/quill/dialogs/defineNumber.mjs. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, usePreview, type BodyProps} from './font';
import {ListLines} from './defineBullet';

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) ?? {};
  return <div className="gd-fields">
    <Group title="Number format">
      <div style={grid('minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, .7fr)')}>
        <Field d={d} id="format" set={set}/><Field d={d} id="text" set={set}/><Field d={d} id="start" set={set}/>
      </div>
    </Group>
    <ListLines labels={(Array.isArray(p.labels) ? p.labels : []).map(String)}/>
  </div>;
}

export default {Body};
