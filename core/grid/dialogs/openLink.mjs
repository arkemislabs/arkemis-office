// Open Hyperlink dialog model (submit: link.open).
// gridcraft asks before a link leaves the workbook (crates/ui-egui/src/dialogs.rs, the link warning):
// the address of the active cell's link is shown and OK follows it. Only http, https and mailto
// addresses are ever opened (core/grid/lib/links.mjs). MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Values: url.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';

export default defineDialog({
  id: 'dialog.openLink',
  title: 'Open Hyperlink',
  command: 'link.open',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    const h = content.sheets[sel.sheet].hyperlinks?.[a1(sel.active.row, sel.active.col)];
    return {url: h?.target ?? h?.location ?? ''};
  },
  validate: v => (String(v.url ?? '').trim() ? [] : [{field: 'url', message: 'There is no hyperlink in this cell.'}]),
  toCommand: v => ({command: 'link.open', params: {url: String(v.url).trim()}}),
});
