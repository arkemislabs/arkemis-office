// Scanned Image (Insert > Images > Scanned Image; submit: insert.scannedImage).
// OneNote lists the scanners and cameras the system finds. The app cannot reach one, so the picture
// comes from an image file; the text in it can be read offline and kept with the picture. U:slate/rest.
import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.scanned-image',
  title: 'Insert Picture from Scanner or Camera',
  command: 'insert.scannedImage',
  init: () => ({fileName: '', fileData: null, recognize: true, insertText: false}),
  derive: (v, changed) => (changed.includes('recognize') && !v.recognize ? {insertText: false} : {}),
  validate: v => (v.fileData ? [] : [{field: 'file', message: 'Choose the image of the scan.'}]),
  toCommand: v => ({command: 'insert.scannedImage', params: {data: v.fileData, name: v.fileName || undefined, recognize: v.recognize !== false, insertText: v.recognize !== false && v.insertText === true}}),
});
