// Insert Picture: Browse… asks the system Open dialog for a PNG or JPEG (the app's own file picker,
// `studio.pickImage`), shows what was chosen, and keeps the bytes in the dialog's values for OK.
// Excel's This Device picker; gridcraft's picture dialog (crates/ui-egui/src/dialogs.rs, "Place in
// Cell" / "Place over Cells") at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  const inCell = d.args?.placement === 'cell';
  const data = String(d.values.data ?? '');
  const browse = async () => {
    try {
      const studio = (window as any).studio;
      const url: string | null = typeof studio?.pickImage === 'function' ? await studio.pickImage() : null;
      if (!url) return;
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (!m) throw new Error('Choose a valid PNG or JPEG');
      setValue('mime', m[1]);
      setValue('data', m[2]);
      setValue('name', m[1] === 'image/png' ? 'Picture.png' : 'Picture.jpg');
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  const error = d.errors.find(e => e.field === 'path')?.message ?? null;
  return <div className="gd-fields">
    <p className="sf-note" style={{margin: 0}}>{inCell ? 'The picture fits inside the active cell and moves with it.' : 'The picture floats over the cells; drag it, or its handles, to move and resize it.'}</p>
    <div className="data-row">
      <Btn onClick={() => void browse()} label="Browse for a picture">Browse…</Btn>
      <span className="sf-label" data-field-id="path">{d.values.name ? String(d.values.name) : 'No picture chosen'}</span>
    </div>
    {data ? <div className="insert-picture-preview"><img alt="" src={`data:${String(d.values.mime)};base64,${data}`}/></div> : null}
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
    <Fld d={d} set={setValue} id="alt" kind="text" label="Description (optional):"/>
  </div>;
}

export default {Body};
