// Home › Paragraph › Sort → Sort Text (submit: para.sort).
// Word's Sort Text dialog (office source; wordcraft crates/engine/src/cmd/para.rs `para.sort` sorts
// directly, ascending, numbers first at aadb077e072b7de05f724e359d8db82e151f125c). Sort by and Using
// offer Paragraphs (fields need Options… separators, not translated); Type is Text, Number or Date.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.sortText',
  title: 'Sort Text',
  command: 'para.sort',
  init() {
    return {sortBy: 'paragraphs', type: 'text', using: 'paragraphs', order: 'ascending', header: 'no'};
  },
  validate(v) {
    return ['text', 'number', 'date'].includes(v.type) ? [] : [{field: 'type', message: 'Choose Text, Number or Date.'}];
  },
  toCommand(v) {
    const params = {};
    if (v.order === 'descending') params.descending = true;
    if (v.type && v.type !== 'text') params.type = v.type;
    if (v.header === 'yes') params.header = true;
    return {command: 'para.sort', params};
  },
});
