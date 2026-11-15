// Insert Spreadsheet (Insert > Files > Spreadsheet > Existing Spreadsheet): the workbook chosen with the system Open dialog and
// how to put it on the page, over core/slate/dialogs/insert-spreadsheet.mjs. U:slate/rest.

import {Field, grid, type BodyProps} from './shared';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {fileName?: string; fileData?: string | null};
  const error = v.fileData ? null : d.errors.find(e => e.field === 'file')?.message ?? null;
  const pick = async () => {
    const studio = (window as any).studio;
    if (typeof studio?.pickDocument !== 'function') return;
    const f = await studio.pickDocument({all: true});
    if (f?.data) { set('fileName', String(f.name ?? 'Workbook')); set('fileData', String(f.data)); }
  };
  return <div className="gd-fields" data-dialog-page="Insert">
    <div className="sf-field">
      <label className="sf-label" htmlFor="sheet-file">Workbook</label>
      <span className="sf-file">
        <input id="sheet-file" className="sf-text" readOnly value={v.fileName ?? ''} placeholder=".xlsx, .csv or .tsv" aria-invalid={!!error || undefined}/>
        <button type="button" className="sf-button" disabled={d.busy} onClick={() => { void pick(); }}>Browse…</button>
      </span>
      {error ? <div className="sf-error" role="alert">{error}</div> : null}
    </div>
    <div style={grid('minmax(0, 1fr)', {marginTop: 12})}><Field d={d} id="insertAs" set={set}/></div>
  </div>;
}

export default {Body};
