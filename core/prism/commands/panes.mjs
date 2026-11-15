// The side panes the Design and Review tabs open: Format Background, Design Ideas, Comments,
// Revisions (Compare), Thesaurus and Spelling. The command asks, the surface opens or closes the pane;
// `view.panes.<id>` mirrors whether it is open (as animation.pane does for the Animation Pane).
// deckcraft: crates/ui-egui/src/panels.rs (the `view.pane` ids background, designer, comments,
// revisions) and panels/thesaurus.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {bad, UPSTREAM_COMMIT} from '../lib/text-session.mjs';

export const PANES = Object.freeze(['background', 'designer', 'comments', 'revisions', 'thesaurus', 'smartart', 'selection', 'format', 'spelling']);
/** The Format Shape pane's tabs (panels/format_shape.rs): the ribbon's More Options… links open it on one of them. */
export const FORMAT_TABS = Object.freeze(['fill', 'effects', 'size', 'text', 'picture']);

export default defineCommands({
  family: 'panes',
  app: 'prism',
  upstream: {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/ui-egui/src/panels.rs']},
  commands: [
    {
      id: 'pane.toggle', label: 'Pane', risk: 'read', effect: 'view',
      description: 'Show or hide a side pane: background (Format Background), designer (Design Ideas), comments, revisions (Compare), thesaurus, smartart (the SmartArt Text Pane), selection (the Selection Pane) or format (Format Shape; `tab`: fill|effects|size|text|picture opens it on that tab). Without `on` it toggles; `mirror` is the surface reporting a pane the person closed or opened itself.',
      params: s.object({pane: s.enum(PANES), on: s.optional(s.boolean()), tab: s.optional(s.enum(FORMAT_TABS)), mirror: s.optional(s.boolean())}),
      state: (ctx, p) => (!isSchema2(ctx.doc) ? {enabled: false, reason: 'no presentation open'} : {enabled: true, checked: !!(p?.pane && ctx.view?.panes?.[p.pane])}),
      run(ctx, p) {
        if (!isSchema2(ctx.doc)) throw bad('pane.toggle', 'needs a presentation (schema 2)');
        // A tab asked for on a pane already open shows that tab and keeps the pane open (More Options… must not close it).
        const on = p.on ?? (p.tab && ctx.view?.panes?.[p.pane] ? true : !ctx.view?.panes?.[p.pane]);
        ctx.setView({panes: {...(ctx.view?.panes ?? {}), [p.pane]: on}, ...(p.tab && p.pane === 'format' ? {formatTab: p.tab} : {}),
          ...(p.mirror ? {} : {paneRequest: {pane: p.pane, on, n: (ctx.view?.paneRequest?.n ?? 0) + 1}})});
        return {pane: p.pane, on, ...(p.tab ? {tab: p.tab} : {})};
      },
    },
  ],
});
