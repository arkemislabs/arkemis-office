// Unhide as Excel draws it: "Unhide workbook:" lists the hidden windows. Over core/grid/dialogs/unhideWindow.mjs.
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {WindowListBody} from './windowList';

function Body(props: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  return <WindowListBody {...props} field="window" label="Unhide workbook:" empty="No workbook is hidden."/>;
}

export default {Body};
