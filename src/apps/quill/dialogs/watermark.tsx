// Printed Watermark view (Design › Watermark › Custom Watermark…): No watermark, Picture watermark (Select Picture… through the system
// Open dialog, Scale, Washout) and Text watermark (Text, Font, Color, Semitransparent, Layout), over core/quill/dialogs/watermark.mjs.
// The picture chosen travels in the dialog's values as a data URI until OK.

import {Field, grid, type BodyProps} from './font';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const kind = String(d.values.kind ?? 'none');
  const pick = async () => {
    try {
      const url = await window.studio.pickImage?.();
      if (!url) return;
      set('image', url);
      set('imageName', 'Selected picture');
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  const fade = (on: boolean) => ({opacity: on ? 1 : 0.5, pointerEvents: on ? undefined : 'none'}) as const;
  return <div className="gd-fields" data-dialog-page="Printed Watermark">
    <Field d={d} id="kind" set={set}/>
    <div style={{display: 'grid', gap: 10, margin: '12px 0', paddingLeft: 26, ...fade(kind === 'picture')}}>
      <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
        <button type="button" className="sf-button" data-field-id="selectPicture" onClick={() => { void pick(); }}>Select Picture…</button>
        <span className="rl-weak" data-field-id="imageName">{String(d.values.imageName || '')}</span>
      </div>
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'end'})}>
        <Field d={d} id="scale" set={set}/>
        <Field d={d} id="washout" set={set}/>
      </div>
    </div>
    <div style={{paddingLeft: 26, ...fade(kind === 'text')}}>
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
        <Field d={d} id="text" set={set}/>
        <Field d={d} id="font" set={set}/>
        <Field d={d} id="color" set={set}/>
        <Field d={d} id="semitransparent" set={set}/>
      </div>
      <div style={{marginTop: 10}}><Field d={d} id="layout" set={set}/></div>
    </div>
  </div>;
}

export default {Body};
