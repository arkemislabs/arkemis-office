// Protect Sheet dialog model (submit: review.protectSheet, or review.unprotectSheet on a protected sheet).
// Excel's layout over gridcraft's forms (crates/ui-egui/src/dialogs.rs `protectSheet`, `unprotectSheet`): the check box "Protect
// worksheet and contents of locked cells", the password, and one check list "Allow all users of this worksheet to:" (select locked
// and unlocked cells, format cells, columns and rows, insert columns, rows and hyperlinks, delete columns and rows, sort, use
// AutoFilter, use PivotTable and PivotChart, edit objects, edit scenarios). A password is confirmed in the Confirm Password
// dialog (dialog.confirmPassword) before the sheet is protected. On a protected sheet the Review button reads Unprotect Sheet
// and this dialog asks for the password. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: mode ('protect' or 'unprotect'), protectContents, password, the check boxes by their command keys, unprotectPassword.
// A password in a value is never written down: the submit command's `password` is a secret.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {hasPassword} from '../lib/password.mjs';

/** The check list in Excel's order: [key, label, on by default]. Use PivotTable and PivotChart shows only where PivotTables exist. */
export const ALLOWED = Object.freeze([
  ['selectLockedCells', 'Select locked cells', true], ['selectUnlockedCells', 'Select unlocked cells', true],
  ['formatCells', 'Format cells', false], ['formatColumns', 'Format columns', false], ['formatRows', 'Format rows', false],
  ['insertColumns', 'Insert columns', false], ['insertRows', 'Insert rows', false], ['insertHyperlinks', 'Insert hyperlinks', false],
  ['deleteColumns', 'Delete columns', false], ['deleteRows', 'Delete rows', false], ['sort', 'Sort', false], ['autofilter', 'Use AutoFilter', false],
  ['pivotTables', 'Use PivotTable & PivotChart', false], ['objects', 'Edit objects', false], ['scenarios', 'Edit scenarios', false],
]);

export default defineDialog({
  id: 'dialog.protectSheet',
  title: 'Protect Sheet',
  command: 'review.protectSheet',
  init(ctx) {
    const sheet = baseDoc(ctx).sheets[gridSel(ctx).sheet];
    const prot = sheet.protection && sheet.protection.enabled !== false ? sheet.protection : null;
    if (prot) return {mode: 'unprotect', __title: 'Unprotect Sheet', unprotectPassword: '', needsPassword: hasPassword(prot.password)};
    const out = {mode: 'protect', protectContents: true, password: ''};
    for (const [k, , on] of ALLOWED) out[k] = on;
    return out;
  },
  validate: () => [],
  toCommand: v => {
    if (v.mode === 'unprotect') return {command: 'review.unprotectSheet', params: {password: String(v.unprotectPassword ?? '')}};
    // Unchecking the box and choosing OK leaves the sheet unprotected.
    if (v.protectContents === false) return {command: 'review.unprotectSheet', params: {}};
    const params = {};
    for (const [k] of ALLOWED) params[k] = k === 'selectLockedCells' || k === 'selectUnlockedCells' ? v[k] !== false : v[k] === true;
    return {command: 'review.protectSheet', params: {password: String(v.password ?? ''), askConfirm: true, ...params}};
  },
});
