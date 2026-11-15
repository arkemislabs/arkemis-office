// Table of Figures view (References › Captions › Insert Table of Figures): the Print Preview of two
// captions, Show page numbers, Right align page numbers, Tab leader, Caption label (the document's
// and the person's labels too) and Include label and number, over core/quill/dialogs/tableOfFigures.mjs.
// Layout from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/toc.rs (`figures_ui`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, type BodyProps} from './font';
import {Sample} from './toc';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {label?: string; labels?: string[]; includeLabel?: boolean; pageNumbers?: boolean; rightAlign?: boolean; tabLeader?: string};
  const label = v.label ?? 'Figure';
  const lines: [number, string, string][] = [[1, '1'], [2, '3']].map(([n, page]) => [0, v.includeLabel ? `${label} ${n}: Text` : 'Text', v.pageNumbers ? String(page) : '']);
  const labels = (v.labels ?? ['Equation', 'Figure', 'Table']).map(l => ({value: l, label: l}));
  return <div className="gd-fields" data-dialog-page="Table of Figures">
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'start', columnGap: 24})}>
      <div style={{minWidth: 0, overflow: 'hidden'}}><Sample lines={lines} right={!!v.rightAlign} leader={v.tabLeader ?? 'dot'} width={220}/></div>
      <div>
        <Field d={d} id="pageNumbers" set={set}/>
        <Field d={d} id="rightAlign" set={set}/>
        <div style={{marginTop: 6}}><Field d={d} id="tabLeader" set={set}/></div>
      </div>
    </div>
    <Group title="General">
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
        <Field d={d} id="label" set={set} options={labels}/>
        <Field d={d} id="includeLabel" set={set}/>
      </div>
    </Group>
  </div>;
}

export default {Body};
