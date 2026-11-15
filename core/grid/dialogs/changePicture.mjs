// Change Picture dialog model (submit: picture.change).
// Excel's Change Picture > From a File: the system Open dialog (the app's own picker, `studio.pickImage`) and the picture
// it chose, which takes the selected picture's place. The body is src/apps/grid/dialogs/changePicture.tsx (the Insert
// Picture body). Not in gridcraft. Not checked against upstream.
//
// Values: name, data (base64), mime.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.changePicture',
  title: 'Change Picture',
  command: 'picture.change',
  init: () => ({name: '', data: '', mime: ''}),
  validate: v => (v.data ? [] : [{field: 'path', message: 'Choose a PNG or JPEG picture.'}]),
  toCommand: v => ({command: 'picture.change', params: {base64: v.data, mime: v.mime || undefined}}),
});
