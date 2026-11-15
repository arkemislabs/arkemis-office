// Page Layout > Page Setup > Background: a picture behind the sheet, and Delete Background.
// Translated from gridcraft crates/engine/src/cmd/extra/cells.rs (`background`) at fb1e59f: the background is a picture named
// "Sheet background" placed at A1 (insert.picture), and clearing removes the pictures with that name; the sheet keeps it like any
// picture, so it goes to .xlsx as a drawing. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, gridSel, targetSheet, requireSchema2} from '../../lib/edit-targets.mjs';
import {baseDoc, bad} from '../../lib/data-common.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/extra/cells.rs']};
export const BACKGROUND_ALT = 'Sheet background';
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

const backgrounds = sheet => (sheet?.images ?? []).filter(i => i.alt === BACKGROUND_ALT);

export default defineCommands({
  family: 'pagelayout/background',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'pageLayout.background', label: 'Background', risk: 'edit', dialog: 'dialog.sheetBackground',
      description: 'Set a picture (PNG or JPEG bytes as base64) as the sheet background, placed at A1 and named "Sheet background"; clear: true deletes it.',
      params: s.object({sheet: SHEET, base64: s.optional(s.string({max: 90_000_000})), dataUrl: s.optional(s.string({max: 90_000_000})), mime: s.optional(s.string({max: 60})), clear: s.optional(s.boolean())}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: backgrounds(ctx.doc.sheets[gridSel(ctx).sheet]).length > 0} : hasDoc(ctx)),
      run(ctx, p) {
        const content = baseDoc(ctx);
        const si = p.sheet !== undefined ? targetSheet(ctx, p) : gridSel(ctx).sheet;
        requireSchema2(ctx, si);
        const sheet = content.sheets[si];
        if (p.clear === true) {
          const rest = (sheet.images ?? []).filter(i => i.alt !== BACKGROUND_ALT);
          if (rest.length !== (sheet.images ?? []).length) ctx.change.set(['sheets', si, 'images'], rest);
          return null;
        }
        if (!p.base64 && !p.dataUrl) throw bad('pageLayout.background', 'give a picture (base64) or clear: true');
        const {sheet: _sheet, clear: _clear, ...picture} = p;
        return ctx.run('insert.picture', {...picture, alt: BACKGROUND_ALT, at: 'A1', sheet: si});
      }},
  ],
});
