// Paste Special dialog model (submit: edit.pasteSpecial).
// Translated from gridcraft crates/ui-egui/src/dialogs/paste.rs (`paste_special`: Paste and
// Operation radio groups, Skip blanks, Transpose, Paste Link pastes at once) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {PASTE_WHAT, OPERATIONS} from '../commands/edit/clipboard.mjs';

const params = v => ({
  what: v.what ?? 'all',
  operation: v.operation ?? 'none',
  ...(v.skipBlanks ? {skipBlanks: true} : {}),
  ...(v.transpose ? {transpose: true} : {}),
});

export default defineDialog({
  id: 'dialog.pasteSpecial',
  title: 'Paste Special',
  command: 'edit.pasteSpecial',
  init: () => ({what: 'all', operation: 'none', skipBlanks: false, transpose: false}),
  validate(v) {
    const out = [];
    if (!PASTE_WHAT.includes(v.what ?? 'all')) out.push({field: 'what', message: 'Choose what to paste'});
    if (!OPERATIONS.includes(v.operation ?? 'none')) out.push({field: 'operation', message: 'Choose an operation'});
    return out;
  },
  buttons: {
    // Excel's Paste Link pastes references to the copied cells straight away.
    'Paste Link': (_ctx, v) => ({command: 'edit.pasteSpecial', params: {...params(v), what: 'all', operation: 'none', link: true}}),
  },
  toCommand: v => ({command: 'edit.pasteSpecial', params: params(v)}),
});
