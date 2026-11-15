// Grid Options (Align › Grid Settings…, View › Show › Grid Settings): the grid spacing, whether
// objects snap to the grid and to other objects, and whether the grid and the drawing guides are
// drawn. With no parameters the Grid Options dialog opens; with any, they are applied.
// Translated from deckcraft crates/ui-egui/src/app/commands.rs (`view.gridOptions`, `grid_flag`) and
// dialogs/grid_options.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {bad, hasDoc, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {pointerPrefs} from '../lib/pointer.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/ui-egui/src/app/commands.rs', 'crates/ui-egui/src/dialogs/grid_options.rs']};
const KEYS = ['spacing', 'snap', 'smartGuides', 'gridlines', 'guides'];

/** The options as the dialog and the command report them. */
export function gridOptions(ctx) {
  const pr = pointerPrefs(ctx.prefs);
  return {spacing: pr.gridSpacing, snap: pr.snapToGrid, smartGuides: pr.smartGuides, gridlines: !!ctx.view?.gridlines, guides: !!ctx.view?.guides};
}

export default defineCommands({
  family: 'view_grid',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [{
    id: 'view.gridOptions', label: 'Grid Options…', risk: 'edit', dialog: 'dialog.gridOptions',
    description: '{spacing?: pt (1 to 288), snap?: bool, smartGuides?: bool, gridlines?: bool, guides?: bool} → the options; with none of them the Grid Options dialog opens',
    params: s.object({spacing: s.optional(s.any()), snap: s.optional(s.any()), smartGuides: s.optional(s.any()), gridlines: s.optional(s.any()), guides: s.optional(s.any())}),
    state: ctx => (hasDoc(ctx).enabled ? {enabled: true} : hasDoc(ctx)),
    async run(ctx, p) {
      if (!isSchema2(ctx.doc)) throw bad('view.gridOptions', 'needs a presentation (schema 2)');
      const touched = KEYS.some(k => p[k] !== undefined);
      if (!touched) return gridOptions(ctx);
      let spacing;
      if (p.spacing !== undefined) {
        if (typeof p.spacing !== 'number' || !Number.isFinite(p.spacing)) throw bad('view.gridOptions', '`spacing` must be a finite number of points');
        if (p.spacing < 1 || p.spacing > 288) throw bad('view.gridOptions', '`spacing` must be from 1 to 288 points');
        spacing = p.spacing;
      }
      const flag = k => {
        if (p[k] === undefined) return undefined;
        if (typeof p[k] !== 'boolean') throw bad('view.gridOptions', `\`${k}\` must be true or false`);
        return p[k];
      };
      const snap = flag('snap'), smart = flag('smartGuides'), gridlines = flag('gridlines'), guides = flag('guides');
      const prefs = {};
      if (spacing !== undefined) prefs.gridSpacing = spacing;
      if (snap !== undefined) prefs.snapToGrid = snap;
      if (smart !== undefined) prefs.smartGuides = smart;
      if (Object.keys(prefs).length) ctx.updatePrefs({prism: {...(ctx.prefs?.prism ?? {}), ...prefs}});
      const view = {};
      if (gridlines !== undefined) view.gridlines = gridlines;
      if (guides !== undefined) view.guides = guides;
      if (Object.keys(view).length) ctx.setView(view);
      // As View › Guides: a presentation without guides gets the two centre guides.
      if (guides && !(ctx.doc.guides ?? []).length && typeof ctx.run === 'function') { try { await ctx.run('guide.add', {defaults: true}); } catch { /* shown without the defaults */ } }
      const pr = pointerPrefs({prism: {...(ctx.prefs?.prism ?? {}), ...prefs}});
      return {spacing: pr.gridSpacing, snap: pr.snapToGrid, smartGuides: pr.smartGuides, gridlines: gridlines ?? !!ctx.view?.gridlines, guides: guides ?? !!ctx.view?.guides};
    },
  }],
});
