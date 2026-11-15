// Merge Styles dialog model (submit: home.mergeStyles). "Merge styles from:" lists the other workbooks the application holds
// (src/apps/grid/dialogs/mergeStyles.tsx asks the host for them). Not in gridcraft (not checked against upstream).
// Values: from (a document id), replace.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.mergeStyles',
  title: 'Merge Styles',
  command: 'home.mergeStyles',
  init: () => ({from: null, replace: false}),
  validate: v => (v.from ? [] : [{field: 'from', message: 'Choose a workbook to merge styles from.'}]),
  toCommand: v => ({command: 'home.mergeStyles', params: {from: String(v.from), replace: v.replace === true}}),
});
