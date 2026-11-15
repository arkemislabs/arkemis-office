// Review > Compare > Previous Change / Next Change and Review > Ink > Hide Ink.
// PowerPoint's own; deckcraft has neither (its Revisions pane lists the changes and a click goes to the slide, and
// ink is shapes), so both are not checked against upstream.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {pending} from '../lib/compare.mjs';
import {bad, selectionOf, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {isSchema2} from '../model/doc.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/review.rs']};

const changes = ctx => (ctx.view?.compare ? pending(ctx.doc, ctx.view.compare) : []);

export default defineCommands({
  family: 'review_view',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'review.goToChange', label: 'Go to Change', risk: 'read', effect: 'view',
      description: 'Previous Change / Next Change (Review > Compare): go to the slide of the previous or next revision still to review (it wraps round); returns {index, change}.',
      params: s.object({dir: s.enum(['next', 'previous'])}),
      state: ctx => (!ctx.view?.compare ? {enabled: false, reason: 'not comparing'} : changes(ctx).length ? {enabled: true} : {enabled: false, reason: 'no revisions left'}),
      run(ctx, p) {
        const list = changes(ctx);
        if (!ctx.view?.compare) throw bad('review.goToChange', 'not comparing');
        if (!list.length) throw bad('review.goToChange', 'no revisions left');
        const last = ctx.doc.slides.length - 1;
        const at = [...new Set(list.map((c, i) => [Math.min(Math.max(c.slide, 0), last), i]).map(x => x[0]))].sort((a, b) => a - b);
        const cur = selectionOf(ctx).slideIndex;
        const to = p.dir === 'next' ? at.find(x => x > cur) ?? at[0] : [...at].reverse().find(x => x < cur) ?? at[at.length - 1];
        ctx.run('slide.go', {index: to});
        return {index: to, change: list.findIndex(c => Math.min(Math.max(c.slide, 0), last) === to)};
      },
    },
    {
      id: 'review.hideInk', label: 'Hide Ink', risk: 'read', effect: 'view',
      description: 'Hide Ink (Review > Ink): the ink drawn on the slides is not shown (it stays in the file); `on: false` shows it again.',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => (isSchema2(ctx.doc) ? {enabled: true, checked: !!ctx.view?.hideInk} : {enabled: false, reason: 'no presentation open'}),
      run(ctx, p) { const on = p.on ?? !ctx.view?.hideInk; ctx.setView({hideInk: on}); return {on}; },
    },
  ],
});
