// References › Table of Contents › Update Table: Word's Update Table of Contents dialog (Update page
// numbers only / Update entire table; submit: references.updateToc). The dialog is Word's (office);
// the entire table is wordcraft references.rs `references.updateToc` at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.updateToc',
  title: 'Update Table of Contents',
  command: 'references.updateToc',
  init: () => ({mode: 'pages'}),
  validate: () => [],
  toCommand: v => ({command: 'references.updateToc', params: {pagesOnly: v.mode !== 'entire'}}),
});
