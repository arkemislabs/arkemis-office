// Insert Spreadsheet (Insert > Files > Spreadsheet > Existing Spreadsheet; submit: insert.spreadsheet, or insert.fileAttachment).
// OneNote asks whether to attach the workbook or insert it as a spreadsheet on the page; the workbook
// is chosen with the system Open dialog (the dialog body holds its name and bytes). U:slate/rest.
import {defineDialog} from '../../kernel/dialog.mjs';

export const SPREADSHEET_EXTENSIONS = Object.freeze(['xlsx', 'xlsm', 'csv', 'tsv']);

export default defineDialog({
  id: 'dialog.insert-spreadsheet',
  title: 'Insert Spreadsheet',
  command: 'insert.spreadsheet',
  init: () => ({fileName: '', fileData: null, insertAs: 'Insert Spreadsheet'}),
  validate(v) {
    if (!v.fileData) return [{field: 'file', message: 'Choose a workbook to insert.'}];
    const ext = String(v.fileName).split('.').pop().toLowerCase();
    if (v.insertAs !== 'Attach File' && !SPREADSHEET_EXTENSIONS.includes(ext)) return [{field: 'file', message: `A spreadsheet is inserted from a ${SPREADSHEET_EXTENSIONS.map(e => `.${e}`).join(', ')} file. Choose Attach File to attach ${v.fileName}.`}];
    return [];
  },
  toCommand: v => (v.insertAs === 'Attach File'
    ? {command: 'insert.fileAttachment', params: {name: v.fileName, data: v.fileData}}
    : {command: 'insert.spreadsheet', params: {mode: 'existing', name: v.fileName, data: v.fileData}}),
});
