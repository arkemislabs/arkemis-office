// Style (New Cell Style) as Excel lays it out: Style name, then "Style Includes (By Example)" with a check box
// per part and the formatting the part holds. Translated from gridcraft cmd/extra/cells.rs (`new_cell_style`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {STYLE_PARTS} from '../../../../core/grid/commands/format/home-extra.mjs';
import {F, type SetValue} from './cfKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const desc = (d.values.descriptions ?? {}) as Record<string, string>;
  return <div className="gd-fields cf-root">
    <F d={d} set={setValue} id="name" kind="text" label="Style name:"/>
    <fieldset className="gd-section">
      <legend>Style Includes (By Example)</legend>
      <div className="cf-style-parts">
        {STYLE_PARTS.map(([id, label]) => <div key={id} className="cf-style-part">
          <F d={d} set={setValue} id={id} kind="checkbox" label={label}/>
          <span className="cf-note" data-field-id={`${id}-description`}>{desc[id] ?? ''}</span>
        </div>)}
      </div>
    </fieldset>
  </div>;
}

export default {Body};
