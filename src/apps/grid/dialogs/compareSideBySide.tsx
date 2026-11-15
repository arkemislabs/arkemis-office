// Compare Side by Side as Excel draws it: "Compare side by side with:" lists the other open windows. Over
// core/grid/dialogs/compareSideBySide.mjs.
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {WindowListBody} from './windowList';

function Body(props: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  return <WindowListBody {...props} field="with" label="Compare side by side with:" empty="No other workbook is open."/>;
}

export default {Body};
