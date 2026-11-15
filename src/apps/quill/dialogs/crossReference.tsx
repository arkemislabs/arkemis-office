// Cross-reference view (References › Captions › Cross-reference): Reference type, Insert reference
// to (what the type offers), Insert as hyperlink, and For which heading / bookmark / caption (the
// targets of the type), over core/quill/dialogs/crossReference.mjs. Layout from wordcraft
// crates/ui-egui/src/dialogs/dialogs_refs/cross_ref.rs (`cross_ref_ui`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, grid, type BodyProps} from './font';
import {showOptions} from '../../../../core/quill/dialogs/crossReference.mjs';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {to?: string; types?: [string, string][]; targets?: Record<string, string[]>};
  const to = v.to ?? 'heading';
  const types = (v.types ?? []).map(([value, label]) => ({value, label}));
  const shows = (showOptions(to) as [string, string][]).map(([value, label]) => ({value, label}));
  const targets = (v.targets?.[to] ?? []).map(t => ({value: t, label: t}));
  const which = types.find(t => t.value === to)?.label.toLowerCase() ?? 'item';
  return <div className="gd-fields" data-dialog-page="Cross-reference">
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
      <Field d={d} id="to" set={set} options={types}/>
      <Field d={d} id="show" set={set} options={shows}/>
    </div>
    <div style={{margin: '8px 0'}}><Field d={d} id="hyperlink" set={set}/></div>
    <div className="sf-label" style={{marginBottom: 4}}>For which {which}:</div>
    <Field d={d} id="target" set={set} options={targets}/>
  </div>;
}

export default {Body};
