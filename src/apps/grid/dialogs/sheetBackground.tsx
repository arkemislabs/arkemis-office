// Sheet Background: the Insert Picture body to choose the picture; with a background already on the sheet, a note that OK deletes it
// (Excel's button then reads Delete Background). Over core/grid/dialogs/sheetBackground.mjs.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import insertPicture from './insertPicture';
import type {SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  if (d.values.exists) return <div className="gd-fields"><p className="sf-note" style={{margin: 0}}>This sheet has a background picture. OK deletes it.</p></div>;
  const Picture = insertPicture.Body;
  return <Picture dialog={d} setValue={setValue}/>;
}

export default {Body};
