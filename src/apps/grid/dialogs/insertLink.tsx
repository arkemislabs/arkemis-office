// Insert Hyperlink as Excel draws it: the three places a link can go on the left (Existing File or
// Web Page, Place in This Document, E-mail Address), the text to show and the ScreenTip, and the
// page for the chosen kind; Remove Link is the dialog's own button.
// Excel's Insert Hyperlink on gridcraft's link dialog (crates/ui-egui/src/dialogs.rs, `insertLink`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, type SetValue} from './dataKit';

const KINDS: [string, string][] = [['web', 'Existing File or Web Page'], ['place', 'Place in This Document'], ['email', 'E-mail Address']];

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const kind = String(d.values.linkTo ?? 'web');
  const places = (d.values.places ?? {sheets: [], names: []}) as {sheets: string[]; names: string[]};
  const text = String(d.values.text ?? '');
  return <div className="gd-fields insert-link">
    <div className="insert-link-kinds" role="radiogroup" aria-label="Link to" data-field-id="linkTo">
      <span className="sf-label">Link to:</span>
      {KINDS.map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={kind === id} className={`insert-link-kind${kind === id ? ' is-on' : ''}`}
        onClick={() => setValue('linkTo', id)}>{label}</button>)}
    </div>
    <Fld d={d} set={setValue} id="text" kind="text" label="Text to display:"/>
    <Fld d={d} set={setValue} id="tooltip" kind="text" label="ScreenTip:"/>
    {kind === 'place' ? <>
      <Fld d={d} set={setValue} id="cellReference" kind="text" label="Type the cell reference:"/>
      <div className="sf" data-field-id="place" data-kind="list">
        <span className="sf-label">Or select a place in this document:</span>
        <div className="sf-control">
          <div className="sf-list" role="listbox" aria-label="Places in this document" tabIndex={0} style={{height: 130, overflowY: 'auto'}}>
            {places.sheets.map(n => <div key={`s:${n}`} role="option" aria-selected={d.values.place === n} className={`sf-list-item${d.values.place === n ? ' is-selected' : ''}`}
              onClick={() => { setValue('place', n); }}>{n}</div>)}
            {places.names.length ? <div className="sf-list-header">Defined Names</div> : null}
            {places.names.map(n => <div key={`n:${n}`} role="option" aria-selected={false} className="sf-list-item"
              onClick={() => { setValue('linkTo', 'web'); setValue('target', `#${n}`); }}>{n}</div>)}
          </div>
        </div>
      </div>
    </> : kind === 'email' ? <>
      <Fld d={d} set={setValue} id="target" kind="text" label="E-mail address:"/>
      <Fld d={d} set={setValue} id="emailSubject" kind="text" label="Subject:"/>
    </> : <Fld d={d} set={setValue} id="target" kind="text" label="Address:"/>}
    {text === '' && kind === 'web' ? <small className="sf-note">An empty cell shows the address.</small> : null}
  </div>;
}

export default {Body};
