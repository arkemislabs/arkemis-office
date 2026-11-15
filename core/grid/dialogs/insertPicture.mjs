// Insert Picture dialog model (submit: insert.picture).
// Excel's This Device picker and gridcraft's picture dialog (crates/ui-egui/src/dialogs.rs, "Place in
// Cell" or "Place over Cells") at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The placement (cell, overCells) is the opening item's argument. The body (src/apps/grid/dialogs/insertPicture.tsx)
// asks the system Open dialog for the file and keeps its bytes here as `data`.
//
// Values: name (the file's name), data (base64), mime, alt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.insertPicture',
  title: 'Insert Picture',
  command: 'insert.picture',
  init: () => ({name: '', data: '', mime: '', alt: ''}),
  validate: v => (v.data ? [] : [{field: 'path', message: 'Choose a PNG or JPEG picture.'}]),
  toCommand: v => ({command: 'insert.picture', params: {base64: v.data, mime: v.mime || undefined, alt: v.alt || undefined}}),
});
