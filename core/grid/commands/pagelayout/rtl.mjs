// Page Layout > Sheet Right-to-Left: the sheet laid out right to left, column A at the right edge, the row headings on the right, the
// text mirrored with the layout.
// Translated from gridcraft crates/engine/src/cmd/view.rs (`sheet_flag`, the `view.rightToLeft` flag) at fb1e59f: the flag is the sheet
// view's `rightToLeft`, saved with the sheet. MIT, see assets/third-party-licenses/artcraft-reference.txt. The painting is
// src/apps/grid/surface/GridCanvas.tsx (the canvas is mirrored, as gridcraft grid/geo.rs `mirror_painted`).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, gridSel, targetSheet, requireSchema2} from '../../lib/edit-targets.mjs';
import {setIn, deleteIn} from '../../lib/edit-parts.mjs';
import {baseDoc} from '../../lib/data-common.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/view.rs', 'crates/engine/src/cmd/extra/window.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

export default defineCommands({
  family: 'pagelayout/rtl',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'view.rightToLeft', label: 'Sheet Right-to-Left', risk: 'edit',
      description: 'Lay the sheet out right to left: column A at the right edge, the row headings on the right (`on`, default: the other state).',
      params: s.object({sheet: SHEET, on: s.optional(s.boolean())}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: ctx.doc.sheets[gridSel(ctx).sheet]?.rightToLeft === true} : hasDoc(ctx)),
      run(ctx, p) {
        const content = baseDoc(ctx);
        const si = p?.sheet !== undefined ? targetSheet(ctx, p) : gridSel(ctx).sheet;
        requireSchema2(ctx, si);
        const on = typeof p.on === 'boolean' ? p.on : content.sheets[si].rightToLeft !== true;
        if (on) setIn(ctx.change, ['sheets', si, 'rightToLeft'], true); else deleteIn(ctx.change, ['sheets', si, 'rightToLeft']);
        return {on};
      }},
  ],
});
