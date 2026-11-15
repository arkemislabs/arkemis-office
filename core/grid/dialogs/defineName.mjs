// New Name / Edit Name (Formulas › Define Name, Name Manager › New… / Edit…): Name, Scope,
// Comment, Refers to (the selection by default).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs:712 (`defineName`: defaults from the
// selection, `oldName`/`oldScope` when Name Manager edits a name) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's Scope list (Workbook and each sheet).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {fromKernelSelection, currentArea} from '../model/workbook.mjs';
import {colToLetters, quoteSheet} from '../lib/addr.mjs';
import {validName} from '../lib/formulas-names.mjs';

const abs = c => `$${colToLetters(c.col)}$${c.row + 1}`;
/** `=Sheet1!$A$1:$B$2` of the current selection. */
export function selectionRef(content, selection) {
  const sel = fromKernelSelection(content, selection);
  const r = currentArea(sel);
  const single = r.start.row === r.end.row && r.start.col === r.end.col;
  return `=${quoteSheet(content.sheets[sel.sheet].name)}!${single ? abs(r.start) : `${abs(r.start)}:${abs(r.end)}`}`;
}

export default defineDialog({
  id: 'dialog.defineName',
  title: 'New Name',
  command: 'formulas.defineName',
  init(ctx) {
    return {name: '', scope: 'Workbook', comment: '', refersTo: selectionRef(ctx.doc, ctx.selection), oldName: null, oldScope: null,
      scopes: ['Workbook', ...ctx.doc.sheets.map(s => s.name)]};
  },
  validate(v) {
    const name = String(v.name ?? '').trim();
    if (!name) return [{field: 'name', message: 'Type a name'}];
    if (!validName(name)) return [{field: 'name', message: 'The name that you entered is not valid.'}];
    if (!String(v.refersTo ?? '').replace(/^=/, '').trim()) return [{field: 'refersTo', message: 'Type what the name refers to'}];
    return [];
  },
  toCommand: v => ({command: 'formulas.defineName', params: {
    name: String(v.name).trim(), scope: String(v.scope || 'Workbook'), comment: String(v.comment ?? ''), refersTo: String(v.refersTo),
    ...(v.oldName ? {oldName: String(v.oldName), oldScope: String(v.oldScope || 'Workbook')} : {}),
  }}),
});
