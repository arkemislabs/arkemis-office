// Name Manager (Ctrl+F3): every visible name with its value, refers-to, scope and comment;
// New… and Edit… open New Name / Edit Name, Delete removes the selected name, Filter narrows the
// list; Close.
// Translated from gridcraft crates/ui-egui/src/dialogs/names.rs (`name_manager`: the
// formulas.nameManager list, New…/Edit…/Delete over the selected row) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's Filter menu and Refers to box.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {nameManagerList} from '../commands/formulas.mjs';

const isErrorValue = v => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string';

/** Excel's Name Manager filters. */
export function filterNames(list, filter, tableNames = []) {
  switch (filter) {
    case 'Names Scoped to Worksheet': return list.filter(n => n.scope !== 'Workbook');
    case 'Names Scoped to Workbook': return list.filter(n => n.scope === 'Workbook');
    case 'Names with Errors': return list.filter(n => isErrorValue(n.value));
    case 'Names without Errors': return list.filter(n => !isErrorValue(n.value));
    case 'Defined Names': return list.filter(n => !tableNames.includes(n.name));
    case 'Table Names': return list.filter(n => tableNames.includes(n.name));
    default: return list;
  }
}

export default defineDialog({
  id: 'dialog.nameManager',
  title: 'Name Manager',
  command: 'formulas.nameManager',
  init(ctx) {
    const names = nameManagerList(ctx.doc);
    return {names, selected: names[0] ? `${names[0].name}|${names[0].scope}` : null, filter: 'Clear Filter', refersTo: names[0]?.refersTo ?? ''};
  },
  validate: () => [],
  toCommand: () => null,
});
