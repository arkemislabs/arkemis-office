// Compare Documents view (Review › Compare › Compare… / Combine…): Original document and Revised
// document side by side with Browse…, Label changes with, More >> / << Less with the Comparison
// settings check boxes, Show changes at and Show changes in, over core/quill/dialogs/compare.mjs.
// Layout from wordcraft crates/ui-egui/src/dialogs/dialogs_review.rs `compare_dialog` at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Browse… opens the system Open dialog in the main process (studio:pick-document); only the
// chosen file's bytes come back, and OK passes them to review.compare.

import {useState} from 'react';
import {Field, Group, grid, type BodyProps} from './font';
import {COMPARE_SETTINGS} from '../../../../core/quill/dialogs/compare.mjs';
import {useEngine} from '../../../shell/engine/EngineProvider';

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const v = d.values as Record<string, any>;
  const [more, setMore] = useState(false);
  const on = new Set<string>(Array.isArray(v.settings) ? v.settings : []);
  const toggle = (k: string) => { const next = new Set(on); if (next.has(k)) next.delete(k); else next.add(k); set('settings', COMPARE_SETTINGS.map(([x]) => x).filter(x => next.has(x))); };
  const browse = async () => {
    try {
      const picked = await window.studio.pickDocument?.();
      if (!picked) return;
      set('revisedData', picked.data);
      set('revisedFormat', picked.format);
      set('revised', picked.name);
    } catch (e) { controller.notify(e instanceof Error ? e.message : String(e), 'error'); }
  };
  return <div className="gd-fields" data-dialog-page="Compare">
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'start'})}>
      <Group title="Original document">
        <Field d={d} id="original" set={set}/>
      </Group>
      <Group title="Revised document">
        <div style={{display: 'flex', gap: 6, alignItems: 'end'}}>
          <div style={{flex: 1, minWidth: 0}}><Field d={d} id="revised" set={set}/></div>
          <button type="button" className="sf-button" data-field-id="browse" onClick={browse}>Browse…</button>
        </div>
        <div style={{marginTop: 8}}><Field d={d} id="label" set={set}/></div>
      </Group>
    </div>
    <button type="button" className="sf-button" aria-expanded={more} onClick={() => setMore(m => !m)} style={{alignSelf: 'flex-start', marginBottom: 10}}>
      {more ? '<< Less' : 'More >>'}
    </button>
    {more ? <>
      <Group title="Comparison settings">
        <div role="group" aria-label="Comparison settings" style={grid('minmax(0, 1fr) minmax(0, 1fr)', {gap: '4px 14px'})}>
          {COMPARE_SETTINGS.map(([k, label]) => <label key={k} className="sf-check" data-setting={k}>
            <input type="checkbox" checked={on.has(k)} onChange={() => toggle(k)}/> {label}
          </label>)}
        </div>
      </Group>
      <Group title="Show changes">
        <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'start'})}>
          <Field d={d} id="level" set={set}/>
          <Field d={d} id="showIn" set={set}/>
        </div>
      </Group>
    </> : null}
  </div>;
}

export default {Body};
