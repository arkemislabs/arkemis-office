// From Text/CSV dialog model (Data > Get Data > From Text/CSV; submit: data.fromTextCsv): Excel's import preview, with File Origin shown as detected,
// the Delimiter (detected by default) and Load. Over gridcraft's get_data (cmd/extra/data.rs) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The file is chosen in the dialog body (src/apps/grid/dialogs/fromTextCsv.tsx), which keeps its decoded
// text in the values; Transform Data (the Power Query editor) and Data Type Detection are not built.
//
// Values: name (the file name), text (its decoded text), delimiter ('' detects).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.fromTextCsv',
  title: 'Import Data',
  command: 'data.fromTextCsv',
  init: () => ({name: '', text: '', delimiter: ''}),
  validate: v => (String(v.text ?? '').trim() ? [] : [{field: 'text', message: 'Choose a text or CSV file to import.'}]),
  toCommand: v => ({command: 'data.fromTextCsv', params: {text: String(v.text), name: String(v.name ?? ''), delimiter: String(v.delimiter ?? '')}}),
});
