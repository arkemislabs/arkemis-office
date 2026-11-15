// Developer › Properties › Add… of a drop-down list or combo box: Word's Add Choice dialog (Display Name, Value: the value follows
// the name until it is typed). The values go back to the Content Control Properties list (the dialog is asked for them, it runs no
// command). Modify… opens the same box as Modify Choice (modifyChoice.mjs).
//
// Word's dialog (wordcraft's entries have the same two columns, dialogs_controls.rs `entries`); MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {MAX_CONTROL_TEXT} from '../model/ranges.mjs';

/** The model of an Add Choice / Modify Choice dialog `id` titled `title`. */
export function choiceDialog(id, title) {
  return defineDialog({
    id,
    title,
    init: () => ({display: '', value: '', _typed: false}),
    derive(v, changed) {
      if (changed.includes('value')) return {_typed: true};
      if (changed.includes('display') && !v._typed) return {value: v.display};
      return {};
    },
    validate(v) {
      const errors = [];
      if (!String(v.display ?? '').trim()) errors.push({field: 'display', message: 'Type a display name.'});
      if (String(v.display ?? '').length > MAX_CONTROL_TEXT) errors.push({field: 'display', message: 'The display name is too long.'});
      if (String(v.value ?? '').length > MAX_CONTROL_TEXT) errors.push({field: 'value', message: 'The value is too long.'});
      return errors;
    },
    toCommand: v => ({command: 'developer.control', params: {control: String(v.display)}}),
  });
}

export default choiceDialog('dialog.addChoice', 'Add Choice');
