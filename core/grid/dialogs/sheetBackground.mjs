// Sheet Background (Page Layout > Background; submit: pageLayout.background): the picture to put behind the sheet, or, when the
// sheet has one, Delete Background (Excel's button reads Delete Background then, and removes it). gridcraft's background takes a
// picture or clear (crates/engine/src/cmd/extra/cells.rs) at fb1e59f. The body (src/apps/grid/dialogs/sheetBackground.tsx) is the Insert
// Picture body. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: exists (the sheet has a background: OK deletes it), name, data (base64), mime, alt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';

const hasBackground = ctx => (ctx.doc.sheets[gridSel(ctx).sheet]?.images ?? []).some(i => i.alt === 'Sheet background');

export default defineDialog({
  id: 'dialog.sheetBackground',
  title: 'Sheet Background',
  command: 'pageLayout.background',
  init: ctx => ({exists: hasBackground(ctx), name: '', data: '', mime: '', alt: ''}),
  validate: v => (v.exists || v.data ? [] : [{field: 'path', message: 'Choose a PNG or JPEG picture.'}]),
  toCommand: v => (v.exists ? {command: 'pageLayout.background', params: {clear: true}} : {command: 'pageLayout.background', params: {base64: v.data, mime: v.mime || undefined}}),
});
