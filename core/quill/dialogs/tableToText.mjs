// Table Layout › Data › Convert to Text (submit: table.toText).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_layout/table.rs (`TableToTextForm`:
// opens on Tabs, Other: with one character, params) at aadb077e072b7de05f724e359d8db82e151f125c.
// Word's "Convert nested tables" box is not offered: table.toText converts the rows' own text and
// keeps nested tables as they are, as upstream does. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';

export default defineDialog({
  id: 'dialog.tableToText',
  title: 'Convert Table To Text',
  command: 'table.toText',
  init(ctx) {
    T.cell(T.open(ctx));
    return {separator: 'tab', other: '-'};
  },
  derive(v, changed) { return changed.includes('other') && v.separator !== 'other' ? {separator: 'other'} : {}; },
  validate(v) { return v.separator === 'other' && !String(v.other ?? '') ? [{field: 'other', message: 'Type the character that separates the text.'}] : []; },
  toCommand(v) {
    const params = {separator: v.separator};
    if (v.separator === 'other') params.char = String(v.other)[0];
    return {command: 'table.toText', params};
  },
});
