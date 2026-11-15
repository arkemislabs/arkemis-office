// Index view (References › Index › Insert Index): the Print Preview of an index as the settings make
// it (indented or run-in, right-aligned page numbers with their leader), Type, Columns, Right align
// page numbers, Tab leader, Letter headings and Mark Entry…, over core/quill/dialogs/index.mjs.
// Layout from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/index.rs (`index_ui`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, grid, type BodyProps} from './font';
import {Sample} from './toc';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {type?: string; rightAlign?: boolean; tabLeader?: string; headings?: boolean};
  const sep = (t: string, p: string): [number, string, string] => (v.rightAlign ? [0, t, p] : [0, `${t}, ${p}`, '']);
  const lines: [number, string, string][] = [];
  if (v.headings) lines.push([0, 'A', '']);
  if (v.type === 'runIn') lines.push(v.rightAlign ? [0, 'Atmosphere: Earth', '1'] : [0, 'Atmosphere, 1: Earth, 2', '']);
  else { lines.push(sep('Atmosphere', '1')); lines.push(v.rightAlign ? [1, 'Earth', '2'] : [1, 'Earth, 2', '']); }
  if (v.headings) lines.push([0, 'S', '']);
  lines.push(sep('Saturn', '4'));
  return <div className="gd-fields" data-dialog-page="Index">
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'start'})}>
      <Sample lines={lines} right={!!v.rightAlign} leader={v.tabLeader ?? 'dot'}/>
      <div><Field d={d} id="type" set={set}/><div style={{marginTop: 8}}><Field d={d} id="columns" set={set}/></div></div>
    </div>
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
      <Field d={d} id="rightAlign" set={set}/>
      <Field d={d} id="tabLeader" set={set}/>
    </div>
    <div style={grid('minmax(0, 1fr) auto', {marginTop: 8})}>
      <Field d={d} id="headings" set={set}/>
      <Field d={d} id="markEntry" set={set}/>
    </div>
  </div>;
}

export default {Body};
