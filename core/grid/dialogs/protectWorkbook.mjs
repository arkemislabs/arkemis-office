// Protect Workbook dialog model (submit: review.protectWorkbook): Protect Structure (Excel 2013 and later protect the structure only), or on a
// protected workbook Unprotect Workbook asking for the password.
// gridcraft's `protectWorkbook` and `unprotectWorkbook` forms (crates/ui-egui/src/dialogs.rs): an optional password
// and the structure (sheets cannot be added, moved, renamed, hidden or deleted); there are no windows to protect
// here. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: mode ('protect' or 'unprotect'), password, structure, unprotectPassword. A password is confirmed in dialog.confirmPassword.

import {defineDialog} from '../../kernel/dialog.mjs';
import {baseDoc} from '../lib/data-common.mjs';

function model(id, title, command) {
  return defineDialog({
    id,
    title,
    command,
    init(ctx) {
      const on = !!baseDoc(ctx).protection?.structure;
      return on ? {mode: 'unprotect', __title: 'Unprotect Workbook', unprotectPassword: ''} : {mode: 'protect', password: '', structure: true};
    },
    validate: v => {
      if (v.mode === 'unprotect') return [];
      if (v.structure === false) return [{field: 'structure', message: 'Choose what to protect.'}];
      return [];
    },
    toCommand: v => ({command, params: {on: v.mode !== 'unprotect', askConfirm: v.mode !== 'unprotect', password: String((v.mode === 'unprotect' ? v.unprotectPassword : v.password) ?? '')}}),
  });
}

export default model('dialog.protectWorkbook', 'Protect Structure', 'review.protectWorkbook');
export const unprotectWorkbook = model('dialog.unprotectWorkbook', 'Unprotect Workbook', 'review.protectWorkbook');
