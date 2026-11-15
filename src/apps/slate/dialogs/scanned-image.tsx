// Scanned Image (Insert > Images > Scanned Image): the image of the scan from a file, a preview, and whether to read the text in
// it, over core/slate/dialogs/scanned-image.mjs. U:slate/rest.

import {Field, grid, type BodyProps} from './shared';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {fileName?: string; fileData?: string | null; recognize?: boolean};
  const error = v.fileData ? null : d.errors.find(e => e.field === 'file')?.message ?? null;
  const pick = async () => {
    const studio = (window as any).studio;
    if (typeof studio?.pickImage !== 'function') return;
    const url = await studio.pickImage();
    const data = typeof url === 'string' ? url : url?.dataUrl;
    if (data) { set('fileData', String(data)); set('fileName', 'Scanned image'); }
  };
  return <div className="gd-fields" data-dialog-page="Scan">
    <div className="sf-field">
      <label className="sf-label" htmlFor="scan-file">Image of the scan</label>
      <span className="sf-file">
        <input id="scan-file" className="sf-text" readOnly value={v.fileData ? (v.fileName ?? '') : ''} placeholder="PNG, JPEG, GIF, WebP or BMP" aria-invalid={!!error || undefined}/>
        <button type="button" className="sf-button" disabled={d.busy} onClick={() => { void pick(); }}>Browse…</button>
      </span>
      {error ? <div className="sf-error" role="alert">{error}</div> : null}
    </div>
    {v.fileData ? <div className="slate-scan-preview"><img src={v.fileData} alt="The chosen scan"/></div> : null}
    <div style={grid('minmax(0, 1fr)', {marginTop: 12})}>
      <Field d={d} id="recognize" set={set}/>
      {v.recognize !== false ? <Field d={d} id="insertText" set={set}/> : null}
    </div>
  </div>;
}

export default {Body};
