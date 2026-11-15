// Macros view (Developer › Code › Macros): the macro name box over the list of macros kept (how many steps each
// holds), Delete beside them, over core/quill/dialogs/macros.mjs. With none it says to record one.

import {Field, grid, type BodyProps} from './font';

function Body({dialog: d, setValue: set}: BodyProps) {
  const macros = ((d.values.macros as [string, number][]) ?? []).map(([n, steps]) => ({value: n, label: `${n} (${steps} step${steps === 1 ? '' : 's'})`}));
  return <div className="gd-fields">
    <div style={grid('minmax(0, 1fr) 110px', {alignItems: 'start'})}>
      <div><Field d={d} id="name" set={set}/><div style={{marginTop: 6}}><Field d={d} id="list" set={set} options={macros}/></div></div>
      <div style={{display: 'grid', gap: 8, marginTop: 22}}><Field d={d} id="delete" set={set}/></div>
    </div>
    {macros.length ? null : <p className="sf sf-static" style={{marginTop: 8, opacity: 0.7}}>No macros yet: turn on Record Macro, edit the document, and turn it off.</p>}
  </div>;
}

export default {Body};
